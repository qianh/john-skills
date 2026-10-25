import { emptyUsage, type ProviderResult, type Usage } from "./types.ts"

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
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
    costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
  }
}

function objectsFrom(stdout: string): unknown[] {
  const text = stdout.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === "object") return [parsed]
  } catch {
    // 多行 JSON
  }
  const rows: unknown[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      // 忽略非 JSON 行
    }
  }
  return rows
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function parseClaude(stdout: string): ProviderResult {
  const result = objectsFrom(stdout)
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row?.type === "result")
    .at(-1)
  if (!result) throw new Error("claude 输出里没有 result")
  if (result.is_error === true) {
    throw new Error(typeof result.result === "string" ? result.result : "claude 返回 is_error")
  }
  const raw = asRecord(result.usage) ?? {}
  const details = asRecord(raw.output_tokens_details) ?? {}
  const usage = usageFrom({
    input: raw.input_tokens,
    output: raw.output_tokens,
    cacheRead: raw.cache_read_input_tokens,
    cacheWrite: raw.cache_creation_input_tokens,
    reasoning: details.thinking_tokens,
    costUsd: result.total_cost_usd,
  })
  const models: Record<string, Usage> = {}
  const modelUsage = asRecord(result.modelUsage) ?? {}
  for (const [name, value] of Object.entries(modelUsage)) {
    const row = asRecord(value) ?? {}
    models[name] = usageFrom({
      input: row.inputTokens,
      output: row.outputTokens,
      cacheRead: row.cacheReadInputTokens,
      cacheWrite: row.cacheCreationInputTokens,
      reasoning: row.thinkingTokens,
      costUsd: row.costUSD,
    })
  }
  const model = Object.keys(models)[0] ?? null
  return {
    text: typeof result.result === "string" ? result.result : "",
    sessionId: typeof result.session_id === "string" ? result.session_id : null,
    model,
    usage,
    models,
  }
}

export function parseGrok(stdout: string): ProviderResult {
  const rows = objectsFrom(stdout).map(asRecord).filter((row): row is Record<string, unknown> => !!row)
  const error = rows.find((row) => row.type === "error")
  if (error && !rows.some((row) => row.usage)) {
    throw new Error(typeof error.message === "string" ? error.message : "grok 调用失败")
  }
  const result = rows.find((row) => row.usage) ?? rows.at(-1)
  if (!result) throw new Error("grok 输出为空")
  const raw = asRecord(result.usage) ?? {}
  const models: Record<string, Usage> = {}
  const modelUsage = asRecord(result.modelUsage) ?? {}
  for (const [name, value] of Object.entries(modelUsage)) {
    const row = asRecord(value) ?? {}
    // costUSD 为 0 或缺失时不采信。OAuth 路径经常不回金额，0 不代表没花钱。
    const cost = typeof row.costUSD === "number" && row.costUSD > 0 ? row.costUSD : null
    models[name] = usageFrom({
      input: row.inputTokens,
      output: row.outputTokens,
      cacheRead: row.cacheReadInputTokens,
      cacheWrite: row.cacheCreationInputTokens,
      reasoning: raw.reasoning_tokens,
      costUsd: cost,
    })
  }
  const usage = usageFrom({
    input: raw.input_tokens,
    output: raw.output_tokens,
    cacheRead: raw.cache_read_input_tokens,
    cacheWrite: raw.cache_creation_input_tokens,
    reasoning: raw.reasoning_tokens,
    costUsd: null,
  })
  const text = typeof result.text === "string" ? result.text : typeof result.result === "string" ? result.result : ""
  return {
    text,
    sessionId: typeof result.sessionId === "string" ? result.sessionId : typeof result.session_id === "string" ? result.session_id : null,
    model: Object.keys(models)[0] ?? null,
    usage,
    models,
  }
}

export function parsePi(stdout: string): ProviderResult {
  const rows = objectsFrom(stdout).map(asRecord).filter((row): row is Record<string, unknown> => !!row)
  const session = rows.find((row) => row.type === "session")
  const ended = rows.findLast((row) => {
    if (row.type !== "message_end") return false
    const message = asRecord(row.message)
    return message?.role === "assistant"
  })
  if (!ended) throw new Error("pi 输出里没有 assistant message_end")
  const message = asRecord(ended.message) ?? {}
  if (message.stopReason === "error" || typeof message.errorMessage === "string") {
    throw new Error(typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : "pi 返回错误")
  }
  const raw = asRecord(message.usage) ?? {}
  const cost = asRecord(raw.cost)
  const usage = usageFrom({
    input: raw.input,
    output: raw.output,
    cacheRead: raw.cacheRead,
    cacheWrite: raw.cacheWrite,
    reasoning: raw.reasoning,
    costUsd: cost?.total,
  })
  const model = typeof message.model === "string" ? message.model : null
  const content = Array.isArray(message.content) ? message.content : []
  const text = content
    .map((block) => asRecord(block))
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block?.text as string)
    .join("")
  return {
    text,
    sessionId: session && typeof session.id === "string" ? session.id : null,
    model,
    usage,
    models: model ? { [model]: usage } : {},
  }
}

function unwrapCodex(row: Record<string, unknown>): Record<string, unknown> {
  const msg = asRecord(row.msg)
  return msg ?? row
}

export function parseCodex(stdout: string): ProviderResult {
  const rows = objectsFrom(stdout).map(asRecord).filter((row): row is Record<string, unknown> => !!row)
  const events = rows.map(unwrapCodex)
  const payloads = rows.map((row) => asRecord(row.payload) ?? row)
  const token = [...events, ...payloads]
    .map((row) => {
      if (row.type === "token_count") return asRecord(asRecord(row.info)?.last_token_usage)
      if (row.type === "event_msg") {
        const payload = asRecord(row.payload)
        if (payload?.type === "token_count") return asRecord(asRecord(payload.info)?.last_token_usage)
      }
      return null
    })
    .filter((row): row is Record<string, unknown> => !!row)
    .at(-1)
  const error = events.find((row) => row.type === "error" && typeof row.message === "string")
  if (!token) {
    throw new Error(typeof error?.message === "string" ? error.message : "codex 输出里没有用量")
  }
  const usage = usageFrom({
    input: token.input_tokens,
    output: token.output_tokens,
    cacheRead: token.cached_input_tokens,
    cacheWrite: token.cache_write_input_tokens,
    reasoning: token.reasoning_output_tokens,
    costUsd: null,
  })
  const started = events.find((row) => row.type === "thread.started")
  const sessionId = typeof started?.thread_id === "string" ? started.thread_id : null
  return { text: "", sessionId, model: null, usage, models: {}, error: typeof error?.message === "string" ? error.message : undefined }
}
