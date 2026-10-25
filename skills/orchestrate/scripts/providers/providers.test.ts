import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { claudeCommand, codexCommand, commandFor, grokCommand, piCommand } from "./args.ts"
import { clampEffort, parseEffortRejection } from "./effort.ts"
import { FakeProvider } from "./fake.ts"
import { parseClaude, parseCodex, parseGrok, parsePi } from "./parse.ts"
import { runStages } from "./run.ts"
import type { StageRequest } from "./types.ts"

const dir = new URL("./fixtures/", import.meta.url)

function read(name: string): string {
  return readFileSync(new URL(name, dir), "utf8")
}

function req(over: Partial<StageRequest> = {}): StageRequest {
  return {
    provider: "claude",
    role: "plan",
    model: "claude-opus-5-5",
    effort: "medium",
    prompt: "Reply with exactly: pong",
    cwd: "/tmp/work",
    ...over,
  }
}

describe("思考程度", () => {
  test("glm 和 deepseek 在 grok 上没有 medium 和 xhigh", () => {
    expect(clampEffort("grok", "magpie/zhipu/glm-5.3-flash", "medium").effort).toBe("high")
    expect(clampEffort("grok", "magpie/zhipu/glm-5.3-flash", "xhigh").effort).toBe("max")
    expect(clampEffort("grok", "magpie/workbuddy-ai/deepseek-v4.1-flash", "medium").effort).toBe("high")
  })

  test("grok-4.7 没有 max，往下取 xhigh", () => {
    expect(clampEffort("grok", "magpie/grok/grok-4.7", "max").effort).toBe("xhigh")
    expect(clampEffort("grok", "magpie/grok/grok-4.7", "high").adjusted).toBeUndefined()
  })

  test("能从 grok 的拒绝信息里读出允许的档位", () => {
    const text = "Error: --effort/--reasoning-effort: unknown effort level 'medium'; use one of: low, high, max"
    expect(parseEffortRejection(text)).toEqual(["low", "high", "max"])
  })
})

describe("命令行", () => {
  test("claude 只读走精简启动，并使用完整模型 id", () => {
    const command = claudeCommand(req())
    expect(command.argv).toContain("--safe-mode")
    expect(command.argv).toContain("--strict-mcp-config")
    expect(command.argv).toContain("--disable-slash-commands")
    expect(command.argv).not.toContain("--bare")
    expect(command.argv).not.toContain("--agents")
    expect(command.argv).toContain("claude-opus-5-5")
    expect(command.argv).toContain("plan")
    expect(command.argv).toContain("--permission-prompts")
  })

  test("claude 执行可写，续接用 -r", () => {
    const command = claudeCommand(req({ role: "exec", resume: true, sessionId: "sid-1", effort: "high" }))
    expect(command.argv).toContain("acceptEdits")
    expect(command.argv).toContain("-r")
    expect(command.argv).toContain("sid-1")
    expect(command.argv).not.toContain("--session-id")
  })

  test("grok 只读关掉子会话", () => {
    const command = grokCommand(req({ provider: "grok", model: "magpie/grok/grok-4.7", effort: "high" }))
    expect(command.argv).toContain("--no-subagents")
    expect(command.argv).toContain("--output-format")
    expect(command.argv).not.toContain("--ephemeral")
  })

  test("pi 拒绝执行，off 在 glm 上改成 low", () => {
    expect(() => piCommand(req({ provider: "pi", role: "exec", model: "magpie/zhipu/glm-5.3-flash" }))).toThrow(/不能承担执行/)
    const command = piCommand(req({ provider: "pi", role: "explore", model: "magpie/zhipu/glm-5.3-flash", effort: "off" }))
    expect(command.effort).toBe("low")
    expect(command.argv).toContain("--no-mcp")
    expect(command.argv).toContain("--no-session")
  })

  test("codex 不再传 --ephemeral", () => {
    const command = codexCommand(req({ provider: "codex", role: "review", model: "gpt-6-luna", effort: "xhigh" }))
    expect(command.argv).not.toContain("--ephemeral")
    expect(command.argv).toContain("read-only")
    expect(command.argv).toContain('model_reasoning_effort="xhigh"')
  })
})

describe("用量解析", () => {
  test("claude 读出缓存、思考 token 和金额", () => {
    const parsed = parseClaude(read("claude-haiku.json"))
    expect(parsed.model).toBe("claude-haiku-5-5")
    expect(parsed.sessionId).toBe("2c439c25-b6e5-4eb3-b36a-4401d0f4a36c")
    expect(parsed.usage).toMatchObject({ input: 2, output: 379, cacheRead: 3223, cacheWrite: 4749, reasoning: 295, costUsd: 0.00117173 })
    expect(parsed.text).toBe("pong")
  })

  test("grok 的 0 元不当成免费", () => {
    const parsed = parseGrok(read("grok-glm.json"))
    expect(parsed.usage.input).toBe(17557)
    expect(parsed.usage.costUsd).toBeNull()
    expect(parsed.models["glm-5.3-flash"].costUsd).toBeNull()
    expect(parsed.sessionId).toBe("01a171fa-51a1-72b0-a6ea-2c1e3c6b51dc")
  })

  test("pi 把退出码为 0 的模型错误抛出来", () => {
    const stdout = [
      JSON.stringify({ type: "session", id: "s" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          model: "copilot/gpt-6.1-sol",
          content: [],
          stopReason: "error",
          errorMessage: "The requested model is not supported.",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0 } },
        },
      }),
    ].join("\n")
    expect(() => parsePi(stdout)).toThrow(/not supported/)
  })

  test("pi 取最后一条 assistant 的用量和金额", () => {
    const parsed = parsePi(read("pi-glm.jsonl"))
    expect(parsed.model).toBe("zhipu/glm-5.3-flash")
    expect(parsed.usage).toMatchObject({ input: 19, cacheRead: 7040, reasoning: 9, costUsd: 0.00024918 })
    expect(parsed.text).toBe("pong")
  })

  test("codex 从 token_count 读出缓存和思考 token", () => {
    const parsed = parseCodex(read("codex-token-count.json"))
    expect(parsed.usage).toMatchObject({ input: 25743, cacheRead: 24832, cacheWrite: 0, output: 41, reasoning: 0, costUsd: null })
  })

  test("codex 把包在 msg 里的错误抛出来", () => {
    const stdout = JSON.stringify({ id: "0", msg: { type: "error", message: "model_not_found" } })
    expect(() => parseCodex(stdout)).toThrow(/model_not_found/)
  })
})

describe("假 provider", () => {
  test("三个阶段各跑一次，用量相加", async () => {
    const provider = new FakeProvider()
    const report = await runStages(provider, [
      req({ role: "plan" }),
      req({ provider: "grok", role: "exec", model: "grok-4.7" }),
      req({ provider: "codex", role: "review", model: "gpt-6.1-sol", effort: "xhigh" }),
    ])
    expect(provider.calls.map((call) => call.role)).toEqual(["plan", "exec", "review"])
    expect(report.results.map((result) => result.sessionId)).toEqual(["claude-plan", "grok-exec", "codex-review"])
    expect(report.total).toMatchObject({ input: 30, output: 6, costUsd: 0.03 })
    expect(commandFor(req()).argv[0]).toBe("claude")
  })
})
