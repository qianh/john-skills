import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadConfig, parseModels, parseRouting, type LoadedConfig } from "./config.ts"
import { candidatesFor, classifyError, continueFlow, costFromPrice, parsePlan, parseReview, renderSummary, reviewAliases, runFlow } from "./flow.ts"
import type { HostStatus } from "./preflight.ts"
import { emptyUsage, type Provider, type StageRequest } from "./providers/types.ts"

const ready: HostStatus[] = ["claude", "codex", "grok", "pi"].map((provider) => ({
  provider: provider as HostStatus["provider"],
  installed: true,
  loggedIn: true,
  detail: "已登录",
}))

function sample(): LoadedConfig {
    const loaded = loadConfig({
      dir: path.resolve(import.meta.dir, "../references"),
      usingSample: true,
      modelsFile: "models.sample.conf",
      routingFile: "routing.example.toml",
    })
  return loaded
}

describe("配置", () => {
  test("示例配置能解析，gpt 的默认外壳是 pi，glm 的默认外壳是 grok", () => {
    const config = sample()
    expect(config.routing.exec.defaultPool).toBe("standard")
    expect(config.routing.review.maxRounds).toBe(2)
    expect(config.models.find((row) => row.alias === "gpt-6.1-sol")?.provider).toBe("pi")
    expect(config.models.find((row) => row.alias === "glm-5.3-flash")?.provider).toBe("grok")
    const opus = config.models.find((row) => row.alias === "opus-5.5" && row.provider === "claude")
    expect(opus?.price).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    expect(config.models.find((row) => row.alias === "grok-4.7")?.price.input).toBeNull()
  })

  test("执行跳过 pi，未登录的外壳跳过", () => {
    const models = parseModels("glm-5.3-flash pi magpie/zhipu/glm-5.3-flash\nglm-5.3-flash grok magpie/zhipu/glm-5.3-flash\n")
    const hosts: HostStatus[] = [
      { provider: "pi", installed: true, loggedIn: true, detail: "" },
      { provider: "grok", installed: true, loggedIn: false, detail: "未登录" },
    ]
    expect(candidatesFor(["glm-5.3-flash"], "exec", models, hosts)).toEqual([])
    hosts[1].loggedIn = true
    expect(candidatesFor(["glm-5.3-flash"], "exec", models, hosts).map((item) => item.provider)).toEqual(["grok"])
  })

  test("执行模型是 gpt 时，review 换到 opus", () => {
    const routing = parseRouting(`
[roles.plan]
model = "opus-5.5"
effort = "medium"
[roles.exec]
effort = "high"
default_pool = "standard"
pool.standard = ["grok-4.7"]
[roles.review]
model = "gpt-6.1-sol"
effort = "xhigh"
fallback = ["opus-5.5"]
fallback_effort = "medium"
max_rounds = 2
`)
    expect(reviewAliases("grok-4.7", routing.review.model, routing.review.fallback).aliases[0]).toBe("gpt-6.1-sol")
    const switched = reviewAliases("gpt-6.1-sol", routing.review.model, routing.review.fallback)
    expect(switched).toEqual({ aliases: ["opus-5.5"], effortFromFallback: true })
  })
})

describe("账单", () => {
  test("按百万 token 计价，缓存价格缺失且用了缓存时不算", () => {
    const price = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
    const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, reasoning: 10, costUsd: null }
    expect(costFromPrice(usage, price)).toBeCloseTo(5 + 25 + 0.5 + 6.25)
    expect(costFromPrice(usage, { input: 5, output: 25, cacheRead: null, cacheWrite: null })).toBeNull()
    expect(costFromPrice({ ...usage, cacheRead: 0, cacheWrite: 0 }, { input: 5, output: 25, cacheRead: null, cacheWrite: null })).toBeCloseTo(30)
  })

  test("汇总写出全程用 opus 的估算", () => {
    const summary = renderSummary({
      ok: true,
      lineup: "plan opus-5.5 · 执行 grok-4.7 · review gpt-6.1-sol",
      replacements: [],
      files: "无",
      verify: "未跑",
      p1Open: [],
      fixes: 0,
      p2: [],
      byRole: {
        plan: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 1.5 },
      },
      unknownCost: false,
      usingSample: false,
      opusUsd: 4.2,
    })
    expect(summary).toContain("账单：plan $1.5000 · 合计 $1.5000（全程用 opus 约 $4.2000，估算）")
  })
})

describe("方案和 review 的格式", () => {
  test("读出执行类型和验收命令", () => {
    const parsed = parsePlan("## 执行类型\nhard\n\n## 验收\nnode --test test/math.test.js\n\n## 方案\n做完\n")
    expect(parsed).toEqual({ pool: "hard", commands: ["node --test test/math.test.js"] })
  })

  test("P1 写无就当没有问题", () => {
    expect(parseReview("## P1\n无\n\n## P2\n- 命名可以再改\n")).toEqual({ p1: [], p2: ["命名可以再改"], formatted: true })
  })

  test("先写无，后面的说明不算问题", () => {
    const text = "## P1\n- 无\n\n## P2\n- 无\n\n看过代码，结论如下：\n- src/math.js:5 返回值是对的\n"
    expect(parseReview(text)).toEqual({ p1: [], p2: [], formatted: true })
  })

  test("限流是暂时的，模型不存在是换人", () => {
    expect(classifyError("429 rate limit")).toBe("transient")
    expect(classifyError("model_not_found")).toBe("hard")
  })
})

describe("整条流程", () => {
  function harness(script: (req: StageRequest, nth: number) => string | Error) {
    const calls: StageRequest[] = []
    const provider: Provider = {
      async run(req) {
        calls.push(req)
        const answer = script(req, calls.length)
        if (answer instanceof Error) throw answer
        return { text: answer, sessionId: req.sessionId ?? null, model: req.model, usage: { ...emptyUsage(), input: 10, output: 2, costUsd: req.provider === "grok" ? null : 0.01 }, models: {} }
      },
    }
    const dir = mkdtempSync(path.join(tmpdir(), "orch-flow-"))
    const runDir = path.join(dir, "run")
    const base = {
      cwd: dir,
      goal: "实现 mul",
      runDir,
      config: sample(),
      hosts: ready,
      provider,
      runCommand: async () => ({ code: 0, stdout: "ok", stderr: "" }),
      diff: async () => ({ patch: "diff --git a/src/math.js", status: "M src/math.js" }),
      newId: () => crypto.randomUUID(),
      sleep: async () => {},
    }
    return {
      calls,
      runDir,
      run: (extra: Partial<Parameters<typeof runFlow>[0]> = {}) => runFlow({ ...base, ...extra }),
      continue: () => continueFlow(base),
    }
  }

  test("探索、方案、执行、review、修复都续接原来的会话，验收由脚本跑", async () => {
    let reviews = 0
    const flow = harness((req) => {
      if (req.role === "explore") return "src/math.js:1 只有 add"
      if (req.role === "plan") return "## 执行类型\nstandard\n\n## 验收\nnode --test test/math.test.js\n\n## 方案\n补上 mul\n"
      if (req.role === "exec") return "已改 src/math.js"
      reviews += 1
      return reviews === 1 ? "## P1\n- src/math.js:4 结果少乘了一次\n\n## P2\n无\n" : "## P1\n无\n\n## P2\n无\n"
    })
    const outcome = await flow.run()
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toContain("结论：完成")
    expect(outcome.summary).toContain("node --test test/math.test.js 通过（脚本复核）")
    expect(outcome.summary).toContain("全程用 opus 约")
    expect(outcome.summary).toContain("估算")
    expect(flow.calls.map((call) => call.role)).toEqual(["explore", "plan", "exec", "review", "exec", "review"])
    expect(flow.calls[2].resume).toBe(false)
    expect(flow.calls[4].resume).toBe(true)
    expect(flow.calls[4].sessionId).toBe(flow.calls[2].sessionId)
    expect(flow.calls[5].resume).toBe(true)
    expect(flow.calls[5].sessionId).toBe(flow.calls[3].sessionId)
    expect(flow.calls[2].model).toContain("grok-4.7")
    expect(flow.calls[3].provider).toBe("pi")
  })

  test("执行模型调用失败就换池子里的下一个，并带上当前 diff", async () => {
    const flow = harness((req) => {
      if (req.role === "exec" && req.provider === "grok") throw new Error("model_not_found")
      if (req.role === "plan") return "## 执行类型\nstandard\n\n## 验收\nnode --test test/math.test.js\n\n## 方案\n补上 mul\n"
      if (req.role === "review") return "## P1\n无\n\n## P2\n无\n"
      return "继续做完"
    })
    const outcome = await flow.run()
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toContain("改用 sonnet-5.5")
    const execs = flow.calls.filter((call) => call.role === "exec")
    expect(execs.map((call) => call.provider)).toEqual(["grok", "claude"])
    expect(execs[1].prompt).toContain("当前 diff")
    expect(execs[1].resume).toBe(false)
  })

  test("限流先重试原会话，不换模型", async () => {
    let plans = 0
    const flow = harness((req) => {
      if (req.role === "plan") {
        plans += 1
        if (plans === 1) throw new Error("429 rate limit")
        return "## 执行类型\nstandard\n\n## 验收\nnode --test test/math.test.js\n\n## 方案\n补上\n"
      }
      if (req.role === "review") return "## P1\n无\n\n## P2\n无\n"
      return "好"
    })
    const outcome = await flow.run()
    expect(outcome.ok).toBe(true)
    const plansCalls = flow.calls.filter((call) => call.role === "plan")
    expect(plansCalls).toHaveLength(2)
    expect(plansCalls[1].resume).toBe(true)
    expect(plansCalls[1].sessionId).toBe(plansCalls[0].sessionId)
    expect(outcome.summary).toContain("替换：无")
  })

  test("两轮修复后还有 P1 就停下", async () => {
    const flow = harness((req) => {
      if (req.role === "plan") return "## 执行类型\nstandard\n\n## 验收\nnode --test test/math.test.js\n\n## 方案\n补上\n"
      if (req.role === "review") return "## P1\n- 还是错\n\n## P2\n无\n"
      return "又改了一次"
    })
    const outcome = await flow.run()
    expect(outcome.ok).toBe(false)
    expect(outcome.summary).toContain("卡在 review 仍有 P1")
    expect(flow.calls.filter((call) => call.role === "exec")).toHaveLength(3)
    expect(flow.calls.filter((call) => call.role === "review")).toHaveLength(3)
  })

  test("点名 gpt 执行时，review 用 opus", async () => {
    const flow = harness((req) => {
      if (req.role === "plan") return "## 执行类型\nhard\n\n## 验收\nnode --test test/math.test.js\n\n## 方案\n补上\n"
      if (req.role === "review") return "## P1\n无\n\n## P2\n无\n"
      return "好"
    })
    const outcome = await flow.run({ execPin: "gpt-6.1-sol" })
    expect(outcome.ok).toBe(true)
    const exec = flow.calls.find((call) => call.role === "exec")
    const review = flow.calls.find((call) => call.role === "review")
    expect(exec?.provider).toBe("grok")
    expect(review?.model).toContain("opus")
    expect(review?.effort).toBe("medium")
    expect(outcome.summary).toContain("避免执行模型审自己")
  })

  test("方案的模型都失败时交给主会话，写好方案后续跑", async () => {
    const flow = harness((req) => {
      if (req.role === "plan") throw new Error("model_not_found")
      if (req.role === "review") return "## P1\n无\n\n## P2\n无\n"
      return "好"
    })
    const outcome = await flow.run()
    expect(outcome.ok).toBe(false)
    expect(outcome.summary).toContain("plan 交给主会话")
    expect(outcome.summary).toContain("model_not_found")
    expect(outcome.summary).toContain(`continue --run ${JSON.stringify(flow.runDir)}`)
    expect(flow.calls.some((call) => call.role === "exec")).toBe(false)
    const plans = flow.calls.filter((call) => call.role === "plan").length
    writeFileSync(path.join(flow.runDir, "plan.md"), "## 执行类型\nstandard\n\n## 验收\nnode --test test/math.test.js\n\n## 方案\n补上 mul\n")
    const next = await flow.continue()
    expect(next.ok).toBe(true)
    expect(next.summary).toContain("结论：完成")
    expect(flow.calls.filter((call) => call.role === "exec")).toHaveLength(1)
    expect(flow.calls.filter((call) => call.role === "plan")).toHaveLength(plans)
  })

  test("执行的模型都失败时交给主会话，改完代码再审查", async () => {
    const flow = harness((req) => {
      if (req.role === "exec") throw new Error("model_not_found")
      if (req.role === "plan") return "## 执行类型\nstandard\n\n## 验收\nnode --test test/math.test.js\n\n## 方案\n补上\n"
      if (req.role === "review") return "## P1\n无\n\n## P2\n无\n"
      return "好"
    })
    const outcome = await flow.run()
    expect(outcome.summary).toContain("执行 交给主会话")
    expect(flow.calls.some((call) => call.role === "review")).toBe(false)
    const execs = flow.calls.filter((call) => call.role === "exec").length
    const next = await flow.continue()
    expect(next.ok).toBe(true)
    expect(flow.calls.filter((call) => call.role === "exec")).toHaveLength(execs)
    expect(flow.calls.some((call) => call.role === "review")).toBe(true)
  })

  test("审查的模型都失败时交给主会话，并标明独立性", async () => {
    const flow = harness((req) => {
      if (req.role === "review") throw new Error("model_not_found")
      if (req.role === "plan") return "## 执行类型\nstandard\n\n## 验收\nnode --test test/math.test.js\n\n## 方案\n补上\n"
      return "好"
    })
    const outcome = await flow.run()
    expect(outcome.summary).toContain("review 交给主会话")
    expect(outcome.summary).toContain("独立性不足")
    writeFileSync(path.join(flow.runDir, "review-1.md"), "## P1\n无\n\n## P2\n无\n")
    const next = await flow.continue()
    expect(next.ok).toBe(true)
    expect(next.summary).toContain("结论：完成")
  })

  test("修复时执行模型都失败，主会话改完后续审", async () => {
    let execs = 0
    let reviews = 0
    const flow = harness((req) => {
      if (req.role === "plan") return "## 执行类型\nstandard\n\n## 验收\nnode --test test/math.test.js\n\n## 方案\n补上\n"
      if (req.role === "exec") {
        execs += 1
        if (execs > 1) throw new Error("model_not_found")
        return "改了"
      }
      if (req.role === "review") {
        reviews += 1
        return reviews === 1 ? "## P1\n- 还要改\n\n## P2\n无\n" : "## P1\n无\n\n## P2\n无\n"
      }
      return "看过仓库"
    })
    const outcome = await flow.run()
    expect(outcome.summary).toContain("执行 交给主会话")
    const execCalls = flow.calls.filter((call) => call.role === "exec").length
    const next = await flow.continue()
    expect(next.ok).toBe(true)
    expect(flow.calls.filter((call) => call.role === "exec")).toHaveLength(execCalls)
    expect(flow.calls.filter((call) => call.role === "review").length).toBeGreaterThan(1)
  })
})
