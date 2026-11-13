import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadCatalog, loadConfig } from "./config.ts"
import { aliasFromModelId, buildState, commitSelection, compileSelection, readClaudeModelIds, routesFromDiscovery, startConfigUi, type Discovery } from "./config-ui.ts"
import { configMain } from "./config-cli.ts"

const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "orch-ui-")); roots.push(dir); return dir }
const discovered: Discovery[] = [
  { provider: "claude", installed: true, loggedIn: true, ids: [] },
  { provider: "grok", installed: true, loggedIn: true, ids: ["grok-4.7", "vendor/new-model", "vendor-new-model"] },
  { provider: "codex", installed: false, loggedIn: false, ids: [] },
  { provider: "pi", installed: true, loggedIn: false, ids: ["magpie/claude/claude-haiku-5-5"] },
]

test("local routes come from discovery, and unmatched ids stay selectable", () => {
  const routes = routesFromDiscovery(loadCatalog(), discovered, ["claude-haiku-5-5", "claude-opus-4-6"])
  expect(routes.find((route) => route.modelId === "claude-haiku-5-5")).toMatchObject({ alias: "haiku-5.5", family: "anthropic", matched: true, provider: "claude" })
  expect(routes.find((route) => route.modelId === "claude-opus-4-6")).toMatchObject({ alias: "claude-opus-4-6", family: "claude", matched: false })
  expect(routes.find((route) => route.modelId === "grok-4.7")).toMatchObject({ alias: "grok-4.7", family: "xai", matched: true })
  const unmatched = routes.filter((route) => route.modelId.startsWith("vendor"))
  expect(unmatched.map((route) => route.alias).sort()).toEqual(["vendor-new-model", "vendor-new-model-grok-2"])
  expect(routes.some((route) => route.provider === "pi")).toBe(false)
  expect(aliasFromModelId("---")).toBe("m-model")
})

test("claude catalog reader uses id fields and skips links", () => {
  const dir = temp()
  const real = path.join(dir, "real.json")
  writeFileSync(real, JSON.stringify({ catalog: { config: { models: [{ id: "claude-haiku-5-5" }, { id: "not valid" }, { name: "skip" }] } } }))
  writeFileSync(path.join(dir, "broken.json"), "{")
  symlinkSync(real, path.join(dir, "link.json"))
  expect(readClaudeModelIds(dir)).toEqual(["claude-haiku-5-5"])
  expect(readClaudeModelIds(path.join(dir, "missing"))).toEqual([])
})

test("save accepts only discovered routes and preserves safety and price", () => {
  const catalog = loadCatalog()
  const routes = routesFromDiscovery(catalog, discovered, ["claude-haiku-5-5"])
  const haiku = routes.find((route) => route.alias === "haiku-5.5" && route.provider === "claude")!
  const grok = routes.find((route) => route.alias === "grok-4.7")!
  const state = buildState(discovered, routes, `haiku-5.5 claude claude-haiku-5-5 price=1,2,0.1,0.2\n`, "")
  expect(state.routes.find((route) => route.key === haiku.key)?.enabled).toBe(true)
  expect(state.warnings.some((warning) => warning.includes("codex"))).toBe(true)
  const body = {
    enabled: [grok.key, haiku.key],
    explore: [{ alias: "haiku-5.5", effort: "low" }],
    plan: [{ alias: "grok-4.7", effort: "high" }],
    review: [{ alias: "grok-4.7", effort: "high" }],
    pools: {
      mechanical: [{ alias: "haiku-5.5", effort: "low" }],
      standard: [{ alias: "grok-4.7", effort: "high" }],
      hard: [{ alias: "grok-4.7", effort: "high" }],
    },
    timeouts: { explore: 5, plan: 10, review: 15, exec: 30 },
    maxRounds: 2,
    execEffort: "high",
  }
  expect(() => compileSelection(routes, { ...body, enabled: ["grok\0nope\0grok-4.7"] }, [], stateSafety())).toThrow("不在本机")
  const withPi = discovered.map((host) => host.provider === "pi" ? { ...host, loggedIn: true } : host)
  const piRoutes = routesFromDiscovery(catalog, withPi, ["claude-haiku-5-5"])
  const piOnly = piRoutes.find((route) => route.provider === "pi")!
  const piBody = { ...body, enabled: [piOnly.key], explore: [{ alias: "haiku-5.5", effort: "low" }], plan: [{ alias: "haiku-5.5", effort: "low" }], review: [{ alias: "haiku-5.5", effort: "low" }], pools: { mechanical: [{ alias: "haiku-5.5", effort: "low" }], standard: [{ alias: "haiku-5.5", effort: "low" }], hard: [{ alias: "haiku-5.5", effort: "low" }] } }
  expect(() => compileSelection(piRoutes, piBody, [], stateSafety())).toThrow("只有 pi")
  const compiled = compileSelection(routes, body, [{ alias: "haiku-5.5", provider: "claude", modelId: "claude-haiku-5-5", family: "anthropic", efforts: null, price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } }], stateSafety())
  expect(compiled.modelsText).toContain("price=1,2,0.1,0.2")
  expect(compiled.routingText).toContain('unsafe_read = ["grok"]')
  const dir = temp()
  writeFileSync(path.join(dir, "models.conf"), "haiku-5.5 claude old-id\n")
  writeFileSync(path.join(dir, "routing.toml"), compiled.routingText)
  commitSelection(dir, compiled.modelsText, compiled.routingText)
  const loaded = loadConfig(dir)
  expect(loaded.models.map((row) => row.modelId)).toEqual(["grok-4.7", "claude-haiku-5-5"])
  expect(loaded.safety.unsafeRead).toEqual(["grok"])
  expect(loaded.models[1].price.input).toBe(1)
})

function stateSafety() {
  return { sensitiveExtra: [], unsafeRead: ["grok"], unsafeExec: [], verifyEnv: [], cliEnv: {}, extraWritable: [], verifyTimeoutMin: 10 }
}

test("local page rejects missing tokens and writes the selection", async () => {
  const dir = temp()
  writeFileSync(path.join(dir, "routing.toml"), `
[positions.explore]
chain = [{ model = "haiku-5.5", effort = "low" }]
[positions.plan]
chain = [{ model = "haiku-5.5", effort = "low" }]
[positions.review]
chain = [{ model = "haiku-5.5", effort = "low" }]
max_rounds = 3
[positions.exec]
effort = "high"
[positions.exec.pools]
mechanical = ["haiku-5.5"]
standard = ["haiku-5.5"]
hard = ["haiku-5.5"]
[safety]
unsafe_read = ["grok"]
verify_env = ["CI"]
[safety.cli_env]
claude = []
codex = []
grok = []
pi = []
`)
  const handle = await startConfigUi({ dir, open: false, port: 0, discoverModels: async () => discovered, claudeIds: ["claude-haiku-5-5"] })
  try {
    const origin = new URL(handle.url).origin
    expect((await fetch(origin + "/api/state")).status).toBe(404)
    const token = new URL(handle.url).searchParams.get("token")!
    const headers = { authorization: `Bearer ${token}` }
    const page = await fetch(handle.url)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("模型配置")
    const state = await (await fetch(origin + "/api/state", { headers })).json() as { state: { routes: { key: string, alias: string, provider: string, enabled: boolean }[], maxRounds: number } }
    expect(state.state.maxRounds).toBe(3)
    const haiku = state.state.routes.find((route) => route.alias === "haiku-5.5" && route.provider === "claude")!
    const grok = state.state.routes.find((route) => route.alias === "grok-4.7")!
    expect(haiku.enabled).toBe(false)
    const saved = await fetch(origin + "/api/save", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
      enabled: [haiku.key, grok.key],
      explore: [{ alias: "haiku-5.5", effort: "low" }],
      plan: [{ alias: "grok-4.7", effort: "high" }],
      review: [{ alias: "grok-4.7", effort: "high" }],
      pools: { mechanical: [{ alias: "haiku-5.5", effort: "low" }], standard: [{ alias: "grok-4.7", effort: "high" }], hard: [{ alias: "grok-4.7", effort: "high" }] },
      timeouts: { explore: 5, plan: 10, review: 15, exec: 30 }, maxRounds: 3, execEffort: "high",
    }) })
    expect(saved.status).toBe(200)
    expect(loadConfig(dir).safety.verifyEnv).toEqual(["CI"])
    expect(loadConfig(dir).routing.review.maxRounds).toBe(3)
    const forged = await fetch(origin + "/api/save", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ enabled: ["codex\0gpt\0gpt-6.1-sol"] }) })
    expect(forged.status).toBe(400)
    expect(readFileSync(path.join(dir, "models.conf"), "utf8")).toContain("claude-haiku-5-5")
  } finally { handle.stop() }
})

test("ui rejects unknown arguments before opening a page", async () => {
  await expect(configMain(["ui", "--browser"])).rejects.toThrow("--port")
})
