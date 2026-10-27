import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import path from "node:path"

export function atomicWrite(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, file)
}
export function atomicJSON(file: string, value: unknown): void { atomicWrite(file, JSON.stringify(value, null, 2) + "\n") }

export interface Worker { pid: number; pgid: number; startTime: string; command: string; role: string }
interface ProcessInfo { pid: number; pgid: number; startTime: string; command: string }

function processTable(): ProcessInfo[] {
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,lstart=,comm="], { encoding: "utf8" })
  if (result.status !== 0 || result.error) throw new Error("无法确认旧 worker 身份：ps 失败，拒绝恢复")
  return result.stdout.split("\n").flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/)
    return m ? [{ pid: Number(m[1]), pgid: Number(m[2]), startTime: m[3].replace(/\s+/g, " "), command: path.basename(m[4]) }] : []
  })
}
export function workerStatus(worker: Worker): "running" | "stopped" | "uncertain" {
  if (!worker.pid || !worker.pgid || !worker.startTime || !worker.command) return "uncertain"
  const table = processTable()
  const leader = table.find((p) => p.pid === worker.pid)
  if (leader && leader.startTime !== worker.startTime) return "stopped"
  if (leader && (leader.command !== worker.command || leader.pgid !== worker.pgid)) return "uncertain"
  if (table.some((p) => p.pgid === worker.pgid)) return "running"
  return "stopped"
}
export function assertWorkersStopped(workers: Worker[]): void {
  for (const worker of workers) {
    if (workerStatus(worker) !== "stopped") throw new Error(`旧 worker ${worker.pid} 尚在运行或无法核实；先运行 orch.ts stop --run <目录>`)
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export async function stopWorkers(workers: Worker[]): Promise<void> {
  for (const worker of workers) {
    const status = workerStatus(worker)
    if (status === "stopped") continue
    const leader = processTable().find((p) => p.pid === worker.pid)
    if (!leader || status === "uncertain" || leader.startTime !== worker.startTime || leader.command !== worker.command) throw new Error(`无法核实进程组 ${worker.pgid} 的组长，不发送信号；请人工核查`)
    try { process.kill(-worker.pgid, "SIGTERM") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    for (let i = 0; i < 20 && workerStatus(worker) === "running"; i++) await delay(100)
    if (workerStatus(worker) === "running") {
      // The group was identified before TERM; a surviving child keeps its group identity.
      try { process.kill(-worker.pgid, "SIGKILL") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    }
  }
}

export interface ProcessResult { code: number; stdout: string; stderr: string; timedOut: boolean; notSent?: boolean; outputTruncated?: boolean }
export interface WorkerHooks { onStart?: (worker: Worker) => void; onEnd?: (worker: Worker) => void }

export function runProcess(argv: string[], options: { cwd: string; env?: Record<string, string>; timeoutMs: number; role: string } & WorkerHooks): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = "", timedOut = false, worker: Worker | undefined, settled = false, outputTruncated = false
    // Discard oversized streams, rather than exposing a secret whose header got cropped.
    const append = (old: string, chunk: Buffer) => {
      if (outputTruncated) return "[output exceeded limit; discarded]"
      if (old.length + chunk.length > 8_000_000) { outputTruncated = true; stdout = ""; stderr = ""; return "[output exceeded limit; discarded]" }
      return old + chunk.toString()
    }
    proc.stdout.on("data", (chunk) => { stdout = append(stdout, chunk) })
    proc.stderr.on("data", (chunk) => { stderr = append(stderr, chunk) })
    const killGroup = () => { if (proc.pid) { try { process.kill(-proc.pid, "SIGKILL") } catch {} } }
    const timer = setTimeout(() => { timedOut = true; killGroup() }, options.timeoutMs)
    proc.once("spawn", () => {
      try {
        const table = processTable()
        const info = table.find((p) => p.pid === proc.pid)
        // A very short, already-exited process needs no resumable worker record.
        if (!info && !table.some((p) => p.pgid === proc.pid)) return
        if (!info) { killGroup(); throw new Error("worker 身份未能持久化，已停止") }
        worker = { ...info, role: options.role }
        options.onStart?.(worker)
      } catch (error) { killGroup(); clearTimeout(timer); settled = true; reject(error) }
    })
    proc.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (error.code === "ENOENT" || error.code === "EACCES") resolve({ code: 127, stdout, stderr: error.message, timedOut: false, notSent: true })
      else reject(error)
    })
    proc.once("close", (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      try {
        if (worker && workerStatus(worker) !== "stopped") {
          // A shell may exit while children still hold pipes or keep writing files.
          killGroup()
          throw new Error(`worker ${worker.pid} 退出后进程组仍存活，已终止；需要恢复核查`)
        }
        if (worker) options.onEnd?.(worker)
        resolve({ code: timedOut ? 124 : code ?? 1, stdout, stderr, timedOut, outputTruncated })
      } catch (error) { reject(error) }
    })
  })
}

interface LockOwner { pid: number; host: string; startTime: string; runDir: string }
export function acquireLock(file: string, runDir: string, allowLiveWorkers = false): () => void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const reclaim = `${file}.reclaim`
  try { writeFileSync(reclaim, JSON.stringify({ pid: process.pid, host: hostname() }), { flag: "wx", mode: 0o600 }) }
  catch { throw new Error(`另一进程正在加锁/接管，或上次接管中断；核实无接管进程后人工移除：${reclaim}`) }
  try {
  const identity = processTable().find((p) => p.pid === process.pid)
  if (!identity) throw new Error("无法取得主进程身份")
  const mine: LockOwner = { pid: process.pid, host: hostname(), startTime: identity.startTime, runDir }
  if (existsSync(file)) {
    let owner: LockOwner
    try { owner = JSON.parse(readFileSync(file, "utf8")) } catch { throw new Error(`锁无法解析，拒绝接管：${file}`) }
    if (owner.host !== hostname()) throw new Error(`锁来自另一主机；确认该主机和 worker 停止后人工移除：${file}`)
    const current = processTable().find((p) => p.pid === owner.pid)
    if (current?.startTime === owner.startTime) throw new Error(`运行仍在进行（pid ${owner.pid}）：${owner.runDir}`)
    const stateFile = path.join(owner.runDir, "state.json")
    if (!existsSync(stateFile)) throw new Error(`旧锁没有 worker 记录，拒绝接管：${file}`)
    const state = JSON.parse(readFileSync(stateFile, "utf8"))
    if (!Array.isArray(state.workers)) throw new Error("旧状态缺少 worker 记录，拒绝接管")
    if (!allowLiveWorkers) assertWorkersStopped(state.workers)
    unlinkSync(file)
  }
  writeFileSync(file, JSON.stringify(mine), { flag: "wx", mode: 0o600 })
  return () => {
    if (!existsSync(file)) return
    const owner = JSON.parse(readFileSync(file, "utf8")) as LockOwner
    if (owner.pid === mine.pid && owner.startTime === mine.startTime) unlinkSync(file)
  }
  } finally { unlinkSync(reclaim) }
}

export class UnavailableCache {
  readonly file: string
  private entries: Record<string, { at: number; reason: string }> = {}
  constructor(file = path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "orchestrate/unavailable.json")) {
    this.file = file
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"))
      if (raw && typeof raw === "object" && !Array.isArray(raw)) this.entries = raw
    } catch { /* A corrupt cache cannot block routing. */ }
  }
  get(provider: string, model: string): { at: number; reason: string } | undefined {
    const item = this.entries[`${provider}\0${model}`]
    return item && typeof item.at === "number" && typeof item.reason === "string" && Date.now() - item.at < 86_400_000 ? item : undefined
  }
  put(provider: string, model: string, reason: string): void {
    if (!/model_not_found|model.{0,30}(?:not supported|unsupported|not found|not available)|(?:not authorized|no access|permission denied).{0,30}model/i.test(reason)) return
    this.entries[`${provider}\0${model}`] = { at: Date.now(), reason: reason.slice(0, 200) }
    atomicJSON(this.file, this.entries)
  }
}
