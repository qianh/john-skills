import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"
import { familyOf, validateExecPin, type LoadedConfig, type ModelRow, type RoleModel } from "./config.ts"
import { parseContractText, strictJSON, validatePlan, validateReview, validateChecks, reviewFindings, renderPlan, planSchema, reviewSchema, checksSchema, type Plan, type Review } from "./contracts.ts"
import { cliProvider } from "./cli-provider.ts"
import { parseEffortRejection, pickEffort } from "./providers/effort.ts"
import { ProviderOutputError, emptyUsage, unknownUsage, type Provider, type ProviderResult, type Role, type StageRequest, type Usage } from "./providers/types.ts"
import type { HostStatus } from "./preflight.ts"
import { correctionPrompt, execPrompt, explorePrompt, planPrompt, reviewPrompt } from "./prompts.ts"
import { atomicJSON, atomicWrite, assertWorkersStopped, stopWorkers, UnavailableCache, type Worker } from "./runtime.ts"
import { credentialReadPaths, safeEnv, scanText, sanitizeValue } from "./safety.ts"
import { SnapshotManager, type Snapshot } from "./snapshot.ts"
import { dependencyPath, missingPermissions, parseAllow, routeAdmission, verifyCommand, type VerificationOutput } from "./sandbox.ts"

export type Step = "explore" | "plan" | "gate" | "exec" | "verify" | "review" | "fix" | "check" | "finalize"
export type HandoffType = "plan" | "exec" | "fix" | "review" | "check" | "permission" | "budget"
export interface Session { alias: string; provider: StageRequest["provider"]; modelId: string; sessionId: string; securityProfile: string }
export interface CallLog {
  role: Role; alias: string; provider: string; model: string; effort: string; requestedEffort: string
  sessionId: string; resume: boolean; ms: number; usage: Usage; costSource: "cli" | "price" | "unknown" | "not_sent"
  result: "ok" | "error" | "timeout" | "pending"; error?: string
}
export interface SavedState {
  version: 2; goal: string; cwd: string; runDir: string; status: "running" | "waiting" | "done" | "interrupted"
  step: Step; startedAt: number; updatedAt: number; lastLog: string; fixes: number; reviewRound: number; tmpDir: string
  authors: { alias: string; family: string }[]; sessions: Partial<Record<Role, Session>>; selected: Partial<Record<Role, string>>; workers: Worker[]
  baseline: Snapshot; current: Snapshot; verifiedTree?: string; reviewedTree?: string; checksTree?: string
  plan?: Plan; review?: Review; reviewerFamily?: string; p1: string[]; replacements: string[]; safetyFlags: string[]
  calls: CallLog[]; cumulativeCosts: Record<string, number>; allow: string[]; execPin?: string; planOnly: boolean
  budget?: number; maxCalls?: number; maxMinutes?: number; handoff?: { type: HandoffType; reason: string; tree: string }
  mode: "run" | "review"; dual: boolean; author?: string; base?: string; paths: string[]; reviewFamilies: string[]; reviewP1: string[]
}
export interface Workspace {
  cwd: string; gitDir: string
  captureBaseline(): Snapshot; captureSnapshot(): Snapshot; safeHead(ref?: string): string
  diffTrees(from: string, to: string, paths?: string[]): string; changedPaths(from: string, to: string): string[]
  checkSafety(baseline: Snapshot, current: Snapshot): string[]
}
export interface FlowOptions {
  cwd: string; goal: string; runDir: string; config: LoadedConfig; hosts: HostStatus[]; provider?: Provider
  execPin?: string; allow?: string[]; planOnly?: boolean; budget?: number; maxCalls?: number; maxMinutes?: number
  mode?: "run" | "review"; dual?: boolean; author?: string; base?: string; paths?: string[]; by?: string
  workspace?: Workspace; runCommand?: (command: string, cwd: string) => Promise<VerificationOutput>
  newId?: () => string; log?: (line: string) => void; sleep?: (ms: number) => Promise<void>; cache?: UnavailableCache
  resume?: SavedState
}
export interface FlowOutcome { ok: boolean; exitCode: number; summary: string; runDir: string }
export function classifyError(message: string): "transient" | "hard" {
  return /429|rate limit|overloaded|ECONNRESET|ETIMEDOUT|ENOTFOUND|\b50[0234]\b|timeout|temporar/i.test(message) ? "transient" : "hard"
}
export function costFromPrice(usage: Usage, price: ModelRow["price"]): number | null {
  if ([usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some((v) => v == null)) return null
  if (price.input == null || price.output == null || (usage.cacheRead! > 0 && price.cacheRead == null) || (usage.cacheWrite! > 0 && price.cacheWrite == null)) return null
  return (usage.input! * price.input + usage.output! * price.output + usage.cacheRead! * (price.cacheRead ?? 0) + usage.cacheWrite! * (price.cacheWrite ?? 0)) / 1_000_000
}
export function independent(family: string, authors: { family: string }[]): boolean {
  return family !== "unknown" && !authors.some((a) => a.family === "unknown" || a.family === family)
}
function brief(text: string, max = 350): string { return scanText(text).text.replace(/\s+/g, " ").slice(0, max) }
function artifact(file: string): string {
  if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error(`缺少普通文件：${file}`)
  if (lstatSync(file).size > 4_000_000) throw new Error("交接文件过大")
  return readFileSync(file, "utf8")
}
class Halt extends Error {
  constructor(readonly exitCode: number, message: string, readonly type?: HandoffType) { super(message) }
}
const schemas = { plan: planSchema, review: reviewSchema, checks: checksSchema }

export async function runFlow(o: FlowOptions): Promise<FlowOutcome> {
  validateExecPin(o.execPin, o.config)
  for (const [key, value] of [["budget", o.budget], ["maxCalls", o.maxCalls], ["maxMinutes", o.maxMinutes]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || (key === "maxCalls" && !Number.isInteger(value)))) throw new Error(`--${key} 必须为正${key === "maxCalls" ? "整数" : "数"}`)
  }
  mkdirSync(o.runDir, { recursive: true, mode: 0o700 })
  const workspace = o.workspace ?? new SnapshotManager(o.cwd, o.runDir, { sensitiveExtra: o.config.safety.sensitiveExtra })
  // CLI workers cannot write the evidence directory; shell TMPDIR lives outside git metadata.
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const commandTmp = o.resume?.tmpDir ?? mkdtempSync(path.join(tmpdir(), "orchestrate-"))
  if (!existsSync(commandTmp) || lstatSync(commandTmp).isSymbolicLink() || path.dirname(realpathSync(commandTmp)) !== realpathSync(tmpdir()) || !path.basename(commandTmp).startsWith("orchestrate-")) throw new Error("运行专用临时目录缺失或不可信，拒绝恢复")
  const cache = o.cache ?? new UnavailableCache()
  let state: SavedState = o.resume ?? (() => {
    const baseline = workspace.captureBaseline()
    return { version: 2, goal: o.goal, cwd: workspace.cwd, runDir: o.runDir, status: "running", step: o.mode === "review" ? "review" : "explore", startedAt: Date.now(), updatedAt: Date.now(), lastLog: "预检完成", fixes: 0, reviewRound: 1, tmpDir: commandTmp, authors: [], sessions: {}, selected: {}, workers: [], baseline, current: baseline, p1: [], replacements: [], safetyFlags: [], calls: [], cumulativeCosts: {}, allow: parseAllow(o.allow), execPin: o.execPin, planOnly: o.planOnly ?? false, budget: o.budget, maxCalls: o.maxCalls, maxMinutes: o.maxMinutes, mode: o.mode ?? "run", dual: o.dual ?? false, author: o.author, base: o.base, paths: o.paths ?? [], reviewFamilies: [], reviewP1: [] }
  })()
  if (state.version !== 2) throw new Error("旧运行状态不兼容；请保留记录并新开运行")
  const scan = (text: string): string => { const found = scanText(text); state.safetyFlags.push(...found.flags); state.safetyFlags = [...new Set(state.safetyFlags)]; return found.text }
  const write = (name: string, text: string) => atomicWrite(path.join(o.runDir, name), scan(text))
  const persist = () => {
    state.updatedAt = Date.now()
    const clean = sanitizeValue(state)
    state.safetyFlags = [...new Set([...state.safetyFlags, ...clean.flags])]
    atomicJSON(path.join(o.runDir, "state.json"), { ...clean.value as SavedState, safetyFlags: state.safetyFlags })
    atomicWrite(path.join(o.runDir, "usage.jsonl"), state.calls.map((c) => JSON.stringify(sanitizeValue(c).value)).join("\n") + (state.calls.length ? "\n" : ""))
  }
  const log = (text: string) => { state.lastLog = brief(text); o.log?.(state.lastLog); persist() }
  const author = (alias: string) => {
    if (!state.authors.some((a) => a.alias === alias)) state.authors.push({ alias, family: familyOf(alias, o.config.models) })
  }
  const capture = () => {
    state.current = workspace.captureSnapshot()
    state.safetyFlags = [...new Set([...state.safetyFlags, ...workspace.checkSafety(state.baseline, state.current)])]
    persist()
    return state.current
  }
  const step = (next: Step) => { state.step = next; state.status = "running"; state.handoff = undefined; log(`阶段：${next}`) }
  const halt = (code: number, reason: string, type?: HandoffType): never => { throw new Halt(code, scan(reason), type) }
  const handoff = (type: HandoffType, reason: string): never => halt(3, reason, type)
  const hooks = {
    onStart(worker: Worker) { state.workers.push(worker); persist() },
    onEnd(worker: Worker) { state.workers = state.workers.filter((w) => w.pid !== worker.pid); persist() },
  }
  const provider = o.provider ?? cliProvider(hooks)
  let interrupting = false
  const onSignal = () => {
    interrupting = true
    state.status = "interrupted"; persist()
    void stopWorkers(state.workers).finally(() => { persist(); process.exit(4) })
  }
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal)
  const securityProfile = () => createHash("sha256").update(JSON.stringify({ safety: o.config.safety, allow: state.allow, cwd: state.cwd, adapter: 2 })).digest("hex")
  const budgetCheck = () => {
    if (interrupting) halt(4, "收到中断信号，停止派发新 worker")
    const known = state.calls.reduce((sum, c) => sum + (c.usage.costUsd ?? 0), 0)
    if (state.budget !== undefined && known >= state.budget) handoff("budget", `已知金额 $${known.toFixed(4)} 达到预算 $${state.budget}`)
    if (state.maxCalls !== undefined && state.calls.length >= state.maxCalls) handoff("budget", `已调用 ${state.calls.length} 次，达到 max-calls`)
    if (state.maxMinutes !== undefined && Date.now() - state.startedAt >= state.maxMinutes * 60_000) handoff("budget", "达到 max-minutes")
  }
  const diff = () => {
    capture()
    const from = state.mode === "review" ? workspace.safeHead(state.base) : state.baseline.tree
    const paths = scopePaths()
    const raw = paths.length ? workspace.diffTrees(from, state.current.tree, paths) : ""
    const full = scan(raw)
    write(`diff-${state.reviewRound}.patch`, full)
    const limit = 24_000
    return full.length <= limit ? full || "（本次没有增量）" : `${full.slice(0, limit)}\n完整已扫描 diff：${path.join(o.runDir, `diff-${state.reviewRound}.patch`)}`
  }
  const scopePaths = () => {
    const from = state.mode === "review" ? workspace.safeHead(state.base) : state.baseline.tree
    return workspace.changedPaths(from, state.current.tree).filter((file) => state.mode !== "review" || !state.paths.length || state.paths.some((glob) => new Bun.Glob(glob).match(file)))
  }
  const outOfScope = () => scopePaths().filter((file) => !state.plan!.allowed_paths.some((glob) => new Bun.Glob(glob).match(file)))
  const planText = () => renderPlan(state.plan!)
  const execChain = () => state.execPin ? [{ model: state.execPin, effort: o.config.routing.exec.effort }] : o.config.routing.exec.pools[state.plan!.exec_type]

  async function invoke(role: Role, chain: RoleModel[], prompt: string, schema?: Record<string, unknown>, only?: Session): Promise<{ result: ProviderResult; session: Session }> {
    let last = "候选均不可用"
    let attempted = 0
    const previous = state.sessions[role]
    // Keep the established execution/review session first, but never change its declared effort.
    const ordered = previous && !only ? [...chain.filter((c) => c.model === previous.alias), ...chain.filter((c) => c.model !== previous.alias)] : chain
    for (const position of ordered) {
      const rows = o.config.models.filter((r) => r.alias === position.model)
      const rowOrder = previous ? [...rows.filter((r) => r.provider === previous.provider && r.modelId === previous.modelId), ...rows.filter((r) => r.provider !== previous.provider || r.modelId !== previous.modelId)] : rows
      for (const row of rowOrder) {
        if (only && (row.alias !== only.alias || row.provider !== only.provider || row.modelId !== only.modelId)) continue
        if (role === "review" && (!independent(row.family, state.authors) || state.reviewFamilies.includes(row.family))) { state.replacements.push(`review 跳过 ${row.alias}：家族冲突`); continue }
        const host = o.hosts.find((h) => h.provider === row.provider)
        if (!host?.installed || !host.loggedIn) { state.replacements.push(`${role} 跳过 ${row.alias}/${row.provider}：未安装或未登录`); continue }
        const admission = routeAdmission(row.provider, role, o.config.safety)
        if (!admission.admitted) { state.replacements.push(`${role} 跳过 ${row.alias}/${row.provider}：${admission.reason}`); continue }
        const cached = cache.get(row.provider, row.modelId)
        if (cached) { state.replacements.push(`${role} 跳过 ${row.alias}/${row.provider}：${brief(cached.reason)}（${Math.floor((Date.now() - cached.at) / 60000)} 分钟前）`); continue }
        let effort = row.efforts ? pickEffort(position.effort, row.efforts) : position.effort
        if (effort !== position.effort) state.replacements.push(`${role} ${row.alias}/${row.provider} 思考程度 ${position.effort} → ${effort}`)
        const profile = securityProfile()
        const same = previous?.alias === row.alias && previous.provider === row.provider && previous.modelId === row.modelId && previous.securityProfile === profile
        let resume = Boolean(same), sessionId = same ? previous!.sessionId : (o.newId ?? randomUUID)()
        if (previous && !same) state.replacements.push(`${role} 新会话接手：路由或授权/安全配置变化`)
        for (let attempt = 0; attempt < 2; attempt++) {
          budgetCheck()
          const fullPrompt = role === "exec" ? execPrompt(state.goal, planText(), state.allow, state.baseline.preexisting, diff(), prompt) : prompt
          const sandbox = row.provider === "grok" ? { profile: role === "exec" ? "workspace" : "read-only" } : row.provider === "claude" ? { settings: { sandbox: { enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, filesystem: { allowWrite: role === "exec" ? [state.cwd, commandTmp] : [commandTmp], denyWrite: [workspace.gitDir, path.join(state.cwd, ".git")], denyRead: [...Object.keys(state.current.sensitive).map((f) => path.join(state.cwd, f)), ...credentialReadPaths("claude", o.config.safety.sensitiveExtra)] }, network: { allowedDomains: state.allow.includes("network:*") ? ["*"] : state.allow.filter((a) => a.startsWith("network:")).map((a) => a.slice(8)) } } } } : undefined
          const req: StageRequest = { provider: row.provider, role, model: row.modelId, effort, prompt: scan(fullPrompt), cwd: state.cwd, sessionId, resume, sessionDir: path.join(commandTmp, "pi-sessions"), schema, schemaPath: schema ? path.join(o.runDir, role === "plan" ? "plan.schema.json" : "review.schema.json") : undefined, timeoutMs: o.config.routing[role].timeoutMin * 60_000, securityProfile: profile, env: safeEnv(row.provider, o.config.safety.cliEnv[row.provider] ?? [], commandTmp), supportedEfforts: row.efforts ?? undefined, sandbox }
          log(`→ ${role} ${row.alias}/${row.provider} · ${effort}${resume ? "（续接）" : ""}`)
          if (role === "exec") author(row.alias)
          const call: CallLog = { role, alias: row.alias, provider: row.provider, model: row.modelId, requestedEffort: position.effort, effort, sessionId, resume, ms: 0, usage: unknownUsage(), costSource: "unknown", result: "pending" }
          state.calls.push(call); persist()
          const started = Date.now()
          const beforeReadOnly = state.current.tree
          let result: ProviderResult | undefined, error: Error | undefined
          try { result = await provider.run(req); if (result.error) throw new ProviderOutputError(result.error, result) }
          catch (caught) { error = caught instanceof Error ? caught : new Error(String(caught)); if (caught instanceof ProviderOutputError) result = caught.result }
          call.ms = Date.now() - started
          call.result = error ? (classifyError(error.message) === "transient" && /timeout/i.test(error.message) ? "timeout" : "error") : "ok"
          call.error = error ? brief(error.message, 1000) : undefined
          call.model = result?.model ?? row.modelId
          call.usage = result?.usage ? { ...result.usage } : unknownUsage()
          const notSent = error && (error as Error & { notSent?: boolean }).notSent
          if (notSent) { call.usage = { ...emptyUsage(), costUsd: 0 }; call.costSource = "not_sent" }
          else {
            if (result?.costBasis === "cumulative" && call.usage.costUsd != null) {
              const key = `${row.provider}/${result.sessionId ?? sessionId}`
              const total = call.usage.costUsd, prior = state.cumulativeCosts[key] ?? 0
              call.usage.costUsd = total >= prior ? total - prior : null
              state.cumulativeCosts[key] = total
            }
            call.costSource = call.usage.costUsd == null ? "unknown" : "cli"
            if (call.usage.costUsd == null) {
              // A different billed model must not inherit this route's price.
              const cost = call.model === row.modelId ? costFromPrice(call.usage, row.price) : null
              if (cost != null) { call.usage.costUsd = cost; call.costSource = "price" }
            }
          }
          attempted++; persist()
          if (interrupting) halt(4, "中断后停止后续重试/替换")
          if (role !== "exec" && capture().tree !== beforeReadOnly) {
            author(row.alias); state.safetyFlags.push(`${role} 只读调用期间工作区发生写入`)
            halt(5, "只读阶段检测到工作区变化，停止推进并保留证据")
          }
          if (!error && result) {
            const kept: Session = { alias: row.alias, provider: row.provider, modelId: row.modelId, sessionId: result.sessionId ?? sessionId, securityProfile: profile }
            // An invented ID is not evidence that the CLI established a resumable session.
            if (result.sessionId) state.sessions[role] = kept
            state.selected[role] = row.alias
            result = { ...result, text: scan(result.text) }
            if (result.structured !== undefined) { const clean = sanitizeValue(result.structured); result.structured = clean.value; state.safetyFlags.push(...clean.flags) }
            if (attempted > 1 || position !== ordered[0]) state.replacements.push(`${role} 改用 ${row.alias}/${row.provider}：${brief(last)}`)
            persist(); return { result, session: kept }
          }
          last = scan(error?.message ?? "未知错误")
          cache.put(row.provider, row.modelId, brief(last))
          const allowed = parseEffortRejection(last)
          if (attempt === 0 && (allowed || classifyError(last) === "transient")) {
            if (allowed) effort = pickEffort(effort, allowed)
            if (!resume) sessionId = (o.newId ?? randomUUID)()
            await (o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(allowed ? 0 : 2000)
            continue
          }
          break
        }
      }
    }
    handoff(role === "explore" ? "plan" : role === "exec" && state.step === "fix" ? "fix" : role as HandoffType, `${role} 没有可用候选：${brief(last)}`)
  }

  async function structured<T>(role: "plan" | "review", prompt: string, validate: (value: unknown) => T): Promise<T> {
    const schema = role === "plan" ? planSchema : reviewSchema
    let called = await invoke(role, o.config.routing[role].chain, prompt, schema)
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return validate(called.result.structured !== undefined ? called.result.structured : parseContractText(called.result.text, called.session.provider)) }
      catch (error) {
        const message = brief(String(error), 1000)
        write(`${role}-invalid-${state.reviewRound}-${attempt + 1}.txt`, called.result.text)
        if (attempt === 1) {
          if (role === "plan") handoff("plan", `方案两次格式无效：${message}`)
          halt(1, `审查两次格式无效：${message}`)
        }
        called = await invoke(role, o.config.routing[role].chain, `${prompt}\n${correctionPrompt(message)}`, schema, called.session)
      }
    }
    throw new Error("unreachable")
  }
  function scheduleFix(reason: string[]): void {
    if (state.fixes >= o.config.routing.review.maxRounds) halt(1, "修复轮次用完，仍有验收失败或 P1")
    state.fixes++; state.p1 = reason; state.verifiedTree = undefined; state.reviewedTree = undefined; state.checksTree = undefined; state.reviewFamilies = []; state.reviewP1 = []
    step("fix")
  }
  function validateBudgetConfig(): void {
    if (state.budget === undefined || state.maxCalls !== undefined || state.maxMinutes !== undefined) return
    const unpriced = o.config.models.filter((row) => row.price.input == null || row.price.output == null)
    if (unpriced.length) halt(2, `--budget 不覆盖未知金额，须同时给 --max-calls 或 --max-minutes：${unpriced.map((r) => `${r.alias}/${r.provider}`).join(", ")}`)
  }

  let exitCode = 4, reason = "", handoffType: HandoffType | undefined
  try {
    assertWorkersStopped(state.workers); state.workers = []
    for (const [name, schema] of Object.entries(schemas)) write(`${name}.schema.json`, JSON.stringify(schema, null, 2))
    if (o.resume) {
      if (!o.by) throw new Error("continue 必须提供 --by <主会话能力名>")
      state.allow = [...new Set([...state.allow, ...parseAllow(o.allow)])]
      state.execPin = o.execPin ?? state.execPin
      state.budget = o.budget ?? state.budget; state.maxCalls = o.maxCalls ?? state.maxCalls; state.maxMinutes = o.maxMinutes ?? state.maxMinutes
      const pending = state.handoff
      const was = state.current.tree
      capture()
      const changed = was !== state.current.tree
      if (changed || pending?.type === "exec" || pending?.type === "fix") author(o.by)
      if (pending && changed && state.plan && !["exec", "fix", "plan", "permission"].includes(pending.type)) {
        state.verifiedTree = undefined; state.reviewedTree = undefined; state.checksTree = undefined; state.reviewFamilies = []
        step("verify")
      } else if (pending?.type === "plan") {
        try { state.plan = validatePlan(strictJSON(scan(artifact(path.join(o.runDir, "plan.json"))))); write("plan.md", planText()); step("gate") }
        catch (error) { handoff("plan", `交接方案无效：${brief(String(error))}`) }
      } else if (pending?.type === "exec" || pending?.type === "fix") { step("verify") }
      else if (pending?.type === "permission") { state.planOnly = false; step("gate") }
      else if (pending?.type === "review") {
        try {
          state.review = validateReview(strictJSON(scan(artifact(path.join(o.runDir, `review-${state.reviewRound}.json`)))), state.plan!, state.current.tree, outOfScope())
          state.reviewerFamily = familyOf(o.by, o.config.models); state.reviewedTree = state.current.tree
          state.p1 = reviewFindings(state.review).map((f) => `${f.ref}: ${f.issue}`)
          if (state.mode === "review") {
            state.reviewP1.push(...state.p1)
            state.reviewFamilies.push(state.reviewerFamily)
            state.reviewRound++
            if (state.dual && state.reviewFamilies.length < 2) step("review")
            else { state.p1 = [...state.reviewP1]; step("finalize") }
          } else if (state.p1.length) scheduleFix(state.p1)
          else step("check")
        } catch (error) { if (error instanceof Halt) throw error; handoff("review", `交接审查无效：${brief(String(error))}`) }
      } else if (pending?.type === "check") {
        try {
          const checks = validateChecks(strictJSON(scan(artifact(path.join(o.runDir, "checks.json")))), state.plan!, state.current.tree)
          const failed = checks.checks.filter((c) => c.verdict === "fail")
          if (failed.length) scheduleFix(failed.map((c) => `${c.id}: ${c.evidence}`))
          else if (checks.checks.some((c) => c.verdict === "unknown")) halt(5, "人工核验仍有 unknown")
          else { state.checksTree = state.current.tree; step("finalize") }
        } catch (error) { if (error instanceof Halt) throw error; handoff("check", `核验文件无效：${brief(String(error))}`) }
      } else {
        state.status = "running"; state.handoff = undefined
        if (["exec", "fix"].includes(state.step)) state.p1 = ["上次执行被中断。从当前代码继续，不要推倒重来", ...state.p1]
      }
      if (changed && ["plan", "permission", "budget"].includes(pending?.type ?? "")) {
        state.verifiedTree = undefined; state.reviewedTree = undefined; state.checksTree = undefined
      }
    }
    // Permissions are part of session compatibility; recomputed after continue merges allow.
    validateBudgetConfig()
    if (state.mode === "review" && !state.plan) {
      if (state.author) author(state.author)
      state.plan = { exec_type: "standard", criteria: [], allowed_paths: state.paths.length ? state.paths : ["**"], needs_permission: [], steps: ["只读审查"], context: [] }
      state.verifiedTree = state.current.tree
    }
    state.status = "running"; persist()
    while (true) {
      if (interrupting) halt(4, "中断后停止阶段推进")
      switch (state.step) {
        case "explore": {
          try {
            const found = await invoke("explore", o.config.routing.explore.chain, explorePrompt(state.goal))
            write("explore.md", found.result.text)
          } catch (error) {
            if (!(error instanceof Halt) || error.exitCode !== 3 || error.type !== "plan") throw error
            write("explore.md", `探索不可用：${brief(String(error))}。方案阶段只做必要核对。`)
          }
          capture(); step("plan"); break
        }
        case "plan": {
          state.plan = await structured("plan", planPrompt(state.goal, artifact(path.join(o.runDir, "explore.md"))), validatePlan)
          write("plan.json", JSON.stringify(state.plan, null, 2)); write("plan.md", planText())
          capture(); step("gate"); break
        }
        case "gate": {
          const missing = missingPermissions(state.plan!, state.allow)
          if (missing.length) handoff("permission", `需要用户明确授权：${missing.join(", ")}；方案不能代替授权`)
          if (state.planOnly) handoff("permission", "plan-only：方案已完成，尚未执行；明确继续后再 continue")
          step("exec"); break
        }
        case "exec": case "fix": {
          const executed = await invoke("exec", execChain(), state.step === "fix" ? `修复以下问题：${state.p1.join("；")}` : state.p1.length ? state.p1.join("；") : "按方案实施")
          write(`exec-${state.fixes}.txt`, executed.result.text || "无正文；代码是否通过以脚本验收和独立审查为准。")
          capture(); state.reviewFamilies = []; step("verify"); break
        }
        case "verify": {
          capture(); const tree = state.current.tree
          const evidence: { id: string; command: string; tree: string; output: VerificationOutput }[] = []
          let blocked = false
          for (const criterion of state.plan!.criteria.filter((c) => c.kind === "command")) {
            for (const command of criterion.commands!) {
              const remaining = state.maxMinutes === undefined ? Infinity : state.startedAt + state.maxMinutes * 60_000 - Date.now()
              if (remaining <= 0) handoff("budget", "验收前达到 max-minutes")
              const output = o.runCommand ? await o.runCommand(command, state.cwd) : await verifyCommand(command, { cwd: state.cwd, gitDir: workspace.gitDir, tmpDir: commandTmp, allow: state.allow, sensitiveExtra: o.config.safety.sensitiveExtra, sensitivePaths: Object.keys(state.current.sensitive), extraWritable: o.config.safety.extraWritable, verifyEnv: o.config.safety.verifyEnv, timeoutMs: Math.min(o.config.safety.verifyTimeoutMin * 60_000, remaining) }, hooks)
              if (interrupting) halt(4, "验收中断，停止后续命令")
              output.stdout = scan(output.stdout).slice(-4000); output.stderr = scan(output.stderr).slice(-4000); state.safetyFlags.push(...(output.flags ?? []))
              evidence.push({ id: criterion.id, command, tree, output }); blocked ||= output.blocked ?? false
              write("verify.json", JSON.stringify(evidence, null, 2)); write("verify.txt", evidence.map((e) => `${e.id} ${e.command} ${e.output.code === 0 ? "通过" : "失败"}（快照 ${e.tree}）\n${e.output.stdout}\n${e.output.stderr}`).join("\n\n"))
            }
          }
          capture()
          if (blocked) halt(5, "验收受安全规则或沙箱可用性阻挡，未作为代码失败处理；见 verify.txt")
          if (tree !== state.current.tree) { author("unknown-external"); halt(5, "验收期间工作区变化，证据快照已失效；请检查命令副作用") }
          const failed = evidence.filter((e) => e.output.code !== 0)
          if (failed.length) { scheduleFix(failed.map((e) => `${e.command} exit=${e.output.code}\n${e.output.stdout}\n${e.output.stderr}`)); break }
          state.verifiedTree = tree; state.reviewFamilies = []; step("review"); break
        }
        case "review": {
          const patch = diff(), tree = state.current.tree
          const before = tree
          state.review = await structured("review", reviewPrompt(state.goal, planText(), patch, tree, outOfScope(), state.p1), (v) => validateReview(v, state.plan!, tree, outOfScope()))
          state.reviewerFamily = familyOf(state.selected.review ?? "unknown", o.config.models)
          state.reviewedTree = tree
          state.p1 = reviewFindings(state.review).map((f) => `${f.ref}: ${f.issue}`)
          write(`review-${state.reviewRound}.json`, JSON.stringify(state.review, null, 2))
          capture()
          if (before !== state.current.tree) { author(state.selected.review ?? "unknown"); state.safetyFlags.push("只读审查期间工作区被修改"); halt(5, "只读审查期间发生写入，停止推进") }
          state.reviewRound++
          if (state.mode === "review") {
            state.reviewP1.push(...state.p1)
            state.reviewFamilies.push(state.reviewerFamily)
            if (state.dual && state.reviewFamilies.length < 2) { state.review = undefined; step("review"); break }
            state.p1 = state.reviewP1
            step("finalize"); break
          }
          if (state.p1.length) { scheduleFix(state.p1); break }
          step("check"); break
        }
        case "check": {
          if (state.plan!.criteria.some((c) => c.kind === "check") && state.checksTree !== state.current.tree) handoff("check", `请逐条人工核验，写 checks.json，checked_tree=${state.current.tree}`)
          step("finalize"); break
        }
        case "finalize": {
          capture()
          if (state.mode === "review") {
            if (state.reviewedTree !== state.current.tree) halt(5, "只读审查快照过期")
            if (state.reviewFamilies.some((f) => !independent(f, state.authors)) || (state.dual && new Set(state.reviewFamilies).size < 2)) halt(5, "只读审查独立性不足")
            if (state.p1.length) halt(1, "只读审查发现 P1，未自动修改文件")
          } else {
            if (!state.plan || !state.review || state.verifiedTree !== state.current.tree || state.reviewedTree !== state.current.tree) halt(5, "最终验收、审查与当前快照不一致")
            if (state.plan.criteria.some((c) => c.kind === "check") && state.checksTree !== state.current.tree) halt(5, "缺少最终快照的人工核验证据")
            if (!independent(state.reviewerFamily ?? "unknown", state.authors)) halt(5, "审查独立性不足")
            if (state.p1.length) halt(1, "存在未关闭 P1")
          }
          const changedDeps = scopePaths().filter(dependencyPath)
          if (changedDeps.length && !state.allow.includes("deps") && state.mode === "run") state.safetyFlags.push(`依赖清单/锁文件变动未授权：${changedDeps.join(", ")}`)
          if (state.safetyFlags.length) halt(5, "存在未处理安全标记")
          halt(0, state.mode === "review" ? "只读审查完成（不是代码交付声明）" : "所有完成标准与最终快照证据一致")
        }
      }
    }
  } catch (error) {
    if (error instanceof Halt) { exitCode = error.exitCode; reason = error.message; handoffType = error.type }
    else { exitCode = 4; reason = scan(String(error)) }
    state.status = exitCode === 3 ? "waiting" : exitCode === 4 ? "interrupted" : "done"
    if (handoffType) state.handoff = { type: handoffType, reason, tree: state.current.tree }
    persist()
  } finally { process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal) }

  const names = ["完成", "卡住", "用法或配置错误", "交给主会话", "中断", "待验证"]
  const known = state.calls.reduce((sum, c) => sum + (c.usage.costUsd ?? 0), 0)
  const unknown = state.calls.filter((c) => c.usage.costUsd == null).length
  const opus = o.config.models.find((r) => r.alias === "opus-5.5")?.price
  const opusParts = opus ? state.calls.map((c) => costFromPrice(c.usage, opus)) : []
  const opusTotal = opusParts.length && opusParts.every((n) => n != null) ? opusParts.reduce<number>((s, n) => s + n!, 0) : null
  let files: string[] = []
  try { files = scopePaths() } catch { /* Preserve the last evidence even when git fails. */ }
  const byRole = ["explore", "plan", "exec", "review"].map((role) => {
    const calls = state.calls.filter((c) => c.role === role)
    return calls.length ? `${role} $${calls.reduce((s, c) => s + (c.usage.costUsd ?? 0), 0).toFixed(4)}${calls.some((c) => c.costSource === "price") ? "（含估算）" : ""}` : ""
  }).filter(Boolean).join(" · ")
  const schema = handoffType === "plan" ? "plan" : handoffType === "review" ? "review" : handoffType === "check" ? "checks" : undefined
  const target = handoffType === "review" ? `review-${state.reviewRound}.json` : handoffType === "plan" ? "plan.json" : handoffType === "check" ? "checks.json" : "plan.md / verify.txt / 最新 review-N.json"
  const next = handoffType ? `只做 ${handoffType}：${reason}；文件 ${path.join(o.runDir, target)}${schema ? `；schema ${path.join(o.runDir, `${schema}.schema.json`)}` : ""}；之后 bun ${JSON.stringify(path.join(import.meta.dir, "orch.ts"))} continue --run ${JSON.stringify(o.runDir)} --by <主会话能力名>${handoffType === "permission" ? " [--allow 用户批准的类别]" : handoffType === "budget" ? " [新的 --budget/--max-calls/--max-minutes]" : ""}` : exitCode === 4 ? `确认旧 worker 停止后 continue --run ${JSON.stringify(o.runDir)} --by <主会话能力名>` : reason
  const summary = scan([
    `结论：${names[exitCode]}${state.mode === "review" ? "（只读审查）" : ""}`,
    `阵容：${["plan", "exec", "review"].map((r) => `${r} ${state.selected[r as Role] ?? "主会话/无"}`).join(" · ")}（替换/跳过 ${state.replacements.length} 项，见 routing-log.json）`,
    `改动：${files.length} 个文件 ${files.slice(0, 12).join(", ")}${files.length > 12 ? "…" : ""}；与已有修改重叠 ${files.filter((f) => state.baseline.preexisting.includes(f)).length} 个`,
    `完成标准：命令 ${state.verifiedTree ? "已复核" : "未复核"}；人工核验 ${state.checksTree ? "有证据" : "无/未做"}；最终快照 ${state.current.tree.slice(0, 12)}`,
    `审查：修复 ${state.fixes} 轮；P1 未关闭 ${state.p1.length}；P2 ${state.review?.p2.length ?? 0}${state.mode === "review" && !state.author ? "；未提供 author，没有作者独立性保证" : ""}`,
    `安全：${state.safetyFlags.length ? state.safetyFlags.map((s) => brief(s, 90)).slice(0, 5).join("；") : "无标记"}`,
    `边界：unsafe_read=${o.config.safety.unsafeRead.join(",") || "无"}；unsafe_exec=${o.config.safety.unsafeExec.join(",") || "无"}${o.config.safety.unsafeRead.length || o.config.safety.unsafeExec.length ? "（显式例外，外壳隔离未验证）" : ""}；${state.allow.includes("network:*") ? "网络获准全出站，发布/推送剩下授权和凭证约束，不保证物理隔离" : state.allow.some((a) => a.startsWith("network:")) ? "仅域名联网授权；验收沙箱及未实测层仍禁网" : "网络未授权"}`,
    `账单：${byRole || "无调用"} · 合计 ${unknown ? "≥ " : ""}$${known.toFixed(4)}（${unknown} 次未报价；CLI 报价/价格估算，非账单）${opusTotal == null ? "" : `；本次 token 按 opus 单价重算约 $${opusTotal.toFixed(4)}（估算）`}`,
    `下一步：${next}`,
    `记录：${o.runDir}（summary.md · plan.md · review-N.json · verify.txt · usage.jsonl）`,
    ...(o.config.usingSample ? ["配置：使用 skill 示例，未宣称本机路由已验证"] : []),
  ].map((line) => line.replace(/[\r\n]+/g, " ")).join("\n"))
  write("routing-log.json", JSON.stringify([...new Set(state.replacements)], null, 2)); write("summary.md", summary); persist()
  if (state.status === "done" && state.workers.length === 0) rmSync(commandTmp, { recursive: true, force: true })
  return { ok: exitCode === 0, exitCode, summary, runDir: o.runDir }
}

export async function continueFlow(options: FlowOptions): Promise<FlowOutcome> {
  if (!options.by) throw new Error("continue 必须提供 --by <主会话能力名>")
  const saved = strictJSON(artifact(path.join(options.runDir, "state.json"))) as SavedState
  if (saved.status === "done") throw new Error("这次运行已终止，没有待续步骤；请新开运行")
  return runFlow({ ...options, cwd: saved.cwd, goal: saved.goal, execPin: options.execPin ?? saved.execPin, resume: saved })
}
