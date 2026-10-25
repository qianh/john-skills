import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { familyOf, type LoadedConfig, type ModelRow, type PoolName } from "./config.ts"
import { parseEffortRejection, pickEffort } from "./providers/effort.ts"
import type { HostStatus } from "./preflight.ts"
import { execPrompt, explorePrompt, planPrompt, rereviewPrompt, resumeExecPrompt, reviewPrompt, takeoverExecPrompt } from "./prompts.ts"
import { addUsage, emptyUsage, type Provider, type ProviderResult, type Role, type StageRequest, type Usage } from "./providers/types.ts"

export interface Resolved {
  alias: string
  provider: StageRequest["provider"]
  modelId: string
}

export interface CommandOutput {
  code: number
  stdout: string
  stderr: string
}

export interface WorkspaceDiff {
  patch: string
  status: string
}

export interface FlowOptions {
  cwd: string
  goal: string
  runDir: string
  config: LoadedConfig
  hosts: HostStatus[]
  provider: Provider
  /** 用户点名的执行模型别名，优先于方案里的类型。 */
  execPin?: string
  runCommand: (command: string, cwd: string) => Promise<CommandOutput>
  diff: (cwd: string) => Promise<WorkspaceDiff>
  newId?: () => string
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  /** 主会话做完被交回的那一步之后，从这里接着跑。 */
  resume?: SavedState
}

export interface FlowOutcome {
  ok: boolean
  summary: string
  runDir: string
}

interface Session {
  alias: string
  provider: StageRequest["provider"]
  modelId: string
  sessionId: string
}

interface CallLog {
  role: Role
  alias: string
  provider: string
  model: string
  effort: string
  sessionId: string
  resume: boolean
  ms: number
  usage: Usage
  error?: string
}

const POOLS = new Set<PoolName>(["mechanical", "standard", "hard"])

export function candidatesFor(aliases: string[], role: Role, models: ModelRow[], hosts: HostStatus[]): Resolved[] {
  const ready = new Set(hosts.filter((host) => host.installed && host.loggedIn).map((host) => host.provider))
  const resolved: Resolved[] = []
  for (const alias of aliases) {
    for (const row of models) {
      if (row.alias !== alias || !ready.has(row.provider)) continue
      if (role === "exec" && row.provider === "pi") continue
      resolved.push({ alias, provider: row.provider, modelId: row.modelId })
    }
  }
  return resolved
}

export function reviewAliases(execAlias: string, reviewModel: string, fallback: string[]): { aliases: string[], effortFromFallback: boolean } {
  if (familyOf(execAlias) === familyOf(reviewModel)) return { aliases: fallback, effortFromFallback: true }
  return { aliases: [reviewModel, ...fallback.filter((alias) => alias !== reviewModel)], effortFromFallback: false }
}

export function parsePlan(text: string): { pool: PoolName, commands: string[] } {
  const matched = text.match(/执行类型[：:\s*]*\b(mechanical|standard|hard)\b/i)
  const pool = (matched?.[1]?.toLowerCase() ?? "standard") as PoolName
  const section = sectionBody(text, "验收")
  const fromSection = commandLines(section)
  return { pool: POOLS.has(pool) ? pool : "standard", commands: fromSection.length ? fromSection : commandLines(text).slice(0, 3) }
}

export function parseReview(text: string): { p1: string[], p2: string[], formatted: boolean } {
  const formatted = /^##\s*P1\b/m.test(text) || /^##\s*P2\b/m.test(text)
  if (!formatted) return { p1: [], p2: [], formatted: false }
  return { p1: findingLines(sectionBody(text, "P1")), p2: findingLines(sectionBody(text, "P2")), formatted: true }
}

export function classifyError(message: string): "transient" | "hard" {
  if (/429|rate limit|too many requests|overloaded|ECONNRESET|ETIMEDOUT|ENOTFOUND|\b502\b|\b503\b|\b504\b|timeout|temporar/i.test(message)) {
    return "transient"
  }
  return "hard"
}

function sectionBody(text: string, title: string): string {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${title}\\s*$`).test(line))
  if (start < 0) return ""
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^##\s+/.test(line))
  return (end < 0 ? rest : rest.slice(0, end)).join("\n")
}

function commandLines(text: string): string[] {
  return text.split("\n").map(cleanLine).filter((line) => /^(node|bun|npm|pnpm|yarn|pytest|python3?|go|cargo|make)\b/.test(line))
}

function findingLines(text: string): string[] {
  const none = /^(无|没有|无问题|无 P1|无P1)$/
  const rows = text.split("\n").map((line) => ({ raw: line, text: cleanLine(line) })).filter((row) => row.text)
  // 「- 无」表示这一节没有问题。后面的说明即使带了列表符号，也不算 finding。
  if (rows.some((row) => none.test(row.text) && /^\s*([-*]|\d+[.)])\s+/.test(row.raw))) return []
  return rows.map((row) => row.text).filter((line) => !none.test(line))
}

function cleanLine(line: string): string {
  return line.trim().replace(/^[-*\d.)\s`]+/, "").replace(/`+$/, "").trim()
}

function clip(text: string, max = 24_000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n…（后面截掉了）`
}

function brief(text: string, max = 80): string {
  const inner = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1]
  return (inner ?? text).replace(/\s+/g, " ").trim().slice(0, max)
}

function money(usage: Usage): string {
  if (usage.costUsd == null) return "未报价"
  return `$${usage.costUsd.toFixed(4)}`
}

/** 美元 / 百万 token。思考 token 通常已经含在输出里，不再加一次。缓存有用量但没标价时不估算，避免把缓存当成免费。 */
export function costFromPrice(usage: Usage, price: { input: number | null, output: number | null, cacheRead: number | null, cacheWrite: number | null }): number | null {
  if (price.input == null || price.output == null) return null
  if (usage.cacheRead > 0 && price.cacheRead == null) return null
  if (usage.cacheWrite > 0 && price.cacheWrite == null) return null
  return (usage.input * price.input + usage.output * price.output + usage.cacheRead * (price.cacheRead ?? 0) + usage.cacheWrite * (price.cacheWrite ?? 0)) / 1_000_000
}

interface SavedState {
  goal: string
  cwd: string
  execPin?: string
  phase: "plan" | "exec" | "review" | "fix" | "done"
  reason: string
  fixes: number
  p1: string[]
  reviewRound: number
  replacements: string[]
}

class Handoff extends Error {
  readonly role: Role
  constructor(role: Role, reason: string) {
    super(reason)
    this.name = "Handoff"
    this.role = role
  }
}

export function renderSummary(input: {
  ok: boolean
  stuck?: string
  handoff?: { title: string, instruction: string }
  lineup: string
  replacements: string[]
  files: string
  verify: string
  p1Open: string[]
  fixes: number
  p2: string[]
  reviewNote?: string
  byRole: Record<string, Usage>
  unknownCost: boolean
  usingSample: boolean
  /** 把各次调用的 token 按 opus 价格重算。没有 opus 价格时不传。 */
  opusUsd?: number | null
  /** 这一档的金额来自价格列，不是 CLI 回报。 */
  estimatedRoles?: string[]
}): string {
  const bill = ["explore", "plan", "exec", "review"]
    .filter((role) => input.byRole[role])
    .map((role) => {
      const text = money(input.byRole[role])
      const estimated = input.estimatedRoles?.includes(role) && text !== "未报价"
      return `${role === "exec" ? "执行" : role} ${text}${estimated ? "（估算）" : ""}`
    })
    .join(" · ")
  const total = Object.values(input.byRole).reduce((sum, usage) => addUsage(sum, usage), emptyUsage())
  const opus = input.opusUsd == null ? "" : `（全程用 opus 约 $${input.opusUsd.toFixed(4)}，估算）`
  const lines = [
    `结论：${input.handoff ? `${input.handoff.title} 交给主会话` : input.ok ? "完成" : `卡在 ${input.stuck ?? "未知"}`}`,
    `阵容：${input.lineup}（替换：${input.replacements.length ? input.replacements.join("；") : "无"}）`,
    `改动：${input.files || "无"}`,
    `验收：${input.verify}`,
    `Review：修复 ${input.fixes} 轮，P1 未修 ${input.p1Open.length} 条${input.p1Open.length ? `（${input.p1Open.join("；")}）` : ""}；P2 ${input.p2.length} 条${input.p2.length ? `（${input.p2.join("；")}）` : ""}`,
    `账单：${bill || "无"} · 合计 ${money(total)}${opus}${input.unknownCost ? "（有调用没回金额，合计不含这些）" : ""}`,
  ]
  if (input.handoff) lines.push(`主会话：${input.handoff.instruction}`)
  if (input.reviewNote) lines.push(input.reviewNote)
  if (input.usingSample) lines.push("配置：本机没有 ~/.config/orchestrate，用了 skill 自带的示例。")
  return lines.join("\n")
}

function handoffTitle(phase: SavedState["phase"]): string {
  if (phase === "plan") return "plan"
  if (phase === "review") return "review"
  return "执行"
}

function handoffInstruction(phase: SavedState["phase"], reason: string, runDir: string, reviewRound: number): string {
  const next = `写完后用刚才的 bun 和 orch.ts 执行 continue --run ${JSON.stringify(runDir)}`
  if (phase === "plan") return `${reason}。请自己写方案，写入 ${runDir}/plan.md，必须有「## 执行类型」「## 验收」「## 方案」。${next}`
  if (phase === "exec") return `${reason}。请按 ${runDir}/plan.md 在工作区改完代码。不要 commit。${next}`
  if (phase === "review") return `${reason}。请只读审查，把结果写入 ${runDir}/review-${reviewRound}.md，使用「## P1」和「## P2」。若主会话和执行模型同家族，独立性不足。${next}`
  return `${reason}。请按 ${runDir}/review-${reviewRound}.md 里的 P1 自己改代码。不要 commit。${next}`
}

function readText(file: string): string | null {
  if (!existsSync(file)) return null
  return readFileSync(file, "utf8")
}

export async function runFlow(options: FlowOptions): Promise<FlowOutcome> {
  const log = options.log ?? (() => {})
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  let idSeq = 0
  const newId = options.newId ?? (() => {
    idSeq += 1
    return `00000000-0000-4000-8000-${String(idSeq).padStart(12, "0")}`
  })
  mkdirSync(options.runDir, { recursive: true })
  const sessions: Record<string, Session> = {}
  const calls: CallLog[] = []
  const replacements: string[] = []
  const byRole: Record<string, Usage> = {}

  const persist = () => {
    writeFileSync(path.join(options.runDir, "sessions.json"), JSON.stringify(sessions, null, 2))
    writeFileSync(path.join(options.runDir, "usage.jsonl"), calls.map((call) => JSON.stringify(call)).join("\n") + (calls.length ? "\n" : ""))
  }

  const priced = (alias: string, provider: string) => options.config.models.find((row) => row.alias === alias && row.provider === provider)?.price

  const settle = (usage: Usage, alias: string, provider: string): Usage => {
    if (usage.costUsd != null) return usage
    const price = priced(alias, provider)
    if (!price) return usage
    const estimated = costFromPrice(usage, price)
    return estimated == null ? usage : { ...usage, costUsd: estimated }
  }

  const estimatedRoles = new Set<string>()

  const note = (role: string, usage: Usage, alias: string, provider: string) => {
    const settled = settle(usage, alias, provider)
    if (usage.costUsd == null && settled.costUsd != null) estimatedRoles.add(role)
    byRole[role] = addUsage(byRole[role] ?? emptyUsage(), settled)
  }

  const opusTotal = () => {
    const price = options.config.models.find((row) => row.alias === "opus-5.5" && row.price.input != null && row.price.output != null)?.price
    if (!price) return null
    let total = 0
    let any = false
    for (const call of calls) {
      if (call.error) continue
      const part = costFromPrice(call.usage, price)
      if (part == null) return null
      total += part
      any = true
    }
    return any ? total : null
  }

  const missingPrice = () => calls.some((call) => !call.error && settle(call.usage, call.alias, call.provider).costUsd == null)

  const resumed = options.resume
  if (resumed) {
    replacements.push(...resumed.replacements)
    const savedSessions = readText(path.join(options.runDir, "sessions.json"))
    if (savedSessions) Object.assign(sessions, JSON.parse(savedSessions) as Record<string, Session>)
    const savedUsage = readText(path.join(options.runDir, "usage.jsonl"))
    if (savedUsage) {
      for (const line of savedUsage.split("\n")) {
        if (!line.trim()) continue
        const call = JSON.parse(line) as CallLog
        calls.push(call)
        if (!call.error) note(call.role, call.usage, call.alias, call.provider)
      }
    }
  }

  const checkpoint: { phase: "plan" | "exec" | "review" | "fix", fixes: number, p1: string[], reviewRound: number } = {
    phase: "plan",
    fixes: resumed?.fixes ?? 0,
    p1: resumed?.p1 ?? [],
    reviewRound: resumed?.reviewRound ?? 1,
  }

  const lineup = () => {
    const execName = sessions.exec?.alias ?? (resumed && resumed.phase !== "plan" ? "主会话" : "无")
    return `plan ${sessions.plan?.alias ?? "无"} · 执行 ${execName} · review ${sessions.review?.alias ?? "无"}`
  }

  const markDone = () => {
    const statePath = path.join(options.runDir, "state.json")
    const saved = readText(statePath)
    if (!saved) return
    const state = JSON.parse(saved) as SavedState
    state.phase = "done"
    writeFileSync(statePath, JSON.stringify(state, null, 2))
  }

  async function invoke(spec: {
    role: Role
    aliases: string[]
    effort: string
    prompt: string
    promptForReplacement?: () => Promise<string>
  }): Promise<{ result: ProviderResult, picked: Resolved }> {
    const list = candidatesFor(spec.aliases, spec.role, options.config.models, options.hosts)
    if (!list.length) throw new Handoff(spec.role, `没有可用模型（${spec.aliases.join("、") || "未配置"}）`)
    let last = ""
    let effort = spec.effort
    for (let index = 0; index < list.length; index++) {
      const candidate = list[index]
      const previous = sessions[spec.role]
      const same = previous?.provider === candidate.provider && previous.modelId === candidate.modelId
      let sessionId = same && previous ? previous.sessionId : newId()
      let resume = Boolean(same && previous)
      const prompt = index === 0 || !spec.promptForReplacement ? spec.prompt : await spec.promptForReplacement()
      for (let attempt = 1; attempt <= 2; attempt++) {
        const request: StageRequest = {
          provider: candidate.provider,
          role: spec.role,
          model: candidate.modelId,
          effort,
          prompt,
          cwd: options.cwd,
          sessionId,
          resume,
          sessionDir: path.join(options.runDir, "pi-sessions"),
        }
        log(`→ ${spec.role} ${candidate.alias}（${candidate.provider}${resume ? "，续接" : ""}）`)
        const started = Date.now()
        try {
          const result = await options.provider.run(request)
          const kept = result.sessionId || sessionId
          sessions[spec.role] = { alias: candidate.alias, provider: candidate.provider, modelId: candidate.modelId, sessionId: kept }
          calls.push({ role: spec.role, alias: candidate.alias, provider: candidate.provider, model: result.model ?? candidate.modelId, effort, sessionId: kept, resume, ms: Date.now() - started, usage: result.usage })
          note(spec.role, result.usage, candidate.alias, candidate.provider)
          if (index > 0) replacements.push(`${spec.role} 改用 ${candidate.alias}：${brief(last)}`)
          persist()
          return { result, picked: candidate }
        } catch (error) {
          last = (error as Error).message || String(error)
          calls.push({ role: spec.role, alias: candidate.alias, provider: candidate.provider, model: candidate.modelId, effort, sessionId, resume, ms: Date.now() - started, usage: emptyUsage(), error: brief(last, 400) })
          persist()
          const allowed = parseEffortRejection(last)
          if (allowed && attempt === 1) {
            effort = pickEffort(effort, allowed)
            resume = true
            continue
          }
          if (classifyError(last) === "transient" && attempt === 1) {
            await sleep(2000)
            resume = true
            continue
          }
          break
        }
      }
    }
    throw new Handoff(spec.role, `${spec.aliases.join("、")} 都失败：${brief(last)}`)
  }

  try {
    let planText = ""
    if (!resumed) {
      let notes = "（没有探索笔记）"
      const explore = options.config.routing.plan.explore
      if (explore) {
        try {
          const found = await invoke({ role: "explore", aliases: [explore.model], effort: explore.effort, prompt: explorePrompt(options.goal) })
          notes = found.result.text || notes
        } catch (error) {
          notes = `（探索没跑成：${brief((error as Error).message)}。方案阶段自己看仓库。）`
          log(notes)
        }
      }
      writeFileSync(path.join(options.runDir, "explore.md"), notes)
      checkpoint.phase = "plan"
      const planned = await invoke({
        role: "plan",
        aliases: [options.config.routing.plan.model, ...options.config.routing.plan.fallback],
        effort: options.config.routing.plan.effort,
        prompt: planPrompt(options.goal, clip(notes)),
      })
      planText = planned.result.text
      writeFileSync(path.join(options.runDir, "plan.md"), planText)
    } else {
      checkpoint.phase = resumed.phase === "plan" ? "plan" : "exec"
      const written = readText(path.join(options.runDir, "plan.md"))
      if (!written) {
        checkpoint.phase = "plan"
        throw new Handoff("plan", "plan.md 还不存在")
      }
      planText = written
    }
    const plan = parsePlan(planText)
    const pool = options.execPin ? null : plan.pool
    const execAliases = options.execPin ? [options.execPin] : options.config.routing.exec.pools[pool ?? options.config.routing.exec.defaultPool]
    let execAlias = sessions.exec?.alias ?? "主会话"
    if (!resumed || resumed.phase === "plan") {
      checkpoint.phase = "exec"
      const executed = await invoke({
        role: "exec",
        aliases: execAliases,
        effort: options.config.routing.exec.effort,
        prompt: execPrompt(options.goal, clip(planText), plan.commands),
        promptForReplacement: async () => takeoverExecPrompt(options.goal, clip(planText), clip((await options.diff(options.cwd)).patch), "上一个模型失败"),
      })
      execAlias = executed.picked.alias
    }

    const reviewChoice = reviewAliases(execAlias, options.config.routing.review.model, options.config.routing.review.fallback)
    const reviewEffort = reviewChoice.effortFromFallback ? options.config.routing.review.fallbackEffort : options.config.routing.review.effort
    let reviewNote = reviewChoice.effortFromFallback ? "review 改由另一个家族来做，避免执行模型审自己。" : undefined
    if (!reviewChoice.aliases.length) reviewNote = "review 与执行是同一个家族，没有别的模型可换，独立性不足。"
    let p1: string[] = []
    let p2: string[] = []
    let formatted = true
    const maxRounds = options.config.routing.review.maxRounds
    const takeControllerReview = resumed?.phase === "review"
    let startRound = 1
    if (resumed?.phase === "review") startRound = resumed.reviewRound
    if (resumed?.phase === "fix") startRound = resumed.reviewRound + 1
    if (reviewChoice.aliases.length || takeControllerReview) {
      for (let round = startRound; round <= maxRounds + 1; round++) {
        const diff = await options.diff(options.cwd)
        const reviewPath = path.join(options.runDir, `review-${round}.md`)
        const useController = takeControllerReview && round === resumed?.reviewRound
        let text = ""
        if (useController) {
          checkpoint.phase = "review"
          checkpoint.reviewRound = round
          const written = readText(reviewPath)
          if (!written) throw new Handoff("review", `review-${round}.md 还不存在`)
          text = written
        } else {
          checkpoint.phase = "review"
          checkpoint.reviewRound = round
          const reviewed = await invoke({
            role: "review",
            aliases: round === 1 ? reviewChoice.aliases : [sessions.review?.alias ?? reviewChoice.aliases[0]],
            effort: reviewEffort,
            prompt: round === 1 ? reviewPrompt(options.goal, clip(planText), clip(diff.patch || diff.status || "（没有 diff）")) : rereviewPrompt(clip(diff.patch || diff.status || "（没有 diff）")),
          })
          text = reviewed.result.text
          writeFileSync(reviewPath, text)
        }
        const parsed = parseReview(text)
        p1 = parsed.p1
        p2 = parsed.p2
        formatted = parsed.formatted
        if (!formatted || p1.length === 0) break
        if (checkpoint.fixes >= maxRounds) break
        checkpoint.fixes += 1
        checkpoint.p1 = p1
        checkpoint.phase = "fix"
        checkpoint.reviewRound = round
        const again = await options.diff(options.cwd)
        await invoke({
          role: "exec",
          aliases: [execAlias, ...execAliases.filter((alias) => alias !== execAlias)],
          effort: options.config.routing.exec.effort,
          prompt: resumeExecPrompt(clip(planText), p1, clip(again.patch || again.status)),
          promptForReplacement: async () => takeoverExecPrompt(options.goal, clip(planText), clip((await options.diff(options.cwd)).patch), p1.join("；")),
        })
      }
    }

    const verifyLines: string[] = []
    const verifyDetail: string[] = []
    let verifyOk = true
    if (!plan.commands.length) {
      verifyLines.push("方案里没有可执行的验收命令，未复核")
      verifyDetail.push("方案里没有可执行的验收命令，未复核")
      verifyOk = false
    }
    for (const command of plan.commands) {
      const output = await options.runCommand(command, options.cwd)
      const tail = `${output.stdout}\n${output.stderr}`.trim().slice(-2000)
      const status = `${command} ${output.code === 0 ? "通过" : "失败"}（脚本复核）`
      verifyLines.push(status)
      verifyDetail.push(`${status}${tail ? `\n${tail}` : ""}`)
      if (output.code !== 0) verifyOk = false
    }
    writeFileSync(path.join(options.runDir, "verify.txt"), verifyDetail.join("\n\n"))

    const diff = await options.diff(options.cwd)
    const stuck = !formatted
      ? "review 没有按 P1/P2 格式回复"
      : p1.length
        ? "review 仍有 P1"
        : !verifyOk
          ? "验收"
          : undefined
    const summary = renderSummary({
      ok: !stuck,
      stuck,
      lineup: lineup(),
      replacements,
      files: diff.status || "无",
      verify: verifyLines.join("；"),
      p1Open: formatted ? p1 : [],
      fixes: checkpoint.fixes,
      p2: formatted ? p2 : [],
      reviewNote: formatted ? reviewNote : "review 原文见 review 文件，没有按格式，不算通过。",
      byRole,
      unknownCost: missingPrice(),
      usingSample: options.config.usingSample,
      opusUsd: opusTotal(),
      estimatedRoles: [...estimatedRoles],
    })
    markDone()
    writeFileSync(path.join(options.runDir, "summary.md"), summary)
    return { ok: !stuck, summary, runDir: options.runDir }
  } catch (error) {
    if (error instanceof Handoff) {
      const state: SavedState = {
        goal: options.goal,
        cwd: options.cwd,
        execPin: options.execPin,
        phase: checkpoint.phase,
        reason: error.message,
        fixes: checkpoint.fixes,
        p1: checkpoint.p1,
        reviewRound: checkpoint.reviewRound,
        replacements: [...replacements],
      }
      writeFileSync(path.join(options.runDir, "state.json"), JSON.stringify(state, null, 2))
      let files = "未收集"
      try {
        files = (await options.diff(options.cwd)).status || "无"
      } catch {
        // 工作区读不到时，汇总里留「未收集」。
      }
      const summary = renderSummary({
        ok: false,
        handoff: {
          title: handoffTitle(checkpoint.phase),
          instruction: handoffInstruction(checkpoint.phase, error.message, options.runDir, checkpoint.reviewRound),
        },
        lineup: lineup(),
        replacements,
        files,
        verify: "未跑",
        p1Open: [],
        fixes: checkpoint.fixes,
        p2: [],
        byRole,
        unknownCost: missingPrice(),
        usingSample: options.config.usingSample,
        opusUsd: opusTotal(),
        estimatedRoles: [...estimatedRoles],
      })
      writeFileSync(path.join(options.runDir, "summary.md"), summary)
      return { ok: false, summary, runDir: options.runDir }
    }
    const summary = renderSummary({
      ok: false,
      stuck: brief((error as Error).message),
      lineup: lineup(),
      replacements,
      files: "未收集",
      verify: "未跑",
      p1Open: [],
      fixes: checkpoint.fixes,
      p2: [],
      byRole,
      unknownCost: missingPrice(),
      usingSample: options.config.usingSample,
      opusUsd: opusTotal(),
      estimatedRoles: [...estimatedRoles],
    })
    writeFileSync(path.join(options.runDir, "summary.md"), summary)
    return { ok: false, summary, runDir: options.runDir }
  }
}

export async function continueFlow(options: FlowOptions): Promise<FlowOutcome> {
  const saved = readText(path.join(options.runDir, "state.json"))
  if (!saved) return { ok: false, summary: "结论：没有找到待主会话完成的步骤", runDir: options.runDir }
  const state = JSON.parse(saved) as SavedState
  if (state.phase === "done") return { ok: false, summary: "结论：这次运行已经做完，没有待主会话完成的步骤", runDir: options.runDir }
  return runFlow({
    ...options,
    goal: state.goal,
    cwd: state.cwd,
    execPin: options.execPin ?? state.execPin,
    resume: state,
  })
}
