import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { familyOf, loadCatalog, loadConfig, parseCatalog, parseModels, parseRouting, parseSafety, resolveConfigDir, serializeModels, skillRoot, validateActor, validateConfig, validateExecPin } from "./config.ts"
import { applyProposal, configMain, parseModelList, proposedModels, writeProposal, type Discovery } from "./config-cli.ts"
import { detectHosts } from "./preflight.ts"

const folders: string[] = []
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "orch-config-")); folders.push(dir); return dir }
const routingSource = () => readFileSync(path.join(skillRoot(), "references/routing.example.toml"), "utf8")
const modelsSource = () => readFileSync(path.join(skillRoot(), "references/models.sample.conf"), "utf8")
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe("catalog and model routes", () => {
  test("catalog matches native, group and gateway IDs without matching a different capability", () => {
    const catalog = loadCatalog()
    const gpt = catalog["gpt-6.1-sol"].match.map((pattern) => new RegExp(pattern))
    expect(gpt.some((regex) => regex.test("magpie/group/auto-gpt-6-1-sol"))).toBe(true)
    expect(gpt.some((regex) => regex.test("magpie/copilot/gpt-6.1-sol"))).toBe(true)
    expect(gpt.some((regex) => regex.test("gpt-6-sol"))).toBe(false)
    const fast = new RegExp(catalog["grok-4.7-fast"].match[0])
    expect(fast.test("grok-4.7-build-fast")).toBe(true)
    expect(fast.test("magpie/grok/grok-4.7-fast")).toBe(true)
    expect(fast.test("grok-4.7")).toBe(false)
  })
  test("unknown catalog fields, duplicate keys, invalid regex and dotted unquoted names fail closed", () => {
    expect(() => parseCatalog('["x"]\nfamily="a"\nmatch=["["]')).toThrow()
    expect(() => parseCatalog('["x"]\nfamily="a"\nmatch=["x"]\nfoo=1')).toThrow("未知")
    expect(() => parseCatalog('["x"]\nfamily="a"\nfamily="b"\nmatch=["x"]')).toThrow()
    expect(() => parseCatalog('[opus-5.5]\nfamily="a"\nmatch=["x"]')).toThrow()
  })
  test("old 3-column and numeric prices survive, overrides do not depend on model ID substrings", () => {
    const rows = parseModels("opus-5.5 claude arbitrary-local-id 5 25 0.5 6.25\nglm-5.3-flash grok gateway/opaque\ncustom pi foo/bar family=acme efforts=low,high price=1,2,,")
    expect(rows[0].price).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    expect(rows[0].legacyPrice).toBe(true)
    expect(rows[1].efforts).toEqual(["low", "high", "max"])
    expect(rows[2].family).toBe("acme")
    expect(rows[2].efforts).toEqual(["low", "high"])
    expect(rows[2].price.cacheRead).toBeNull()
    expect(parseModels(serializeModels(rows))).toEqual(rows.map((row) => ({ ...row, legacyPrice: false })))
  })
  test.each([
    "custom pi foo/bar", "opus-5.5 nope foo", "opus-5.5 claude foo thing=1", "opus-5.5 claude foo family=a family=b", "opus-5.5 claude foo efforts=banana", "opus-5.5 claude foo efforts=", "opus-5.5 claude foo efforts=low,low", "opus-5.5 claude foo price=-1,2", "opus-5.5 claude foo price=1,2,3,4,5", "opus-5.5 claude foo 1 price=2", "opus-5.5 claude foo\nopus-5.5 claude foo",
  ])("reject invalid route: %s", (source) => expect(() => parseModels(source)).toThrow())
  test("unknown family never derives from alias, inconsistent family routes fail", () => {
    expect(familyOf("opus-5.5")).toBe("unknown")
    const models = parseModels("opus-5.5 claude opaque")
    expect(familyOf("opus-5.5", models)).toBe("anthropic")
    const config = loadConfig(resolveConfigDir(true))
    config.models.push({ ...config.models[0], provider: "codex", family: "openai" })
    expect(() => validateConfig(config)).toThrow("family 不一致")
  })
  test("controller identity uses explicit model or catalog families, never a guessed name", () => {
    const config = loadConfig(resolveConfigDir(true))
    config.models = config.models.filter((row) => row.alias !== "sonnet-5.5")
    expect(() => validateActor("sonnet-5.5", "--by", config)).not.toThrow()
    expect(familyOf("sonnet-5.5", config.models, config.catalog)).toBe("anthropic")
    expect(() => validateActor("sonnet-typo", "--by", config)).toThrow("--by 未知能力")
  })
})

describe("strict routing and configuration location", () => {
  test("mixed execution pool entries, per-candidate efforts and safe defaults", () => {
    const config = loadConfig(resolveConfigDir(true))
    expect(config.routing.exec.pools.hard).toEqual([{ model: "gpt-6.1-sol", effort: "high" }, { model: "opus-5.5", effort: "high" }])
    expect(config.routing.exec.pools.standard[0]).toEqual({ model: "grok-4.7", effort: "high" })
    expect(config.routing.review.chain.at(-1)).toEqual({ model: "opus-5.5", effort: "medium" })
    expect(config.safety.unsafeRead).toEqual([])
    expect(config.safety.unsafeExec).toEqual([])
    expect(config.routing.exec.timeoutMin).toBe(30)
  })
  test.each([
    (text: string) => text + '\n[triage]\nsonnet="high"',
    (text: string) => text.replace('[positions.exec]', '[positions.exec]\ndefault_pool = "missing"'),
    (text: string) => text.replace('timeout_min = 5', 'timeout_min = -1'),
    (text: string) => text.replace('max_rounds = 2', 'max_rounds = 0.5'),
    (text: string) => text.replace('effort = "medium"', 'effort = "banana"'),
    (text: string) => text.replace('unsafe_read = []', 'unsafe_read = ["oops"]'),
    (text: string) => text.replace('verify_env = []', 'verify_env = ["TOKEN=value"]'),
    (text: string) => text.replace('unsafe_exec = []', 'unsafe_exec = []\nnetwork = "allow"'),
    (text: string) => text.replace('[positions.plan]\nchain = [{ model = "opus-5.5", effort = "medium" }, { model = "gpt-6.1-sol", effort = "high" }]', '[positions.plan]\nchain = []'),
    (text: string) => text.replace('standard = ["grok-4.7", "sonnet-5.5"]', 'standard = []'),
    (text: string) => text.replace('timeout_min = 5', 'timeout_min = 5\ntimeout_min = 6'),
  ])("reject invalid routing mutation %#", (mutate) => expect(() => parseRouting(mutate(routingSource()))).toThrow())
  test("unconfigured capability, pi-only pool and bad exec pin fail before calls", () => {
    const config = loadConfig(resolveConfigDir(true))
    expect(() => validateExecPin("typo", config)).toThrow("未知能力")
    expect(() => validateExecPin("grok-4.7", config)).not.toThrow()
    config.routing.plan.chain[0].model = "missing"
    expect(() => validateConfig(config)).toThrow("未配置")
    config.routing.plan.chain[0].model = "opus-5.5"
    config.models = config.models.filter((row) => row.provider === "pi" || row.alias !== "gpt-6.1-sol")
    config.routing.exec.pools.hard = [{ model: "gpt-6.1-sol", effort: "high" }]
    expect(() => validateConfig(config)).toThrow("只有 pi")
  })
  test("legacy default_pool is accepted without overriding plan-based execution pools", () => {
    const source = routingSource()
    expect(parseRouting(source.replace("[positions.exec]", '[positions.exec]\ndefault_pool = "hard"'))).toEqual(parseRouting(source))
  })
  test("all absent samples, partial configuration errors, both present use user, --sample overrides", () => {
    const dir = temp(), old = process.env.ORCHESTRATE_HOME
    process.env.ORCHESTRATE_HOME = dir
    try {
      expect(resolveConfigDir().usingSample).toBe(true)
      writeFileSync(path.join(dir, "models.conf"), modelsSource())
      expect(() => resolveConfigDir()).toThrow("routing.toml")
      expect(resolveConfigDir(true).usingSample).toBe(true)
      writeFileSync(path.join(dir, "routing.toml"), routingSource())
      expect(resolveConfigDir()).toMatchObject({ dir, usingSample: false })
      expect(loadConfig().usingSample).toBe(false)
      rmSync(path.join(dir, "models.conf"))
      expect(() => resolveConfigDir()).toThrow("models.conf")
    } finally { if (old === undefined) delete process.env.ORCHESTRATE_HOME; else process.env.ORCHESTRATE_HOME = old }
  })
  test("safety environment values rejected, names and per-provider lists retained", () => {
    const parsed = parseSafety(routingSource().replace('verify_env = []', 'verify_env = ["CI", "TEST_MODE"]'))
    expect(parsed.verifyEnv).toEqual(["CI", "TEST_MODE"])
    expect(parsed.cliEnv.pi).toEqual([])
  })
})

describe("proposals and zero-token host checks", () => {
  test("listing parses gateway, group, native IDs, codex JSON and pi table", () => {
    expect(parseModelList("grok", "Models:\n - grok-4.7-build-fast\n - magpie/group/auto-gpt-6-1-sol")).toEqual(["grok-4.7-build-fast", "magpie/group/auto-gpt-6-1-sol"])
    expect(parseModelList("codex", JSON.stringify({ data: [{ slug: "gpt-6.1-sol" }] }))).toEqual(["gpt-6.1-sol"])
    expect(parseModelList("pi", "provider model context\nmagpie/group auto-gpt-6-1-sol 200k")).toEqual(["magpie/group/auto-gpt-6-1-sol"])
  })
  test("proposal preserves existing prices and route order and reports unmatched IDs", () => {
    const discovered: Discovery[] = [{ provider: "grok", installed: true, loggedIn: true, ids: ["grok-4.7-build-fast", "magpie/group/auto-gpt-6-1-sol", "vendor/new-model"] }]
    const proposed = proposedModels(loadCatalog(), discovered, "opus-5.5 claude old-id 5 25\ngrok-4.7-build-fast grok old-fast")
    expect(proposed.rows[0].modelId).toBe("old-id")
    expect(proposed.rows[0].price.input).toBe(5)
    expect(proposed.rows[1].alias).toBe("grok-4.7-fast")
    expect(proposed.rows.some((row) => row.alias === "gpt-6.1-sol")).toBe(true)
    expect(proposed.unmatched).toEqual(["grok vendor/new-model"])
  })
  test("propose does not overwrite; apply validates then makes backups and runs check", () => {
    const dir = temp()
    writeFileSync(path.join(dir, "models.conf"), modelsSource())
    writeFileSync(path.join(dir, "routing.toml"), routingSource())
    writeProposal(dir, [])
    expect(readFileSync(path.join(dir, "models.conf"), "utf8")).toBe(modelsSource())
    const proposed = readFileSync(path.join(dir, "models.conf.proposed"), "utf8")
    applyProposal(dir)
    expect(readFileSync(path.join(dir, "models.conf"), "utf8")).toBe(proposed)
    expect(readdirSync(dir).filter((name) => name.includes("backup-")).length).toBe(2)
    expect(loadConfig(dir).safety.unsafeRead).toEqual([])
  })
  test("invalid proposal never changes either active file", () => {
    const dir = temp()
    writeFileSync(path.join(dir, "models.conf"), modelsSource())
    writeFileSync(path.join(dir, "routing.toml"), routingSource())
    writeProposal(dir, [])
    writeFileSync(path.join(dir, "models.conf.proposed"), "custom pi x family=custom")
    expect(() => applyProposal(dir)).toThrow()
    expect(readFileSync(path.join(dir, "models.conf"), "utf8")).toBe(modelsSource())
    expect(readFileSync(path.join(dir, "routing.toml"), "utf8")).toBe(routingSource())
    expect(readdirSync(dir).some((name) => name.includes("backup-"))).toBe(false)
  })
  test("host preflight only runs auth/listing commands and never includes raw error text", async () => {
    const calls: string[][] = []
    const hosts = await detectHosts({ which: () => true, probe: async (argv) => {
      calls.push(argv)
      if (argv[0] === "pi") throw new Error("secret-value-not-to-forward")
      return { code: 0, stdout: argv[0] === "claude" ? '{"loggedIn":true}' : argv[0] === "codex" ? "Logged in" : "- model", stderr: "" }
    } })
    expect(calls).toEqual([["claude", "auth", "status"], ["codex", "login", "status"], ["grok", "models"], ["pi", "--list-models"]])
    expect(hosts.filter((host) => host.loggedIn).length).toBe(3)
    expect(JSON.stringify(hosts)).not.toContain("secret-value")
  })
  test("init requires explicit mode; isolation never manufactures a passing record", async () => {
    await expect(configMain(["init"])).rejects.toThrow("--propose")
    expect(await configMain(["isolation", "grok"])).toBe(5)
  })
})
