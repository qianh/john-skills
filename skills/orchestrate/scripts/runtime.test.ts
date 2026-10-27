import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import path from "node:path"
import { acquireLock, assertWorkersStopped, runProcess, UnavailableCache, workerStatus, type Worker } from "./runtime.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "orch-runtime-test-"))
  roots.push(root)
  const lock = path.join(root, "lock")
  return { root, lock }
}

function staleLock(root: string, lock: string, workers: Worker[] = []) {
  writeFileSync(path.join(root, "state.json"), JSON.stringify({ workers }))
  writeFileSync(lock, JSON.stringify({ pid: 999_999_999, host: hostname(), startTime: "old owner", runDir: root }))
}

async function liveWorker(root: string) {
  let ready!: (worker: Worker) => void
  let failed!: (error: unknown) => void
  const started = new Promise<Worker>((resolve, reject) => { ready = resolve; failed = reject })
  const result = runProcess(["/bin/sleep", "30"], { cwd: root, role: "test", timeoutMs: 35_000, onStart: ready })
  void result.catch(failed)
  const worker = await started
  return { worker, result, async cleanup() {
    try { process.kill(-worker.pgid, "SIGKILL") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    await result
  } }
}

function alive(pid: number): boolean {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" })
  return result.status === 0 && !!result.stdout.trim() && !result.stdout.trim().startsWith("Z")
}

test("exec changing the group leader command never proves that the worker stopped", async () => {
  let worker: Worker | undefined
  const pending = runProcess(["/bin/sh", "-c", "sleep 0.3; exec sleep 3"], { cwd: tmpdir(), role: "audit", timeoutMs: 6000, onStart: (started) => { worker = started } })
  try {
    await new Promise((resolve) => setTimeout(resolve, 650))
    expect(worker).toBeDefined()
    expect(workerStatus(worker!)).not.toBe("stopped")
    expect(() => assertWorkersStopped([worker!])).toThrow()
  } finally {
    if (worker) {
      try { process.kill(-worker.pgid, "SIGKILL") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    }
    await pending
  }
})

test("a live lock owner is rejected without changing its lock", () => {
  const { root, lock } = fixture()
  const release = acquireLock(lock, root)
  try {
    const before = readFileSync(lock, "utf8")
    expect(() => acquireLock(lock, root)).toThrow("运行仍在进行")
    expect(readFileSync(lock, "utf8")).toBe(before)
    expect(existsSync(`${lock}.reclaim`)).toBe(false)
  } finally { release() }
  expect(existsSync(lock)).toBe(false)
})

test("a dead owner with an empty worker list can be reclaimed", () => {
  const { root, lock } = fixture()
  staleLock(root, lock)
  const release = acquireLock(lock, root)
  try {
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid)
    expect(existsSync(`${lock}.reclaim`)).toBe(false)
  } finally { release() }
  expect(existsSync(lock)).toBe(false)
})

test("a dead owner with a live recorded worker cannot be reclaimed", async () => {
  const { root, lock } = fixture()
  const active = await liveWorker(root)
  try {
    staleLock(root, lock, [active.worker])
    const before = readFileSync(lock, "utf8")
    expect(workerStatus(active.worker)).toBe("running")
    expect(() => acquireLock(lock, root)).toThrow("旧 worker")
    expect(readFileSync(lock, "utf8")).toBe(before)
    expect(alive(active.worker.pid)).toBe(true)
    expect(existsSync(`${lock}.reclaim`)).toBe(false)
  } finally { await active.cleanup() }
})

test("a mismatched start time proves PID reuse, not ownership of the current process", async () => {
  const { root, lock } = fixture()
  const active = await liveWorker(root)
  try {
    const reused = { ...active.worker, startTime: "different process start time" }
    expect(workerStatus(reused)).toBe("stopped")
    expect(() => assertWorkersStopped([reused])).not.toThrow()
    expect(alive(active.worker.pid)).toBe(true)
    staleLock(root, lock)
    writeFileSync(lock, JSON.stringify({ pid: active.worker.pid, host: hostname(), startTime: reused.startTime, runDir: root }))
    const release = acquireLock(lock, root)
    try { expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid) }
    finally { release() }
    expect(alive(active.worker.pid)).toBe(true)
  } finally { await active.cleanup() }
})

test("an in-progress reclaim blocks contenders before they can unlink a stale lock", () => {
  const { root, lock } = fixture()
  staleLock(root, lock)
  const before = readFileSync(lock, "utf8")
  writeFileSync(`${lock}.reclaim`, JSON.stringify({ pid: process.pid, host: hostname() }))
  expect(() => acquireLock(lock, root)).toThrow("接管")
  expect(readFileSync(lock, "utf8")).toBe(before)
  expect(existsSync(`${lock}.reclaim`)).toBe(true)
})

test("unavailable cache expires entries after 24 hours and ignores invalid records", () => {
  const { root } = fixture()
  const file = path.join(root, "cache.json")
  const now = Date.now()
  writeFileSync(file, JSON.stringify({
    ["grok\0expired"]: { at: now - 86_400_001, reason: "model_not_found" },
    ["grok\0recent"]: { at: now - 1000, reason: "model_not_found" },
    ["grok\0invalid"]: { at: "not a timestamp", reason: "model_not_found" },
  }))
  const cache = new UnavailableCache(file)
  expect(cache.get("grok", "expired")).toBeUndefined()
  expect(cache.get("grok", "invalid")).toBeUndefined()
  expect(cache.get("grok", "recent")?.reason).toBe("model_not_found")
  expect(cache.get("claude", "recent")).toBeUndefined()
})

test("a corrupt unavailable cache can be rebuilt without caching transient failures", () => {
  const { root } = fixture()
  const file = path.join(root, "cache.json")
  writeFileSync(file, "{broken JSON")
  const cache = new UnavailableCache(file)
  expect(cache.get("grok", "model")).toBeUndefined()
  cache.put("grok", "temporary", "503 overloaded")
  expect(cache.get("grok", "temporary")).toBeUndefined()
  cache.put("grok", "model", "model_not_found")
  expect(cache.get("grok", "model")?.reason).toBe("model_not_found")
  expect(new UnavailableCache(file).get("grok", "model")?.reason).toBe("model_not_found")
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["grok\0model"])
})

test("timeout terminates both the shell and its child in the detached process group", async () => {
  const { root } = fixture()
  const childFile = path.join(root, "child-pid")
  let worker: Worker | undefined
  try {
    const result = await runProcess(["/bin/sh", "-c", `sleep 30 & echo $! > ${JSON.stringify(childFile)}; wait`], { cwd: root, role: "timeout-test", timeoutMs: 400, onStart: (started) => { worker = started } })
    expect(result.timedOut).toBe(true)
    expect(result.code).toBe(124)
    expect(worker).toBeDefined()
    const child = Number(readFileSync(childFile, "utf8").trim())
    expect(child).toBeGreaterThan(0)
    for (let i = 0; i < 20 && (alive(worker!.pid) || alive(child)); i++) await delay(50)
    expect(alive(worker!.pid)).toBe(false)
    expect(alive(child)).toBe(false)
    expect(workerStatus(worker!)).toBe("stopped")
  } finally {
    if (worker) {
      try { process.kill(-worker.pgid, "SIGKILL") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    }
  }
})
