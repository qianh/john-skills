import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { cliProvider } from "./cli-provider.ts"
import { ProviderOutputError, unknownUsage, type StageRequest } from "./providers/types.ts"
import type { Worker } from "./runtime.ts"

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "orch-fake-cli-"))
  temporary.push(dir)
  const bin = path.join(dir, "bin")
  mkdirSync(bin)
  const request: StageRequest = {
    provider: "claude", role: "plan", model: "fixture-model", effort: "low",
    prompt: "local fixture only", cwd: dir, timeoutMs: 3000, env: { PATH: bin },
  }
  return {
    request,
    stub(body: string, executable = true) {
      // 独占 PATH，任何测试都不可能落到本机真实的 provider。
      writeFileSync(path.join(bin, "claude"), `#!/bin/sh\n${body}\n`, { mode: executable ? 0o755 : 0o644 })
    },
  }
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const result = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: "result", subtype: "success", result: "fixture reply", session_id: "fixture-session",
  total_cost_usd: 0.12,
  usage: { input_tokens: 25, output_tokens: 8, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
  ...over,
})

async function rejected(request: StageRequest): Promise<ProviderOutputError & { notSent?: boolean; timedOut?: boolean }> {
  try { await cliProvider().run(request) }
  catch (error) {
    expect(error).toBeInstanceOf(ProviderOutputError)
    return error as ProviderOutputError & { notSent?: boolean; timedOut?: boolean }
  }
  throw new Error("fake CLI should have failed")
}

describe("cli-provider local process integration", () => {
  test("missing and nonexecutable CLI are proven notSent, not a fabricated quote", async () => {
    const missing = fixture()
    const absent = await rejected(missing.request)
    expect(absent.notSent).toBe(true)
    expect(absent.timedOut).toBe(false)
    expect(absent.result.usage).toEqual(unknownUsage())

    const inaccessible = fixture()
    inaccessible.stub("exit 0", false)
    const denied = await rejected(inaccessible.request)
    expect(denied.notSent).toBe(true)
    expect(denied.result.usage.costUsd).toBeNull()
  })

  test("command construction failure never launches a worker", async () => {
    const f = fixture()
    let started = false
    let failure: ProviderOutputError & { notSent?: boolean } | undefined
    try {
      await cliProvider({ onStart: () => { started = true } }).run({ ...f.request, provider: "pi", role: "exec" })
    } catch (error) { failure = error as typeof failure }
    expect(failure).toBeInstanceOf(ProviderOutputError)
    expect(failure?.notSent).toBe(true)
    expect(started).toBe(false)
  })

  test("nonzero exit preserves reported usage and tool error text does not prove notSent", async () => {
    const f = fixture()
    f.stub(`/bin/sleep 0.1\nprintf '%s\\n' ${quote(result())}\nprintf '%s\\n' 'unknown option from a fixture tool' >&2\nexit 7`)
    const error = await rejected(f.request)
    expect(error.result.usage).toMatchObject({ input: 25, output: 8, cacheRead: 5, costUsd: 0.12 })
    expect(error.result.sessionId).toBe("fixture-session")
    expect(error.notSent).not.toBe(true)
    expect(error.timedOut).toBe(false)
    expect(error.message).toContain("unknown option")
  })

  test("provider error with exit zero retains its partial usage", async () => {
    const f = fixture()
    f.stub(`/bin/sleep 0.1\nprintf '%s\\n' ${quote(result({ is_error: true, result: "fixture model failure" }))}`)
    const error = await rejected(f.request)
    expect(error.message).toContain("fixture model failure")
    expect(error.result.usage.input).toBe(25)
    expect(error.result.usage.costUsd).toBe(0.12)
    expect(error.notSent).not.toBe(true)
  })

  test("nonzero exit also preserves structured usage emitted on stderr", async () => {
    const f = fixture()
    f.stub(`/bin/sleep 0.1\nprintf '%s\\n' ${quote(result({ is_error: true, result: "fixture stderr failure" }))} >&2\nexit 2`)
    const error = await rejected(f.request)
    expect(error.result.usage.costUsd).toBe(0.12)
    expect(error.result.error).toBe("fixture stderr failure")
    expect(error.notSent).not.toBe(true)
  })

  test("timeout without a complete response records unknown usage, not zero", async () => {
    const f = fixture()
    f.stub("/bin/sleep 5")
    const error = await rejected({ ...f.request, timeoutMs: 180 })
    expect(error.timedOut).toBe(true)
    expect(error.notSent).not.toBe(true)
    expect(error.message).toContain("timeout")
    expect(error.result.usage).toEqual(unknownUsage())
  })

  test("successful fake CLI returns parsed data and registers worker lifecycle", async () => {
    const f = fixture()
    f.stub(`/bin/sleep 0.1\nprintf '%s\\n' ${quote(result())}`)
    const started: Worker[] = [], ended: Worker[] = []
    const parsed = await cliProvider({ onStart: (worker) => started.push(worker), onEnd: (worker) => ended.push(worker) }).run(f.request)
    expect(parsed.text).toBe("fixture reply")
    expect(parsed.usage.costUsd).toBe(0.12)
    expect(started).toHaveLength(1)
    expect(started[0].pid).toBeGreaterThan(0)
    expect(started[0].pgid).toBe(started[0].pid)
    expect(ended).toEqual(started)
  })
})
