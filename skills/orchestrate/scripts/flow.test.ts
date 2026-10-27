import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadConfig, type LoadedConfig } from "./config.ts"
import { continueFlow, costFromPrice, runFlow, type FlowOptions, type SavedState, type Workspace } from "./flow.ts"
import type { Plan } from "./contracts.ts"
import type { HostStatus } from "./preflight.ts"
import { emptyUsage, ProviderOutputError, unknownUsage, type StageRequest, type ProviderResult } from "./providers/types.ts"
import { UnavailableCache } from "./runtime.ts"

const hosts: HostStatus[] = ["claude", "codex", "grok", "pi"].map((p) => ({ provider: p as HostStatus["provider"], installed: true, loggedIn: true, detail: "test" }))
const plan: Plan = { exec_type: "standard", criteria: [{ id: "C1", kind: "command", text: "tests pass", commands: ["rtk bun test"] }], allowed_paths: ["src/**"], needs_permission: [], steps: ["implement"], context: [] }
function sample(): LoadedConfig { return loadConfig({ dir: path.resolve(import.meta.dir, "../references"), usingSample: true, modelsFile: "models.sample.conf", routingFile: "routing.example.toml" }) }
function harness(script?: (req: StageRequest, nth: number) => unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "orch-flow-")), runDir = path.join(dir, "run")
  const config = sample(); config.safety.unsafeRead = ["claude", "grok", "codex", "pi"]; config.safety.unsafeExec = ["claude", "grok", "codex"]
  const calls: StageRequest[] = [], commands: string[] = []
  let tree = "base", revision = 0
  const snap = () => ({ tree, head: "head", indexTree: "index", safeHead: "head-tree", sensitive: {}, preexisting: ["existing.ts"] })
  const workspace: Workspace = { cwd: dir, gitDir: path.join(dir, ".git"), captureBaseline: snap, captureSnapshot: snap, safeHead: () => "head-tree", diffTrees: () => "diff --git a/src/x.ts b/src/x.ts\n+fix", changedPaths: (a, b) => a === b ? [] : ["src/x.ts"], checkSafety: () => [] }
  const base: FlowOptions = { cwd: dir, goal: "implement", runDir, config, hosts, workspace, cache: new UnavailableCache(path.join(dir, "cache.json")), sleep: async () => {}, provider: { async run(req) {
    calls.push(req)
    if (req.role === "exec") tree = `tree-${++revision}`
    const reply = script?.(req, calls.length)
    if (reply instanceof Error) throw reply
    const treeId = req.prompt.match(/快照 reviewed_tree 必须原样填：([^\s]+)/)?.[1] ?? tree
    let output = reply ?? (req.role === "plan" ? plan : req.role === "review" ? { p1: [], p2: [], criteria: [], out_of_scope: [], reviewed_tree: treeId } : "done")
    if (typeof output === "object" && output && "usage" in output) return output as ProviderResult
    const text = typeof output === "string" ? output : JSON.stringify(output)
    return { text: req.provider === "pi" && typeof output !== "string" ? `\x60\x60\x60json\n${text}\n\x60\x60\x60` : text, sessionId: req.sessionId!, model: req.model, usage: { ...emptyUsage(), input: 10, output: 2, costUsd: 0.01 }, models: {} }
  } }, runCommand: async (command) => { commands.push(command); return { code: 0, stdout: "ok", stderr: "" } } }
  return { base, config, calls, commands, runDir, setTree: (next: string) => { tree = next }, state: () => JSON.parse(readFileSync(path.join(runDir, "state.json"), "utf8")) as SavedState, run: (extra: Partial<FlowOptions> = {}) => runFlow({ ...base, ...extra }), next: (extra: Partial<FlowOptions> = {}) => continueFlow({ ...base, by: "sonnet-5.5", ...extra }) }
}

describe("snapshot-evidenced flow", () => {
  test("acceptance runs before each independent review; final trees match", async () => {
    let reviewed = 0
    const h = harness((req) => {
      if (req.role === "review") { reviewed++; expect(h.commands.length).toBe(reviewed) }
    })
    const result = await h.run()
    expect(result.exitCode).toBe(0)
    expect(h.calls.map((r) => r.role)).toEqual(["explore", "plan", "exec", "review"])
    expect(h.commands).toEqual(["rtk bun test"])
    expect(readFileSync(path.join(h.runDir, "exec-0.txt"), "utf8")).toBe("done")
    const state = h.state()
    expect(state.verifiedTree).toBe(state.current.tree); expect(state.reviewedTree).toBe(state.current.tree)
    expect(result.summary).toContain("本次 token 按 opus-5.5 单价重算")
    expect(result.summary.split("\n").length).toBeLessThanOrEqual(30)
  })
  test("failed acceptance fixes before spending review tokens", async () => {
    const h = harness(); let attempts = 0
    const result = await h.run({ runCommand: async () => ({ code: ++attempts === 1 ? 1 : 0, stdout: "test result", stderr: "" }) })
    expect(result.ok).toBe(true)
    expect(h.calls.map((r) => r.role)).toEqual(["explore", "plan", "exec", "exec", "review"])
    const execs = h.calls.filter((r) => r.role === "exec")
    expect(execs[1].resume).toBe(true); expect(execs[1].sessionId).toBe(execs[0].sessionId)
    expect(h.state().fixes).toBe(1)
  })
  test("acceptance and P1 consume the same two repair rounds", async () => {
    const h = harness((req) => req.role === "review" ? { p1: [{ ref: "src/x.ts:1", issue: "wrong" }], p2: [], criteria: [], out_of_scope: [], reviewed_tree: req.prompt.match(/原样填：([^\s]+)/)![1] } : undefined)
    let attempts = 0
    const result = await h.run({ runCommand: async () => ({ code: ++attempts === 1 ? 1 : 0, stdout: "", stderr: "" }) })
    expect(result.exitCode).toBe(1); expect(h.state().fixes).toBe(2)
    expect(h.calls.filter((r) => r.role === "exec")).toHaveLength(3)
  })
  test("two invalid reviews block, rather than reporting zero findings", async () => {
    const h = harness((req) => req.role === "review" ? '{"p2":[]}' : undefined)
    expect((await h.run()).exitCode).toBe(1)
    const reviews = h.calls.filter((r) => r.role === "review")
    expect(reviews).toHaveLength(2); expect(reviews[1].resume).toBe(true)
  })
  test("invalid plan gets one correction, then a schema handoff", async () => {
    const h = harness((req) => req.role === "plan" ? "## 验收\nnpm publish" : undefined)
    const result = await h.run()
    expect(result.exitCode).toBe(3); expect(h.state().handoff?.type).toBe("plan")
    expect(result.summary).toContain("plan.schema.json"); expect(h.commands).toHaveLength(0)
  })
  test("permission is from user, not planner; network does not authorize publish", async () => {
    const h = harness((req) => req.role === "plan" ? { ...plan, criteria: [{ id: "C1", kind: "command", text: "publish", commands: ["npm publish"] }] } : undefined)
    const result = await h.run({ allow: ["network:*"] })
    expect(result.exitCode).toBe(3); expect(h.state().handoff?.type).toBe("permission")
    expect(h.calls.some((r) => r.role === "exec")).toBe(false)
  })
  test("plan-only stops before execution and explicitly continues", async () => {
    const h = harness(); expect((await h.run({ planOnly: true })).exitCode).toBe(3)
    expect(h.calls.some((r) => r.role === "exec")).toBe(false)
    expect((await h.next()).ok).toBe(true)
  })
  test("no independent reviewer hands off; main review can still complete the task", async () => {
    const h = harness(); h.config.routing.exec.pools.standard = [{ model: "sonnet-5.5", effort: "high" }]; h.config.routing.review.chain = [{ model: "opus-5.5", effort: "medium" }]
    expect((await h.run()).exitCode).toBe(3)
    const state = h.state(); expect(state.handoff?.type).toBe("review")
    writeFileSync(path.join(h.runDir, `review-${state.reviewRound}.json`), JSON.stringify({ p1: [], p2: [], criteria: [], out_of_scope: [], reviewed_tree: state.current.tree }))
    const result = await h.next()
    expect(result.exitCode).toBe(0); expect(result.summary).toContain("主控完成")
  })
  test("sonnet execution skips opus fallback and uses grok, with its own effort", async () => {
    const h = harness((req) => req.role === "review" && req.model.includes("gpt") ? new Error("model_not_found") : undefined)
    h.config.routing.exec.pools.standard = [{ model: "sonnet-5.5", effort: "high" }]
    h.config.routing.review.chain = [{ model: "gpt-6.1-sol", effort: "xhigh" }, { model: "opus-5.5", effort: "medium" }, { model: "grok-4.7", effort: "low" }]
    expect((await h.run()).ok).toBe(true)
    const reviews = h.calls.filter((r) => r.role === "review")
    expect(reviews.some((r) => r.model.includes("opus"))).toBe(false)
    expect(reviews.at(-1)?.effort).toBe("low")
  })
  test("new author during fix invalidates the old reviewer session", async () => {
    let execCount = 0, reviewCount = 0
    const h = harness((req) => {
      if (req.role === "exec" && ++execCount === 2) return new Error("unsupported model")
      if (req.role === "review" && ++reviewCount === 1) return { p1: [{ ref: "src/x.ts", issue: "fix" }], p2: [], criteria: [], out_of_scope: [], reviewed_tree: req.prompt.match(/原样填：([^\s]+)/)![1] }
    })
    h.config.routing.review.chain = [{ model: "opus-5.5", effort: "medium" }, { model: "gpt-6.1-sol", effort: "xhigh" }]
    expect((await h.run()).ok).toBe(true)
    const reviews = h.calls.filter((r) => r.role === "review")
    expect(reviews[0].model).toContain("opus"); expect(reviews.at(-1)?.model).toContain("gpt")
    expect(reviews.at(-1)?.resume).toBe(false)
    expect(h.state().authors.map((a) => a.family)).toContain("anthropic")
  })
  test("checks require main-session evidence, tied to final tree", async () => {
    const checkedPlan = { ...plan, criteria: [...plan.criteria, { id: "C2", kind: "check", text: "manual" }] }
    const h = harness((req) => req.role === "plan" ? checkedPlan : req.role === "review" ? { p1: [], p2: [], criteria: [{ id: "C2", verdict: "pass", note: "review only" }], out_of_scope: [], reviewed_tree: req.prompt.match(/原样填：([^\s]+)/)![1] } : undefined)
    expect((await h.run()).exitCode).toBe(3); expect(h.state().handoff?.type).toBe("check")
    writeFileSync(path.join(h.runDir, "checks.json"), JSON.stringify({ checked_tree: h.state().current.tree, checks: [{ id: "C2", verdict: "pass", evidence: "visually inspected local fixture" }] }))
    expect((await h.next()).ok).toBe(true)
  })
  test("failed manual evidence uses the same fix allowance and must be rechecked", async () => {
    const h = harness((req) => req.role === "plan" ? { ...plan, criteria: [{ id: "C2", kind: "check", text: "manual" }] } : req.role === "review" ? { p1: [], p2: [], criteria: [{ id: "C2", verdict: "pass", note: "review only" }], out_of_scope: [], reviewed_tree: req.prompt.match(/原样填：([^\s]+)/)![1] } : undefined)
    expect((await h.run()).exitCode).toBe(3)
    const before = h.state().current.tree
    writeFileSync(path.join(h.runDir, "checks.json"), JSON.stringify({ checked_tree: before, checks: [{ id: "C2", verdict: "fail", evidence: "manual regression" }] }))
    expect((await h.next()).exitCode).toBe(3)
    expect(h.state().fixes).toBe(1)
    expect(h.state().handoff?.type).toBe("check")
    expect(h.state().current.tree).not.toBe(before)
    expect(h.state().checksTree).toBeUndefined()
  })
  test("non-code handoff workspace change records main as author and reruns verification", async () => {
    const h = harness(); h.config.routing.review.chain = [{ model: "opus-5.5", effort: "medium" }]
    // First stop at the call budget immediately before review.
    expect((await h.run({ maxCalls: 3 })).exitCode).toBe(3)
    const verified = h.state().verifiedTree
    h.setTree("manual-change")
    const next = await h.next({ by: "sonnet-5.5", maxCalls: 10 })
    expect(next.exitCode).toBe(3) // opus is now conflicted, not accepted as independent.
    expect(h.state().authors.some((a) => a.alias === "sonnet-5.5")).toBe(true)
    expect(h.state().verifiedTree).not.toBe(verified)
  })
  test("first transient failure retries with a fresh, unestablished ID", async () => {
    let plans = 0
    const h = harness((req) => req.role === "plan" && ++plans === 1 ? new Error("429 rate limit") : undefined)
    expect((await h.run()).ok).toBe(true)
    const calls = h.calls.filter((r) => r.role === "plan")
    expect(calls[1].resume).toBe(false); expect(calls[1].sessionId).not.toBe(calls[0].sessionId)
    expect(h.state().calls[1].costSource).toBe("unknown")
  })
  test("known unavailable routes are skipped without ledger calls", async () => {
    const h = harness()
    for (const row of h.config.models.filter((r) => h.config.routing.plan.chain.some((c) => c.model === r.alias))) h.base.cache!.put(row.provider, row.modelId, "model_not_found")
    expect((await h.run()).exitCode).toBe(3)
    expect(h.calls.some((r) => r.role === "plan")).toBe(false)
  })
  test("failed calls retain known usage; unknown calls yield a lower bound", async () => {
    const h = harness((req) => req.role === "plan" ? new ProviderOutputError("fatal", { text: "", sessionId: null, model: req.model, usage: { ...unknownUsage(), costUsd: 0.2 }, models: {} }) : undefined)
    const result = await h.run()
    expect(result.summary).toContain(`$${(0.01 + h.calls.filter((r) => r.role === "plan").length * 0.2).toFixed(4)}`)
    expect(h.state().calls.at(-1)?.usage.costUsd).toBe(0.2)
    const unknown = harness((req) => req.role === "plan" ? new Error("fatal") : undefined)
    expect((await unknown.run()).summary).toContain("合计 ≥ ")
  })
  test("cumulative Claude quote is counted as per-session delta", async () => {
    let reviews = 0
    const h = harness((req) => {
      if (req.role !== "review") return undefined
      reviews++
      return { text: JSON.stringify({ p1: reviews === 1 ? [{ ref: "src/x.ts", issue: "fix" }] : [], p2: [], criteria: [], out_of_scope: [], reviewed_tree: req.prompt.match(/原样填：([^\s]+)/)![1] }), sessionId: req.sessionId!, model: req.model, usage: { ...emptyUsage(), costUsd: reviews === 1 ? 1 : 1.5 }, models: {}, costBasis: "cumulative" }
    })
    h.config.routing.review.chain = [{ model: "opus-5.5", effort: "medium" }]
    expect((await h.run()).ok).toBe(true)
    expect(h.state().calls.filter((c) => c.role === "review").map((c) => c.usage.costUsd)).toEqual([1, 0.5])
  })
  test("unsafe routes default off and are reported as skips", async () => {
    const h = harness(); h.config.safety.unsafeRead = []; h.config.safety.unsafeExec = []
    const result = await h.run()
    expect(result.exitCode).toBe(3); expect(h.calls).toHaveLength(0)
    expect(h.state().replacements.join(" ")).toContain("默认禁用")
  })
  test("a read-only worker modifying the workspace stops before planning/execution", async () => {
    const h = harness((req) => { if (req.role === "explore") h.setTree("unexpected-write") })
    const result = await h.run()
    expect(result.exitCode).toBe(5)
    expect(h.calls.map((r) => r.role)).toEqual(["explore"])
    expect(h.state().safetyFlags.join(" ")).toContain("只读调用")
  })
  test("budget needs another bound for unknown prices; call cap includes failures", async () => {
    const h = harness(); expect((await h.run({ budget: 1 })).exitCode).toBe(2); expect(h.calls).toHaveLength(0)
    const bounded = harness(); expect((await bounded.run({ budget: 1, maxCalls: 1 })).exitCode).toBe(3)
    expect(bounded.calls).toHaveLength(1); expect(bounded.state().handoff?.type).toBe("budget")
  })
  test("permission/security changes start a new same-model session", async () => {
    let executes = 0
    const h = harness((req) => req.role === "exec" && ++executes > 1 ? new Error("fatal") : undefined)
    let verifies = 0
    const first = await h.run({ runCommand: async () => ({ code: ++verifies === 1 ? 1 : 0, stdout: "", stderr: "" }), maxCalls: 3 })
    expect(first.exitCode).toBe(3)
    // Reached a fix budget handoff after the first execution.
    const old = h.calls.find((r) => r.role === "exec")!
    await h.next({ allow: ["deps"], maxCalls: 4 })
    const again = h.calls.filter((r) => r.role === "exec")[1]
    expect(again.resume).toBe(false); expect(again.sessionId).not.toBe(old.sessionId)
    expect(again.prompt).toContain("当前本次增量")
  })
  test("safety-blocked commands are pending validation, not repair attempts", async () => {
    const h = harness(); const result = await h.run({ runCommand: async () => ({ code: 125, stdout: "", stderr: "sandbox unavailable", blocked: true }) })
    expect(result.exitCode).toBe(3); expect(h.state().handoff?.type).toBe("verify"); expect(h.state().fixes).toBe(0)
    expect(h.calls.some((r) => r.role === "review")).toBe(false)
  })
  test("readonly entry does not explore, plan or execute", async () => {
    const h = harness(); const result = await h.run({ mode: "review" })
    expect(result.ok).toBe(true); expect(h.calls.map((r) => r.role)).toEqual(["review"]); expect(h.commands).toHaveLength(0)
    expect(result.summary).toContain("没有作者独立性保证")
  })
  test("newlines in file names cannot break the 30-line summary contract", async () => {
    const h = harness()
    h.base.workspace!.changedPaths = () => [`src/${"\n".repeat(40)}x.ts`]
    const result = await h.run({ mode: "review" })
    expect(result.ok).toBe(true)
    expect(result.summary.split("\n").length).toBeLessThanOrEqual(30)
  })
  test("continue requires by and typo execution aliases are usage errors", async () => {
    const h = harness(); await h.run({ planOnly: true })
    await expect(continueFlow(h.base)).rejects.toThrow("--by")
    await expect(h.run({ execPin: "typo" })).rejects.toThrow("未知能力")
  })
})

test("pricing cannot turn missing tokens/cache price into a free call", () => {
  const price = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
  const usage = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, reasoning: 10, costUsd: null }
  expect(costFromPrice(usage, price)).toBe(36.75)
  expect(costFromPrice({ ...usage, input: null }, price)).toBeNull()
  expect(costFromPrice(usage, { ...price, cacheRead: null })).toBeNull()
})
