import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadConfig } from "./config.ts"
import { continueFlow, runFlow, type FlowOptions, type Workspace } from "./flow.ts"
import { UnavailableCache } from "./runtime.ts"
import { emptyUsage } from "./providers/types.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test("a controller second review cannot erase the first independent review's P1", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "orch-flow-audit-"))
  roots.push(root)
  const config = loadConfig({ dir: path.resolve(import.meta.dir, "../references"), usingSample: true, modelsFile: "models.sample.conf", routingFile: "routing.example.toml" })
  config.safety.unsafeRead = ["claude", "codex", "grok", "pi"]
  const snapshot = { tree: "tree-current", safeHead: "tree-base", head: "commit", indexTree: "index", sensitive: {}, preexisting: [] }
  const workspace: Workspace = { cwd: root, gitDir: path.join(root, ".git"), captureBaseline: () => snapshot, captureSnapshot: () => snapshot, safeHead: () => snapshot.safeHead, diffTrees: () => "diff", changedPaths: () => ["src/a.ts"], checkSafety: () => [] }
  const review = { p1: [{ ref: "src/a.ts:1", issue: "first review found a real issue" }], p2: [], criteria: [], out_of_scope: [], reviewed_tree: snapshot.tree }
  const options: FlowOptions = {
    cwd: root, goal: "review", runDir: path.join(root, "run"), mode: "review", dual: true, config, workspace,
    hosts: ["claude", "codex", "grok", "pi"].map((provider) => ({ provider: provider as "claude" | "codex" | "grok" | "pi", installed: true, loggedIn: true, detail: "" })),
    provider: { async run(req) {
      if (!req.model.includes("gpt")) throw new Error("model_not_found")
      return { text: "", structured: review, sessionId: "audit-review", model: req.model, usage: { ...emptyUsage(), costUsd: 0 }, models: {} }
    } },
    cache: new UnavailableCache(path.join(root, "unavailable.json")), sleep: async () => {},
  }
  const first = await runFlow(options)
  expect(first.exitCode).toBe(3)
  writeFileSync(path.join(options.runDir, "review-2.json"), JSON.stringify({ ...review, p1: [] }))
  const continued = await continueFlow({ ...options, by: "sonnet-5.5" })
  expect(continued.exitCode).not.toBe(0)
  expect(continued.summary).toContain("P1 未关闭 1")
})

test("verification redacts a PEM before clipping away its identifying header", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "orch-flow-audit-"))
  roots.push(root)
  const config = loadConfig({ dir: path.resolve(import.meta.dir, "../references"), usingSample: true, modelsFile: "models.sample.conf", routingFile: "routing.example.toml" })
  config.safety.unsafeRead = ["claude", "codex", "grok", "pi"]
  config.safety.unsafeExec = ["claude", "grok", "codex"]
  const snapshot = { tree: "tree-current", safeHead: "tree-base", head: "commit", indexTree: "index", sensitive: {}, preexisting: [] }
  const workspace: Workspace = { cwd: root, gitDir: path.join(root, ".git"), captureBaseline: () => snapshot, captureSnapshot: () => snapshot, safeHead: () => snapshot.safeHead, diffTrees: () => "diff", changedPaths: () => [], checkSafety: () => [] }
  const plan = { exec_type: "standard", criteria: [{ id: "C1", kind: "command", text: "test", commands: ["true"] }], allowed_paths: ["**"], needs_permission: [], steps: ["implement"], context: [] }
  const review = { p1: [], p2: [], criteria: [], out_of_scope: [], reviewed_tree: snapshot.tree }
  const result = await runFlow({
    cwd: root, goal: "test", runDir: path.join(root, "run"), config, workspace,
    hosts: ["claude", "codex", "grok", "pi"].map((provider) => ({ provider: provider as "claude" | "codex" | "grok" | "pi", installed: true, loggedIn: true, detail: "" })),
    provider: { async run(req) { return { text: "ok", structured: req.role === "plan" ? plan : req.role === "review" ? review : undefined, sessionId: `${req.role}-audit`, model: req.model, usage: { ...emptyUsage(), costUsd: 0 }, models: {} } } },
    runCommand: async () => ({ code: 0, stdout: "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(6000) + "\n-----END PRIVATE KEY-----", stderr: "" }),
    cache: new UnavailableCache(path.join(root, "unavailable.json")), sleep: async () => {},
  })
  expect(readFileSync(path.join(root, "run", "verify.txt"), "utf8")).not.toContain("A".repeat(100))
  expect(result.exitCode).toBe(0)
  expect(result.summary).toContain("脱敏：private-key")
})
