import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { configDir, loadCatalog, loadConfig, parseModels, parseRouting, parseSafety, PROVIDERS, resolveConfigDir, serializeModels, skillRoot, validateConfig, type Catalog, type ModelRow, type Routing, type SafetyConfig } from "./config.ts"
import { detectHosts } from "./preflight.ts"
import type { ProviderName } from "./providers/types.ts"
import { pickEffort } from "./providers/effort.ts"
import { scanText, sanitizeValue } from "./safety.ts"

export interface Discovery { provider: ProviderName, ids: string[], installed: boolean, loggedIn: boolean }
const safeId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,240}$/.test(id)
const print = (value: string) => console.log(scanText(value).text)

/** Listing commands vary between versions; never forward unparsed CLI output. */
export function parseModelList(provider: ProviderName, output: string): string[] {
  const ids = new Set<string>()
  const add = (value: unknown) => { if (typeof value === "string" && safeId(value)) ids.add(value) }
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach((item) => typeof item === "string" ? add(item) : walk(item)); return }
    if (!value || typeof value !== "object") return
    const item = value as Record<string, unknown>
    for (const key of ["slug", "id", "modelId"]) add(item[key])
    for (const key of ["models", "data", "items"]) if (item[key]) walk(item[key])
  }
  try { walk(JSON.parse(output)) } catch { /* Some CLIs list a plain-text table. */ }
  for (const raw of output.split("\n")) {
    const row = raw.trim()
    if (!row || /^(?:provider|model|available|context|[-=]{3})\b/i.test(row)) continue
    const slug = row.match(/"(?:slug|id|modelId)"\s*:\s*"([^"]+)"/)
    if (slug) { add(slug[1]); continue }
    if (provider === "grok") { const bullet = row.match(/^-\s+(\S+)/); if (bullet) add(bullet[1]) }
    if (provider === "pi") {
      const fields = row.split(/\s+/)
      if (fields.length >= 2 && safeId(fields[0]) && safeId(fields[1])) add(`${fields[0]}/${fields[1]}`)
    }
  }
  return [...ids]
}

export async function discover(): Promise<Discovery[]> {
  const hosts = await detectHosts()
  return Promise.all(hosts.map(async (host) => {
    const result: Discovery = { provider: host.provider, ids: [], installed: host.installed, loggedIn: host.loggedIn }
    if (!host.installed || !host.loggedIn || host.provider === "claude") return result
    const argv = host.provider === "grok" ? ["grok", "models"] : host.provider === "pi" ? ["pi", "--list-models"] : ["codex", "debug", "models"]
    try {
      const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(20_000) })
      const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      if (code === 0) result.ids = parseModelList(host.provider, output)
    } catch { /* A listing failure does not prove that the provider is unusable. */ }
    return result
  }))
}

export function proposedModels(catalog: Catalog, discovered: Discovery[], existing = ""): { rows: ModelRow[], unmatched: string[], warnings: string[] } {
  const warnings: string[] = []
  const migrated = existing.replace(/^grok-4\.7-build-fast(?=\s)/gm, "grok-4.7-fast")
  if (migrated !== existing) warnings.push("旧能力名 grok-4.7-build-fast 迁移为 grok-4.7-fast，路由 ID 不变")
  const rows = migrated.trim() ? parseModels(migrated, catalog) : []
  const seen = new Set(rows.map((row) => `${row.alias}\0${row.provider}\0${row.modelId}`))
  const unmatched: string[] = []
  for (const host of discovered) {
    if (!host.installed || !host.loggedIn) continue
    const ids = host.provider === "claude" ? ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] : host.ids
    for (const modelId of ids) {
      const aliases = Object.entries(catalog).filter(([, capability]) => capability.match.some((match) => new RegExp(match, "i").test(modelId)))
      if (!aliases.length) { unmatched.push(`${host.provider} ${modelId}`); continue }
      for (const [alias, capability] of aliases) {
        const key = `${alias}\0${host.provider}\0${modelId}`
        if (seen.has(key)) continue
        seen.add(key)
        rows.push({ alias, provider: host.provider, modelId, family: capability.family, efforts: capability.efforts[host.provider] ?? null, price: { input: null, output: null, cacheRead: null, cacheWrite: null } })
      }
    }
  }
  return { rows, unmatched, warnings }
}

export function serializeRouting(routing: Routing, safety: SafetyConfig): string {
  const quote = JSON.stringify
  const list = (items: string[]) => `[${items.map((item) => quote(item)).join(", ")}]`
  const chain = (items: { model: string, effort: string }[]) => `[${items.map((item) => `{ model = ${quote(item.model)}, effort = ${quote(item.effort)} }`).join(", ")}]`
  const out = ["# Review this proposal and order the local routes in models.conf before applying."]
  for (const name of ["explore", "plan", "review"] as const) {
    out.push(`\n[positions.${name}]`, `chain = ${chain(routing[name].chain)}`, `timeout_min = ${routing[name].timeoutMin}`)
    if (name === "review") out.push(`max_rounds = ${routing.review.maxRounds}`)
  }
  out.push("\n[positions.exec]", `effort = ${quote(routing.exec.effort)}`, `default_pool = ${quote(routing.exec.defaultPool)}`, `timeout_min = ${routing.exec.timeoutMin}`, "\n[positions.exec.pools]")
  for (const [name, pool] of Object.entries(routing.exec.pools)) out.push(`${name} = ${chain(pool)}`)
  out.push("\n[safety]", `sensitive_extra = ${list(safety.sensitiveExtra)}`, `unsafe_read = ${list(safety.unsafeRead)}`, `unsafe_exec = ${list(safety.unsafeExec)}`, `verify_env = ${list(safety.verifyEnv)}`, `extra_writable = ${list(safety.extraWritable)}`, `verify_timeout_min = ${safety.verifyTimeoutMin}`, "\n[safety.cli_env]")
  for (const [provider, names] of Object.entries(safety.cliEnv)) out.push(`${provider} = ${list(names)}`)
  return out.join("\n") + "\n"
}

export function writeProposal(dir: string, discovered: Discovery[], catalog = loadCatalog()): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const existingModels = path.join(dir, "models.conf")
  const proposed = proposedModels(catalog, discovered, existsSync(existingModels) ? readFileSync(existingModels, "utf8") : "")
  if (!proposed.rows.length) throw new Error("没有发现或保留任何路由；先登录 CLI，或手工准备 models.conf.proposed")
  let routingSource = readFileSync(path.join(skillRoot(), "references/routing.example.toml"), "utf8")
  const existingRouting = path.join(dir, "routing.toml")
  if (existsSync(existingRouting)) {
    const old = readFileSync(existingRouting, "utf8")
    try { parseRouting(old); routingSource = old }
    catch { proposed.warnings.push("原 routing.toml 不是 v2 格式；保留原文件，提案使用新的位置配置") }
  }
  const routing = parseRouting(routingSource)
  const safety = parseSafety(routingSource)
  const aliases = new Set(proposed.rows.map((row) => row.alias))
  // Leave missing positions explicit rather than silently inventing a different model.
  for (const name of ["explore", "plan", "review"] as const) {
    const candidates = routing[name].chain.filter((item) => aliases.has(item.model))
    if (candidates.length) routing[name].chain = candidates
    else proposed.warnings.push(`${name} 没有匹配路由；请编辑 proposed 文件补齐，否则 apply 会拒绝`)
  }
  for (const [name, pool] of Object.entries(routing.exec.pools)) {
    const candidates = pool.filter((item) => aliases.has(item.model))
    if (candidates.length) routing.exec.pools[name as keyof typeof routing.exec.pools] = candidates
    else proposed.warnings.push(`${name} 池没有匹配路由；请编辑 proposed 文件补齐，否则 apply 会拒绝`)
  }
  const modelsText = serializeModels(proposed.rows), routingText = serializeRouting(routing, safety)
  if (scanText(modelsText).flags.length || scanText(routingText).flags.length) throw new Error("配置提案命中敏感内容，未写入；请从路由 ID 中移除凭证")
  writeFileSync(path.join(dir, "models.conf.proposed"), modelsText, { mode: 0o600 })
  writeFileSync(path.join(dir, "routing.toml.proposed"), routingText, { mode: 0o600 })
  return ["提案已生成，现有配置没有改动：", ...proposed.rows.map((row) => `${row.alias}\t${row.provider}\t${row.modelId}`), ...proposed.warnings.map((warning) => `WARN ${warning}`), ...proposed.unmatched.map((id) => `未匹配 ${id}`), `审阅：${dir}/models.conf.proposed 与 routing.toml.proposed`, "确认路由与顺序后：config.sh init --apply"]
}

export function applyProposal(dir: string, now = new Date()): string[] {
  const names = ["models.conf", "routing.toml"]
  for (const name of names) if (!existsSync(path.join(dir, `${name}.proposed`))) throw new Error(`缺少 ${name}.proposed；先运行 init --propose`)
  const modelsSource = readFileSync(path.join(dir, "models.conf.proposed"), "utf8")
  const models = parseModels(modelsSource)
  const source = readFileSync(path.join(dir, "routing.toml.proposed"), "utf8")
  if (scanText(modelsSource).flags.length || scanText(source).flags.length) throw new Error("配置提案含敏感内容，拒绝应用")
  validateConfig({ models, routing: parseRouting(source) })
  parseSafety(source)
  const stamp = now.toISOString().replace(/[:.]/g, "-") + `-${crypto.randomUUID().slice(0, 8)}`
  const results: string[] = []
  for (const name of names) {
    const file = path.join(dir, name)
    if (existsSync(file)) { copyFileSync(file, `${file}.backup-${stamp}`); results.push(`已备份 ${name}.backup-${stamp}`) }
  }
  // Validate both proposals before replacing either active file.
  for (const name of names) {
    const file = path.join(dir, name), temp = `${file}.tmp-${stamp}`
    copyFileSync(`${file}.proposed`, temp)
    renameSync(temp, file)
  }
  loadConfig(dir)
  results.push("已应用并通过 check；未更改任何登录凭证或隔离准入记录")
  if (existsSync(path.join(dir, "routing.md"))) results.push("routing.md 不再读取，旧文件没有改动")
  return results
}

export function unavailableCacheFile(): string { return path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "orchestrate/unavailable.json") }

async function paidProbe(args: string[]): Promise<number> {
  const config = loadConfig(resolveConfigDir(args.includes("--sample")))
  const alias = args.find((arg) => !arg.startsWith("--"))
  const rows = config.models.filter((row) => !alias || row.alias === alias || `${row.alias}@${row.provider}` === alias)
  if (!rows.length) throw new Error("probe 没有匹配到路由")
  print(`probe 将请求 ${rows.length} 次；价格与单次 token 数未知，不能预估或保证费用上限。`)
  if (!args.includes("--confirm-paid")) throw new Error("付费探测没有运行；经用户明确同意后加 --confirm-paid（建议指定 能力@provider）")
  const { routeAdmission } = await import("./sandbox.ts")
  const admission = rows.map((row) => ({ row, status: routeAdmission(row.provider, "explore", config.safety) }))
  if (admission.some((item) => !item.status.admitted)) throw new Error(`probe 未运行：${admission.filter((item) => !item.status.admitted).map((item) => item.status.reason).join("；")}`)
  const { cliProvider } = await import("./cli-provider.ts")
  const { safeEnv, scanText } = await import("./safety.ts")
  const dir = mkdtempSync(path.join(tmpdir(), "orch-probe-"))
  const records: unknown[] = []
  let failures = 0
  try {
    for (const row of rows) {
      const started = Date.now()
      const effort = row.efforts ? pickEffort("low", row.efforts) : "low"
      let version = "unknown"
      try {
        const proc = Bun.spawn([row.provider, "--version"], { stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(5000) })
        const output = await new Response(proc.stdout).text()
        if (await proc.exited === 0) version = scanText(output.trim().slice(0, 160)).text
      } catch { /* Version metadata is not proof of successful isolation. */ }
      try {
        const result = await cliProvider().run({ provider: row.provider, role: "explore", model: row.modelId, effort, supportedEfforts: row.efforts ?? undefined, prompt: "Reply with the single word OK. Do not read files or use tools.", cwd: dir, sessionId: crypto.randomUUID(), timeoutMs: 120_000, env: safeEnv("worker", config.safety.cliEnv[row.provider] ?? [], dir) })
        records.push({ alias: row.alias, provider: row.provider, model: row.modelId, requestedEffort: "low", effort, version, date: new Date().toISOString(), ok: !result.error, usage: result.usage, durationMs: Date.now() - started })
        if (result.error) failures++
        print(`${row.alias}@${row.provider}\t${result.error ? "失败" : "回答成功"}；只证明本次参数可回答，不证明能力或隔离`)
      } catch {
        failures++
        records.push({ alias: row.alias, provider: row.provider, model: row.modelId, requestedEffort: "low", effort, version, date: new Date().toISOString(), ok: false, cost: "unknown", durationMs: Date.now() - started })
        print(`${row.alias}@${row.provider}\t失败，金额未知`)
      }
    }
    const outputDir = configDir()
    mkdirSync(outputDir, { recursive: true, mode: 0o700 })
    const file = path.join(outputDir, `probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
    writeFileSync(file, JSON.stringify(sanitizeValue(records).value, null, 2) + "\n", { mode: 0o600 })
    print(`记录：${file}（没有改变隔离准入）`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
  return failures ? 1 : 0
}

export async function configMain(args = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args
  const dir = configDir()
  if (["where", "detect", "preflight"].includes(command) && rest.length) throw new Error(`${command} 不接受额外参数`)
  if (command === "where") { print(dir); return 0 }
  if (command === "detect") {
    for (const host of await discover()) print(`${host.provider}\t${host.installed ? "已安装" : "未安装"}\t${host.loggedIn ? "已登录" : "未登录"}${host.ids.length ? "\n" + host.ids.join("\n") : ""}`)
    return 0
  }
  if (command === "preflight") {
    for (const host of await detectHosts()) print(`${host.provider}\t${host.installed ? "已安装" : "未安装"}\t${host.detail}`)
    return 0
  }
  if (command === "init") {
    if (rest.length !== 1 || !["--propose", "--apply"].includes(rest[0])) throw new Error("init 必须显式指定 --propose 或 --apply；不会直接覆盖现有配置")
    print((rest[0] === "--propose" ? writeProposal(dir, await discover()) : applyProposal(dir)).join("\n")); return 0
  }
  if (command === "check" || command === "efforts") {
    if (rest.some((arg) => arg !== "--sample")) throw new Error(`${command} 只接受 --sample；efforts 只显示声明值，不偷偷发送非法档位请求`)
    const config = loadConfig(resolveConfigDir(rest.includes("--sample")))
    for (const row of config.models) print(command === "efforts" ? `${row.alias}@${row.provider}\t${row.efforts?.join(",") ?? "未声明：交 CLI 判断"}` : `OK ${row.alias}@${row.provider} -> ${row.modelId} family=${row.family}`)
    for (const warning of config.warnings) print(`WARN ${warning}`)
    if (command === "check") {
      const hosts = await detectHosts()
      for (const host of hosts) if (config.models.some((row) => row.provider === host.provider) && (!host.installed || !host.loggedIn)) print(`WARN ${host.provider} ${host.detail}`)
      print("配置有效；不表示路由能回答、适合任务或隔离已验证")
    }
    return 0
  }
  if (command === "cache" && rest.length === 1 && rest[0] === "clear") { rmSync(unavailableCacheFile(), { force: true }); print("已清空模型不可用缓存"); return 0 }
  if (command === "probe") {
    if (rest.filter((arg) => !arg.startsWith("--")).length > 1 || rest.some((arg) => arg.startsWith("--") && !["--sample", "--confirm-paid"].includes(arg))) throw new Error("probe 参数无效")
    return paidProbe(rest)
  }
  if (command === "isolation") {
    if (rest.length === 1 && rest[0] === "verify") {
      const { runVerificationIsolation } = await import("./isolation.ts")
      const result = await runVerificationIsolation()
      print(`验收沙箱本地探针：${result.status}（0 token，不产生模型外壳准入记录）`)
      for (const probe of result.probes) print(`${probe.outcome}\t${probe.name}\t${probe.reason}`)
      for (const limitation of result.limitations) print(`范围：${limitation}`)
      return result.status === "pass" ? 0 : 5
    }
    if (rest.length !== 1 || !PROVIDERS.includes(rest[0] as ProviderName)) throw new Error("isolation 需要 claude/codex/grok/pi 之一；本版不自动启动付费隔离探针")
    print(`${rest[0]}：隔离未验证，默认不准入；没有启动模型或写入通过记录。`)
    print("真实隔离需要单独授权并覆盖五层边界、CLI 版本、工具子进程、认证变量及读取限制；--confirm-paid 不会代替这些证据。")
    return 5
  }
  throw new Error("用法：config.sh where|detect|preflight|check [--sample]|init --propose/--apply|efforts [--sample]|probe [能力@provider] --confirm-paid|isolation <provider|verify>|cache clear")
}

if (import.meta.main) {
  try { process.exit(await configMain()) }
  catch (error) {
    const { scanText } = await import("./safety.ts")
    console.error(scanText((error as Error).message).text)
    process.exit(2)
  }
}
