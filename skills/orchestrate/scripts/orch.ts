import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { loadConfig, resolveConfigDir, validateExecPin } from "./config.ts"
import { strictJSON } from "./contracts.ts"
import { DirectoryWorkspace } from "./directory-workspace.ts"
import { continueFlow, runFlow, type FlowOptions, type SavedState } from "./flow.ts"
import { detectHosts } from "./preflight.ts"
import { acquireLock, atomicJSON, stopWorkers } from "./runtime.ts"
import { sanitizeValue, scanText } from "./safety.ts"
import { parseAllow } from "./sandbox.ts"
import { SnapshotManager } from "./snapshot.ts"

interface Args { command: string; goal: string; values: Record<string, string[]>; flags: Set<string> }
const values = new Set(["cwd", "exec", "allow", "budget", "max-calls", "max-minutes", "run", "by", "base", "paths", "author", "root", "mode"])
const flags = new Set(["sample", "plan-only", "dual", "help"])
export function parseArgs(argv: string[]): Args {
  const result: Args = { command: argv[0] ?? "help", goal: "", values: {}, flags: new Set() }
  const goals: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const item = argv[i]
    if (item === "--") { goals.push(...argv.slice(i + 1)); break }
    if (!item.startsWith("--")) { goals.push(item); continue }
    const key = item.slice(2)
    if (flags.has(key)) { result.flags.add(key); continue }
    if (!values.has(key)) throw new Error(`未知参数：${item}`)
    const value = argv[++i]
    if (!value || value.startsWith("--")) throw new Error(`${item} 缺少值`)
    if (result.values[key] && !["allow", "paths"].includes(key)) throw new Error(`${item} 不能重复`)
    ;(result.values[key] ??= []).push(value)
  }
  result.goal = goals.join(" ").trim()
  return result
}
function value(args: Args, name: string): string | undefined { return args.values[name]?.[0] }
function routingMode(args: Args): "simple" | "dynamic" {
  const raw = value(args, "mode") ?? process.env.ORCHESTRATE_MODE ?? "simple"
  if (raw !== "simple" && raw !== "dynamic") throw new Error(`--mode / ORCHESTRATE_MODE 只能是 simple 或 dynamic，收到：${raw}`)
  return raw
}
function number(args: Args, name: string, integer = false): number | undefined {
  const raw = value(args, name)
  if (raw === undefined) return undefined
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0 || (integer && !Number.isInteger(num))) throw new Error(`--${name} 必须为正${integer ? "整数" : "数"}`)
  return num
}
function gitDir(cwd: string): string | null {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete (env as NodeJS.ProcessEnv)[key]
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", "rev-parse", "--absolute-git-dir"], { cwd, env, encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : null
}
function stateAt(runDir: string): SavedState {
  const file = path.join(runDir, "state.json")
  const state = strictJSON(readFileSync(file, "utf8")) as SavedState
  if (state.version !== 2 || !state.cwd || !Array.isArray(state.workers)) throw new Error("运行状态不兼容或损坏")
  return state
}
function status(runDir: string): void {
  const state = stateAt(runDir)
  console.log(scanText(`状态：${state.status}\n阶段：${state.step}；修复 ${state.fixes} 轮；已用 ${((Date.now() - state.startedAt) / 60_000).toFixed(1)} 分钟\n调用：${state.calls.length} 次；worker ${state.workers.length} 个\n进度：${state.lastLog}\n记录：${runDir}`).text)
}
async function withLocks<T>(runDir: string, worktree: string | null, action: () => Promise<T>, stopping = false): Promise<T> {
  const releaseRun = acquireLock(path.join(runDir, "lock"), runDir, stopping)
  let releaseWork: (() => void) | undefined
  const release = () => { releaseWork?.(); releaseRun() }
  try {
    if (worktree) releaseWork = acquireLock(path.join(worktree, "orchestrate", "worktree.lock"), runDir)
    process.once("exit", release)
    return await action()
  } finally { process.removeListener("exit", release); release() }
}
export function report(root: string): string {
  const rows: Record<string, { calls: number; failed: number; known: number; priced: number; unknown: number }> = {}
  let runs = 0, fixes = 0, unreadable = 0, unknownRounds = 0
  if (!existsSync(root)) return "账本：没有运行记录"
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    try {
      const dir = path.join(root, entry.name)
      const calls = readFileSync(path.join(dir, "usage.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => strictJSON(line) as SavedState["calls"][number])
      if (calls.some((call) => !call.role || !call.alias || !call.usage || (call.usage.costUsd != null && (!Number.isFinite(call.usage.costUsd) || call.usage.costUsd < 0)))) throw new Error("invalid ledger")
      runs++
      try { fixes += stateAt(dir).fixes } catch { unknownRounds++ }
      for (const call of calls) {
        const key = `${call.role}/${call.alias}`
        const row = rows[key] ??= { calls: 0, failed: 0, known: 0, priced: 0, unknown: 0 }
        row.calls++; row.failed += call.result ? call.result === "ok" ? 0 : 1 : call.error ? 1 : 0
        if (call.usage.costUsd == null) row.unknown++
        else { row.known += call.usage.costUsd; row.priced++ }
      }
    } catch { unreadable++ }
  }
  return scanText([`账本：${runs} 次运行；修复 ${fixes} 轮（${unknownRounds} 次轮数未知，${unreadable} 份账本无法读取）`, ...Object.entries(rows).map(([key, row]) => `${key}：${row.calls} 次，失败率 ${(100 * row.failed / row.calls).toFixed(1)}%，已知金额 ${row.unknown ? "≥ " : ""}$${row.known.toFixed(4)}，已报价调用均价 ${row.priced ? `$${(row.known / row.priced).toFixed(4)}` : "未知"}，未报价 ${row.unknown} 次`)].join("\n")).text
}
const USAGE = `用法：
  orch.ts run --mode dynamic [--cwd DIR] [--exec 能力] [--plan-only] [--allow 类别,...] [--budget USD --max-calls N] "目标"
  orch.ts review --mode dynamic [--base REF] [--paths GLOB] [--author 能力] [--dual] "目标"
  orch.ts continue --mode dynamic --run DIR --by 能力 [--allow 用户批准的类别] [预算上限]
  orch.ts status --run DIR | stop --run DIR | report [--root DIR] | preflight
默认模式是 simple；本脚本只有显式 dynamic 或 ORCHESTRATE_MODE=dynamic 才会调用外部 worker。默认严格隔离；未实测的路由不自动调用。--sample 显式使用示例配置。`
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)
  const mode = routingMode(args)
  if (args.command === "help" || args.flags.has("help")) { console.log(USAGE); return 0 }
  if (args.command === "preflight") {
    for (const host of await detectHosts()) console.log(`${host.provider}\t${host.installed ? "已安装" : "未安装"}\t${host.loggedIn ? "已登录" : "未登录"}`)
    return 0
  }
  const runArg = value(args, "run")
  if (["status", "stop", "continue"].includes(args.command) && !runArg) throw new Error(`${args.command} 必须提供 --run DIR`)
  if (args.command === "status") { status(path.resolve(runArg!)); return 0 }
  if (args.command === "stop") {
    const runDir = path.resolve(runArg!)
    await withLocks(runDir, null, async () => {
      const state = stateAt(runDir)
      await stopWorkers(state.workers)
      state.status = "interrupted"; state.updatedAt = Date.now(); state.lastLog = "显式 stop 已停止记录在案的 worker"
      atomicJSON(path.join(runDir, "state.json"), sanitizeValue(state).value)
    }, true)
    console.log("状态：已停止记录在案的 worker；可 continue --mode dynamic --run <目录> --by <能力名>")
    return 4
  }
  const cwd = path.resolve(value(args, "cwd") ?? process.cwd()), dir = gitDir(cwd)
  if (args.command === "report") { console.log(report(path.resolve(value(args, "root") ?? (dir ? path.join(dir, "orchestrate") : path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local/state"), "orchestrate"))))); return 0 }
  if (!["run", "review", "continue"].includes(args.command)) throw new Error(USAGE)
  if (args.command === "continue" && !value(args, "by")) throw new Error("continue 必须提供 --by <主会话能力名>")
  if (args.command !== "continue" && !args.goal) throw new Error("缺少目标")
  if (["run", "review"].includes(args.command) && mode === "simple") {
    console.log("模式：simple（由当前主控模型完成，不启动动态路由）；不要运行 orch.ts，请回到主控会话继续任务。")
    return 3
  }
  if (args.command === "continue" && mode !== "dynamic") throw new Error("continue 动态运行必须显式使用 --mode dynamic")
  const config = loadConfig(resolveConfigDir(args.flags.has("sample")))
  validateExecPin(value(args, "exec"), config)
  const allow = parseAllow(args.values.allow)
  const budget = number(args, "budget"), maxCalls = number(args, "max-calls", true), maxMinutes = number(args, "max-minutes")
  const saved = args.command === "continue" ? stateAt(path.resolve(runArg!)) : undefined
  const targetCwd = saved?.cwd ?? cwd, actualGit = gitDir(targetCwd)
  const reviewOnly = saved ? saved.mode === "review" : args.command === "review"
  if (!actualGit && !reviewOnly) throw new Error("会改代码的运行必须位于 Git 仓库")
  const runDir = saved ? path.resolve(runArg!) : path.join(actualGit ? path.join(actualGit, "orchestrate") : path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local/state"), "orchestrate"), `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`)
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const workspace = actualGit ? new SnapshotManager(targetCwd, runDir, { sensitiveExtra: config.safety.sensitiveExtra }) : new DirectoryWorkspace(targetCwd, runDir, config.safety.sensitiveExtra)
  const hosts = await detectHosts()
  return withLocks(runDir, reviewOnly ? null : actualGit, async () => {
    const options: FlowOptions = { cwd: targetCwd, goal: args.goal, runDir, config, hosts, workspace, execPin: value(args, "exec"), allow, planOnly: args.flags.has("plan-only"), budget, maxCalls, maxMinutes, mode: reviewOnly ? "review" : "run", dual: args.flags.has("dual"), author: value(args, "author"), base: value(args, "base"), paths: args.values.paths, by: value(args, "by"), log: (line) => console.error(line) }
    const outcome = saved ? await continueFlow(options) : await runFlow(options)
    console.log(outcome.summary)
    return outcome.exitCode
  })
}
if (import.meta.main) {
  try { process.exitCode = await main() }
  catch (error) { console.error(scanText(`错误：${(error as Error).message}`).text); process.exitCode = 2 }
}
