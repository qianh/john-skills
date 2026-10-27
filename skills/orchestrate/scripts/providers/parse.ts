import { addUsage, emptyUsage, ProviderOutputError, unknownUsage, type ProviderName, type ProviderResult, type Usage } from "./types.ts"
import { strictJSON } from "../contracts.ts"

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function usageFrom(fields: {
  input?: unknown
  output?: unknown
  cacheRead?: unknown
  cacheWrite?: unknown
  reasoning?: unknown
  costUsd?: unknown
}): Usage {
  const cost = fields.costUsd
  return {
    input: num(fields.input),
    output: num(fields.output),
    cacheRead: num(fields.cacheRead),
    cacheWrite: num(fields.cacheWrite),
    reasoning: num(fields.reasoning),
    costUsd: num(cost),
  }
}

function envelopeJSON(text: string): unknown {
  try { return strictJSON(text) }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/^JSON 重复键：/.test(message)) {
      const failure = `CLI JSON 无效：${message}`
      throw new ProviderOutputError(failure, { text: "", sessionId: null, model: null, usage: unknownUsage(), models: {}, error: failure })
    }
    throw error
  }
}

function objectsFrom(stdout: string): unknown[] {
  const text = stdout.trim()
  if (!text) return []
  try {
    const parsed = envelopeJSON(text)
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === "object") return [parsed]
  } catch (error) {
    if (error instanceof ProviderOutputError) throw error
    // CLI 日志、JSONL，以及格式化 JSON 后跟错误事件，都要尽量保留。
  }
  const rows: unknown[] = []
  let start = -1, quoted = false, escaped = false
  const stack: string[] = []
  for (let end = 0; end < text.length; end++) {
    const ch = text[end]
    if (start < 0) {
      if (ch === "{" || ch === "[") { start = end; stack.push(ch) }
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === "{" || ch === "[") stack.push(ch)
    else if (ch === "}" || ch === "]") {
      const valid = stack.pop() === (ch === "}" ? "{" : "[")
      if (valid && stack.length) continue
      if (valid) {
        try {
          const parsed = envelopeJSON(text.slice(start, end + 1))
          rows.push(...(Array.isArray(parsed) ? parsed : [parsed]))
        } catch (error) {
          if (error instanceof ProviderOutputError) throw error
          // 跳过非 JSON 的日志片段，重复键不属于可忽略的日志。
        }
      }
      start = -1
      stack.length = 0
      quoted = false
      escaped = false
    }
  }
  // 超时截断或日志里的未闭合括号，不能遮住之后完整的 JSONL 事件。
  if (start >= 0) {
    for (const line of text.slice(start).split("\n")) {
      try { rows.push(envelopeJSON(line)) }
      catch (error) {
        if (error instanceof ProviderOutputError) throw error
        // 不完整的事件没有可采信数据。
      }
    }
  }
  return rows
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function recordsFrom(stdout: string): Record<string, unknown>[] {
  return objectsFrom(stdout).map(asRecord).filter((row): row is Record<string, unknown> => !!row)
}

function totalUsage(rows: Usage[]): Usage {
  if (!rows.length) return { ...emptyUsage(), costUsd: 0 }
  const total = rows.reduce(addUsage, emptyUsage())
  // 部分报价不能充当这次调用的完整价格。
  if (rows.some((row) => row.costUsd == null)) total.costUsd = null
  return total
}

function messageOf(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value
  const record = asRecord(value)
  return typeof record?.message === "string" ? record.message : undefined
}

function finish(result: ProviderResult, error?: string): ProviderResult {
  if (error) {
    result.error = error
    throw new ProviderOutputError(error, result)
  }
  return result
}

function modelUsages(value: unknown, positiveCostOnly = false): Record<string, Usage> {
  const models: Record<string, Usage> = {}
  for (const [name, item] of Object.entries(asRecord(value) ?? {})) {
    const row = asRecord(item) ?? {}
    const cost = num(row.costUSD)
    models[name] = usageFrom({
      input: row.inputTokens,
      output: row.outputTokens,
      cacheRead: row.cacheReadInputTokens,
      cacheWrite: row.cacheCreationInputTokens,
      reasoning: row.thinkingTokens,
      costUsd: positiveCostOnly && cost === 0 ? null : cost,
    })
  }
  return models
}

export function parseClaude(stdout: string): ProviderResult {
  const result = objectsFrom(stdout)
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row?.type === "result")
    .at(-1)
  if (!result) throw new Error("claude 输出里没有 result")
  const raw = asRecord(result.usage) ?? {}
  const details = asRecord(raw.output_tokens_details) ?? {}
  let usage = usageFrom({
    input: raw.input_tokens,
    output: raw.output_tokens,
    cacheRead: raw.cache_read_input_tokens,
    cacheWrite: raw.cache_creation_input_tokens,
    reasoning: details.thinking_tokens,
    costUsd: result.total_cost_usd,
  })
  const models = modelUsages(result.modelUsage)
  const delta = asRecord(result.model_usage_since_last_result)
  if (delta) usage = totalUsage(Object.values(modelUsages(delta)))
  const model = Object.keys(models)[0] ?? null
  const structured = result.structured_output
  const error = result.is_error === true
    ? (messageOf(result.result) ?? (Array.isArray(result.errors) ? result.errors.map(messageOf).filter(Boolean).join("; ") : "")) || "claude 返回 is_error"
    : undefined
  return finish({
    text: typeof result.result === "string" && result.result ? result.result : structured !== undefined ? JSON.stringify(structured) : "",
    sessionId: typeof result.session_id === "string" ? result.session_id : null,
    model,
    usage,
    models,
    costBasis: delta ? "incremental" : "cumulative",
    ...(structured !== undefined ? { structured } : {}),
  }, error)
}

export function parseGrok(stdout: string): ProviderResult {
  const rows = recordsFrom(stdout)
  const error = rows.findLast((row) => row.type === "error" || row.is_error === true || row.stopReason === "error")
  const result = rows.findLast((row) => row.usage || row.modelUsage) ?? rows.at(-1)
  if (!result) throw new Error("grok 输出为空")
  const raw = asRecord(result.usage) ?? {}
  const models = modelUsages(result.modelUsage, true)
  const reportedCost = num(result.total_cost_usd ?? raw.costUSD ?? raw.cost_usd)
  const modelTotal = Object.keys(models).length ? totalUsage(Object.values(models)).costUsd : null
  const usage = usageFrom({
    input: raw.input_tokens,
    output: raw.output_tokens,
    cacheRead: raw.cache_read_input_tokens,
    cacheWrite: raw.cache_creation_input_tokens,
    reasoning: raw.reasoning_tokens,
    // OAuth 回报的 0 不代表免费，但正数报价不能丢掉。
    costUsd: reportedCost != null && reportedCost > 0 ? reportedCost : modelTotal,
  })
  const structured = result.structured_output
  const text = typeof result.text === "string" ? result.text : typeof result.result === "string" ? result.result : structured !== undefined ? JSON.stringify(structured) : ""
  return finish({
    text,
    sessionId: typeof result.sessionId === "string" ? result.sessionId : typeof result.session_id === "string" ? result.session_id : null,
    model: Object.keys(models)[0] ?? null,
    usage,
    models,
    costBasis: "incremental",
    ...(structured !== undefined ? { structured } : {}),
  }, error ? messageOf(error.message) ?? messageOf(error.error) ?? messageOf(error.result) ?? "grok 调用失败" : undefined)
}

export function parsePi(stdout: string): ProviderResult {
  const rows = recordsFrom(stdout)
  const session = rows.find((row) => row.type === "session")
  const messages = rows.filter((row) => row.type === "message_end").map((row) => asRecord(row.message)).filter((row): row is Record<string, unknown> => row?.role === "assistant")
  const message = messages.at(-1)
  if (!message) throw new Error("pi 输出里没有 assistant message_end")
  const parts: Usage[] = []
  const byModel: Record<string, Usage[]> = {}
  for (const item of messages) {
    const raw = asRecord(item.usage) ?? {}
    const cost = asRecord(raw.cost)
    const part = usageFrom({ input: raw.input, output: raw.output, cacheRead: raw.cacheRead, cacheWrite: raw.cacheWrite, reasoning: raw.reasoning, costUsd: cost?.total })
    parts.push(part)
    if (typeof item.model === "string") (byModel[item.model] ??= []).push(part)
  }
  const usage = totalUsage(parts)
  const model = typeof message.model === "string" ? message.model : null
  const content = Array.isArray(message.content) ? message.content : []
  const text = content
    .map((block) => asRecord(block))
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block?.text as string)
    .join("")
  const error = message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length" || typeof message.errorMessage === "string"
    ? messageOf(message.errorMessage) ?? `pi 返回 ${message.stopReason ?? "错误"}` : undefined
  return finish({
    text,
    sessionId: session && typeof session.id === "string" ? session.id : null,
    model,
    usage,
    models: Object.fromEntries(Object.entries(byModel).map(([name, rows]) => [name, totalUsage(rows)])),
    costBasis: "incremental",
  }, error)
}

function unwrapCodex(row: Record<string, unknown>): Record<string, unknown> {
  const msg = asRecord(row.msg)
  if (msg) return unwrapCodex(msg)
  if (row.type === "event_msg" || row.type === "response_item") return asRecord(row.payload) ?? row
  return row
}

export function parseCodex(stdout: string): ProviderResult {
  const rows = recordsFrom(stdout)
  if (!rows.length) throw new Error("codex 输出为空")
  const events = rows.map(unwrapCodex)
  const completed = events.filter((row) => row.type === "turn.completed").map((row) => asRecord(row.usage)).filter((row): row is Record<string, unknown> => !!row)
  const legacy = events.filter((row) => row.type === "token_count").map((row) => asRecord(asRecord(row.info)?.last_token_usage)).filter((row): row is Record<string, unknown> => !!row)
  const parts = (completed.length ? completed : legacy).map((token) => {
    const input = num(token.input_tokens)
    const cacheRead = num(token.cached_input_tokens)
    return usageFrom({
      // Codex 的 input_tokens 包含命中的缓存，账本的新输入不能重复计入。
      input: input == null || cacheRead == null ? null : Math.max(0, input - cacheRead),
      output: token.output_tokens,
      cacheRead,
      cacheWrite: token.cache_write_input_tokens,
      reasoning: token.reasoning_output_tokens,
    })
  })
  const texts: string[] = []
  for (const event of events) {
    if (event.type === "item.completed") {
      const item = asRecord(event.item)
      if (item?.type === "agent_message" && typeof item.text === "string") texts.push(item.text)
    } else if (event.type === "agent_message" && typeof event.message === "string") {
      texts.push(event.message)
    } else if (event.type === "message" && event.role === "assistant" && Array.isArray(event.content)) {
      const text = event.content.map(asRecord).filter((block) => block?.type === "output_text" || block?.type === "text").map((block) => typeof block?.text === "string" ? block.text : "").join("")
      if (text) texts.push(text)
    }
  }
  const started = events.find((row) => row.type === "thread.started")
  const metadata = rows.find((row) => row.type === "session_meta")
  const sessionId = typeof started?.thread_id === "string" ? started.thread_id : typeof asRecord(metadata?.payload)?.id === "string" ? asRecord(metadata?.payload)?.id as string : null
  const error = events.findLast((row) => row.type === "error" || row.type === "turn.failed")
  return finish({
    text: texts.at(-1) ?? "",
    sessionId,
    model: typeof started?.model === "string" ? started.model : null,
    usage: parts.length ? totalUsage(parts) : unknownUsage(),
    models: {},
    costBasis: "incremental",
  }, error ? messageOf(error.message) ?? messageOf(error.error) ?? "codex 调用失败" : undefined)
}

/** 非零退出码或模型错误时也保留能解析出的数据；调用方再决定失败和重试。 */
export function parseProviderOutput(provider: ProviderName, stdout: string, stderr = ""): ProviderResult {
  const parse = { claude: parseClaude, grok: parseGrok, pi: parsePi, codex: parseCodex }[provider]
  let lastError = "无法解析模型输出"
  for (const output of [stdout, stderr]) {
    if (!output.trim()) continue
    try {
      return parse(output)
    } catch (error) {
      if (error instanceof ProviderOutputError) return error.result
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return { text: "", sessionId: null, model: null, usage: unknownUsage(), models: {}, error: lastError }
}
