import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { claudeCommand, codexCommand, commandFor, grokCommand, piCommand } from "./args.ts"
import { clampEffort, parseEffortRejection } from "./effort.ts"
import { FakeProvider } from "./fake.ts"
import { parseClaude, parseCodex, parseGrok, parsePi, parseProviderOutput } from "./parse.ts"
import { runStages } from "./run.ts"
import { addUsage, emptyUsage, ProviderOutputError, unknownUsage, type StageRequest } from "./types.ts"

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
  test("按配置列表折算，不从模型名猜测", () => {
    expect(clampEffort("grok", "magpie/zhipu/glm-5.3-flash", "medium", ["low", "high", "max"]).effort).toBe("high")
    expect(clampEffort("grok", "magpie/zhipu/glm-5.3-flash", "xhigh", ["low", "high", "max"]).effort).toBe("max")
    expect(clampEffort("grok", "custom-model", "medium", ["low", "high", "max"]).effort).toBe("high")
    expect(clampEffort("grok", "magpie/zhipu/glm-5.3-flash", "medium").effort).toBe("medium")
  })

  test("grok-4.7 没有 max，往下取 xhigh", () => {
    expect(clampEffort("grok", "magpie/grok/grok-4.7", "max", ["low", "medium", "high", "xhigh"]).effort).toBe("xhigh")
    expect(clampEffort("grok", "magpie/grok/grok-4.7", "high", ["low", "medium", "high", "xhigh"]).adjusted).toBeUndefined()
    expect(() => clampEffort("grok", "model", "invalid")).toThrow(/未知/)
    expect(() => clampEffort("grok", "model", "high", [])).toThrow(/不合法/)
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

  test("pi 拒绝执行，档位仅按配置折算", () => {
    expect(() => piCommand(req({ provider: "pi", role: "exec", model: "magpie/zhipu/glm-5.3-flash" }))).toThrow(/不能承担执行/)
    const command = piCommand(req({ provider: "pi", role: "explore", model: "magpie/zhipu/glm-5.3-flash", effort: "off", supportedEfforts: ["low", "high"] }))
    expect(command.effort).toBe("low")
    expect(command.argv).toContain("--no-mcp")
    expect(command.argv).toContain("--no-session")
  })

  test("codex 初次调用保留沙箱和思考配置", () => {
    const command = codexCommand(req({ provider: "codex", role: "review", model: "gpt-6-luna", effort: "xhigh" }))
    expect(command.argv).not.toContain("--ephemeral")
    expect(command.argv).toContain("read-only")
    expect(command.argv).toContain('model_reasoning_effort="xhigh"')
  })

  test("codex resume 的父命令参数放在 resume 前", () => {
    const command = codexCommand(req({ provider: "codex", role: "review", model: "fixture", resume: true, sessionId: "00000000-0000-4000-8000-000000000164", schema: { type: "object" }, schemaPath: "/tmp/orchestrate-fixture.schema.json" }))
    const resumeAt = command.argv.indexOf("resume")
    for (const flag of ["-s", "--color", "-C"]) expect(command.argv.indexOf(flag)).toBeLessThan(resumeAt)
    expect(command.argv.indexOf("-m")).toBeGreaterThan(resumeAt)
    expect(command.argv.at(-1)).toBe(req().prompt)
  })

  test("本机 Codex resume --help 离线接受生成的参数", () => {
    if (!Bun.which("codex")) return
    const command = codexCommand(req({ provider: "codex", role: "review", model: "fixture", resume: true, sessionId: "00000000-0000-4000-8000-000000000164", schema: { type: "object" }, schemaPath: "/tmp/orchestrate-fixture.schema.json" }))
    const checked = spawnSync(command.argv[0], [...command.argv.slice(1, -1), "--help"], { encoding: "utf8" })
    expect(checked.status).toBe(0)
    expect(checked.stdout).toContain("Usage:")
  })

  test("schema 和已批准的沙箱配置只按外壳支持的参数转交", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } }
    const claude = claudeCommand(req({ schema, sandbox: { settings: { sandbox: { enabled: true } } } }))
    expect(claude.argv).toContain("--json-schema")
    expect(claude.argv).toContain(JSON.stringify(schema))
    expect(claude.argv).toContain("--settings")
    const grok = grokCommand(req({ provider: "grok", schema, sandbox: { profile: "read-only" } }))
    expect(grok.argv).toContain("--json-schema")
    expect(grok.argv).toContain("--sandbox")
    expect(grok.argv).toContain("read-only")
    const codex = codexCommand(req({ provider: "codex", schema, schemaPath: "/tmp/fixture.schema.json" }))
    expect(codex.argv).toContain("--output-schema")
    expect(codex.argv).toContain("/tmp/fixture.schema.json")
    expect(() => codexCommand(req({ provider: "codex", schema }))).toThrow(/schemaPath/)
    const pi = piCommand(req({ provider: "pi", schema }))
    expect(pi.argv.at(-1)).toContain(JSON.stringify(schema))
  })
})

describe("用量解析", () => {
  test("claude 读出缓存、思考 token 和金额", () => {
    const parsed = parseClaude(read("claude-haiku.json"))
    expect(parsed.model).toBe("claude-haiku-5-5")
    expect(parsed.sessionId).toBe("2c439c25-b6e5-4eb3-b36a-4401d0f4a36c")
    expect(parsed.usage).toMatchObject({ input: 2, output: 379, cacheRead: 3223, cacheWrite: 4749, reasoning: 295, costUsd: 0.00117173 })
    expect(parsed.text).toBe("pong")
    expect(parsed.costBasis).toBe("cumulative")
  })

  test("Claude 续接累计报价明确标记，不在解析层重复当增量", () => {
    const first = parseClaude(read("claude-haiku.json"))
    const resumed = parseClaude(read("claude-resumed.json"))
    expect(resumed.sessionId).toBe(first.sessionId)
    expect(resumed.costBasis).toBe("cumulative")
    expect(resumed.usage.costUsd! - first.usage.costUsd!).toBeCloseTo(0.001)
    expect(resumed.usage.input).toBe(20)
    expect(resumed.models["claude-haiku-5-5"].input).toBe(22)
  })

  test("Claude 有原生增量字段时优先使用增量用量", () => {
    const result = JSON.parse(read("claude-resumed.json"))
    result.model_usage_since_last_result = {
      "claude-haiku-5-5": { inputTokens: 20, outputTokens: 80, cacheReadInputTokens: 7500, cacheCreationInputTokens: 0, thinkingTokens: 10, costUSD: 0.001 },
    }
    result.structured_output = { ok: true }
    const parsed = parseClaude(JSON.stringify(result))
    expect(parsed.costBasis).toBe("incremental")
    expect(parsed.usage.costUsd).toBe(0.001)
    expect(parsed.structured).toEqual({ ok: true })
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

  test("pi 工具循环累加全部 assistant 用量，正文只取最终回复", () => {
    const parsed = parsePi(read("pi-multi-message.jsonl"))
    expect(parsed.usage).toMatchObject({ input: 3000, output: 50, cacheRead: 300, cacheWrite: 0, reasoning: 10 })
    expect(parsed.usage.costUsd).toBeCloseTo(0.3)
    expect(parsed.models["fixture-model"].input).toBe(3000)
    expect(parsed.text).toBe("done")
  })

  test("codex 从 token_count 读出缓存和思考 token", () => {
    const parsed = parseCodex(read("codex-token-count.json"))
    expect(parsed.usage).toMatchObject({ input: 911, cacheRead: 24832, cacheWrite: 0, output: 41, reasoning: 0, costUsd: null })
  })

  test("Codex 现代事件读最终正文和 turn.completed 用量，缓存不双计", () => {
    const parsed = parseCodex(read("codex-modern.jsonl"))
    expect(JSON.parse(parsed.text).reviewed_tree).toBe("fixture-tree")
    expect(parsed.sessionId).toBe("00000000-0000-4000-8000-000000000164")
    expect(parsed.usage).toMatchObject({ input: 600, cacheRead: 400, output: 80, cacheWrite: null, reasoning: null, costUsd: null })
  })

  test("codex 把包在 msg 里的错误抛出来", () => {
    const stdout = JSON.stringify({ id: "0", msg: { type: "error", message: "model_not_found" } })
    expect(() => parseCodex(stdout)).toThrow(/model_not_found/)
  })

  test("失败输出也保留 Claude、grok、pi、Codex 已回报用量", () => {
    const claude = JSON.parse(read("claude-haiku.json"))
    claude.is_error = true
    claude.result = "fixture failure"
    const c = parseProviderOutput("claude", JSON.stringify(claude))
    expect(c.error).toBe("fixture failure")
    expect(c.usage.costUsd).toBe(0.00117173)
    const g = parseProviderOutput("grok", `${read("grok-glm.json")}\n${JSON.stringify({ type: "error", message: "fixture failure" })}`)
    const gj = parseProviderOutput("grok", `${JSON.stringify(JSON.parse(read("grok-glm.json")))}\n${JSON.stringify({ type: "error", message: "fixture failure" })}`)
    expect(gj.error).toBe("fixture failure")
    expect(gj.usage.input).toBe(17557)
    expect(g.error).toBe("fixture failure")
    expect(g.usage.input).toBe(17557)
    const pi = JSON.parse(read("pi-glm.jsonl").trim().split("\n").at(-1)!)
    pi.message.stopReason = "error"
    pi.message.errorMessage = "fixture failure"
    const p = parseProviderOutput("pi", JSON.stringify(pi))
    expect(p.error).toBe("fixture failure")
    expect(p.usage.input).toBe(19)
    const codex = `${read("codex-modern.jsonl")}\n${JSON.stringify({ type: "turn.failed", error: { message: "fixture failure" } })}`
    const x = parseProviderOutput("codex", codex)
    expect(x.error).toBe("fixture failure")
    expect(x.usage.input).toBe(600)
    try { parseClaude(JSON.stringify(claude)) } catch (error) {
      expect(error).toBeInstanceOf(ProviderOutputError)
      expect((error as ProviderOutputError).result.usage.costUsd).toBe(0.00117173)
    }
  })

  test("没有回报用量时是未知，不是免费；stderr JSON 也能解析", () => {
    for (const provider of ["claude", "grok", "pi", "codex"] as const) {
      const parsed = parseProviderOutput(provider, "not json")
      expect(parsed.usage).toEqual(unknownUsage())
      expect(parsed.error).toBeDefined()
    }
    const parsed = parseProviderOutput("claude", "", read("claude-haiku.json"))
    expect(parsed.usage.input).toBe(2)
    expect(addUsage(emptyUsage(), unknownUsage()).input).toBeNull()
  })

  test("grok 回报正数金额时进入本次用量，不把 0 当报价", () => {
    const value = JSON.parse(read("grok-glm.json"))
    value.modelUsage["glm-5.3-flash"].costUSD = 0.15
    expect(parseGrok(JSON.stringify(value)).usage.costUsd).toBe(0.15)
  })

  test("原生 structured_output 在解析对象前拒绝重复 p1/p2，不丢弃错误后接受覆盖结果", () => {
    for (const provider of ["claude", "grok"] as const) {
      for (const key of ["p1", "p2", "P2"]) {
        const stdout = `{"type":"result","usage":{"input_tokens":25},"total_cost_usd":0.1,"structured_output":{"${key}":[{"ref":"src/a.ts:1","issue":"must not disappear"}],"${key}":[]}}`
        const parsed = parseProviderOutput(provider, stdout, read("claude-haiku.json"))
        expect(parsed.error).toContain(`JSON 重复键：${key}`)
        expect(parsed.usage).toEqual(unknownUsage())
        expect(parsed.structured).toBeUndefined()
        expect(parsed.text).toBe("")
      }
    }
  })

  test("JSONL 的重复键事件不能被当作日志跳过，即使其他事件完整合法", () => {
    const bad = '{"type":"result","structured_output":{"p1":[1],"p\\u0031":[],"p2":[]}}'
    const good = JSON.stringify(JSON.parse(read("claude-haiku.json")))
    for (const stdout of [`${good}\n${bad}`, `${bad}\n${good}`, `[startup]\n${bad}\n${good}`, `{incomplete startup\n${bad}\n${good}`]) {
      const parsed = parseProviderOutput("claude", stdout)
      expect(parsed.error).toContain("JSON 重复键：p1")
      expect(parsed.usage).toEqual(unknownUsage())
      expect(parsed.structured).toBeUndefined()
    }
    const duplicateField = '{"type":"result","structured_output":{"p1":[1]},"structured_output":{"p1":[]}}'
    expect(parseProviderOutput("claude", duplicateField).error).toContain("JSON 重复键：structured_output")
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
