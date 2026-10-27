import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { ProviderName } from "./providers/types.ts"
import { scanText } from "./safety.ts"

export type PoolName = "mechanical" | "standard" | "hard"
export const PROVIDERS: ProviderName[] = ["claude", "codex", "grok", "pi"]
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
const POOLS: PoolName[] = ["mechanical", "standard", "hard"]

export interface Capability {
  family: string
  match: string[]
  efforts: Partial<Record<ProviderName, string[]>>
}
export type Catalog = Record<string, Capability>
export interface ModelRow {
  alias: string
  provider: ProviderName
  modelId: string
  family: string
  efforts: string[] | null
  legacyPrice?: boolean
  /** Dollars per million tokens; missing prices remain unknown. */
  price: { input: number | null, output: number | null, cacheRead: number | null, cacheWrite: number | null }
}
export interface RoleModel { model: string, effort: string }
export interface Position { chain: RoleModel[], timeoutMin: number }
export interface Routing {
  explore: Position
  plan: Position
  exec: { effort: string, defaultPool: PoolName, pools: Record<PoolName, RoleModel[]>, timeoutMin: number }
  review: Position & { maxRounds: number }
}
export interface SafetyConfig {
  sensitiveExtra: string[]
  unsafeRead: ProviderName[]
  unsafeExec: ProviderName[]
  verifyEnv: string[]
  cliEnv: Partial<Record<ProviderName, string[]>>
  extraWritable: string[]
  verifyTimeoutMin: number
}
export interface ConfigLocation { dir: string, usingSample: boolean, modelsFile: string, routingFile: string }
export interface LoadedConfig {
  models: ModelRow[]
  routing: Routing
  safety: SafetyConfig
  catalog: Catalog
  usingSample: boolean
  dir: string
  warnings: string[]
}

type Bag = Record<string, unknown>
function bag(value: unknown, label: string): Bag {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是表`)
  return value as Bag
}
function keys(value: Bag, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${label} 未知配置项：${unknown.join(", ")}`)
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${label} 必须是非空单行字符串`)
  return value
}
function strings(value: unknown, label: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(`${label} 必须是${allowEmpty ? "" : "非空"}字符串数组`)
  const result = value.map((item) => text(item, label))
  if (new Set(result).size !== result.length) throw new Error(`${label} 不能重复`)
  return result
}
function effort(value: unknown, label: string): string {
  const result = text(value, label)
  if (!EFFORTS.includes(result)) throw new Error(`${label} 未知思考程度：${result}`)
  return result
}
function positive(value: unknown, fallback: number, label: string, zero = false): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || (zero ? value < 0 : value <= 0)) throw new Error(`${label} 必须是${zero ? "非负" : "正"}数`)
  return value
}
function toml(source: string, label: string): Bag {
  try { return bag(Bun.TOML.parse(source), label) }
  catch (error) { throw new Error(`${label} 解析失败：${(error as Error).message}`) }
}
export function skillRoot(): string { return path.resolve(import.meta.dir, "..") }
export function configDir(): string {
  return process.env.ORCHESTRATE_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "orchestrate")
}
export function resolveConfigDir(sample = false): ConfigLocation {
  const dir = configDir()
  const models = existsSync(path.join(dir, "models.conf"))
  const routing = existsSync(path.join(dir, "routing.toml"))
  if (!sample && models !== routing) throw new Error(`配置不完整：${dir} 缺少 ${models ? "routing.toml" : "models.conf"}；运行 config.sh init --propose，再审阅并 --apply`)
  if (!sample && models && routing) return { dir, usingSample: false, modelsFile: "models.conf", routingFile: "routing.toml" }
  return { dir: path.join(skillRoot(), "references"), usingSample: true, modelsFile: "models.sample.conf", routingFile: "routing.example.toml" }
}
export function parseCatalog(source: string): Catalog {
  const parsed = toml(source, "catalog.toml")
  const result: Catalog = Object.create(null)
  for (const [alias, raw] of Object.entries(parsed)) {
    const value = bag(raw, `catalog.${alias}`)
    keys(value, ["family", "match", "efforts"], `catalog.${alias}`)
    const matches = strings(value.match, `catalog.${alias}.match`, false)
    for (const pattern of matches) {
      try { new RegExp(pattern, "i") } catch { throw new Error(`catalog.${alias}.match 正则无效`) }
    }
    const supports = bag(value.efforts ?? {}, `catalog.${alias}.efforts`)
    keys(supports, PROVIDERS, `catalog.${alias}.efforts`)
    const efforts: Capability["efforts"] = {}
    for (const [provider, levels] of Object.entries(supports)) efforts[provider as ProviderName] = strings(levels, `${alias}.efforts.${provider}`, false).map((level) => effort(level, alias))
    result[alias] = { family: text(value.family, `${alias}.family`), match: matches, efforts }
  }
  if (!Object.keys(result).length) throw new Error("catalog.toml 不能为空")
  return result
}
export function loadCatalog(file = path.join(skillRoot(), "references/catalog.toml")): Catalog { return parseCatalog(readFileSync(file, "utf8")) }
function prices(cells: string[]): ModelRow["price"] {
  if (cells.length > 4) throw new Error("price 最多四列")
  const values = [0, 1, 2, 3].map((index) => {
    const value = cells[index]
    if (value === undefined || value === "") return null
    if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new Error("价格必须是非负有限数字")
    return Number(value)
  })
  return { input: values[0], output: values[1], cacheRead: values[2], cacheWrite: values[3] }
}
export function parseModels(source: string, catalog = loadCatalog()): ModelRow[] {
  const rows: ModelRow[] = []
  const seen = new Set<string>()
  for (const [lineNumber, raw] of source.split("\n").entries()) {
    const line = raw.replace(/\s+#.*$/, "").trim()
    if (!line || line.startsWith("#")) continue
    const [alias, provider, modelId, ...rest] = line.split(/\s+/)
    const label = `models.conf:${lineNumber + 1}`
    if (!alias || !provider || !modelId) throw new Error(`${label} 至少需要三列`)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,240}$/.test(modelId) || scanText(modelId).flags.length) throw new Error(`${label} 模型 ID 格式无效或含敏感内容，拒绝作为外发参数`)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias)) throw new Error(`${label} 能力名无效`)
    if (!PROVIDERS.includes(provider as ProviderName)) throw new Error(`${label} 未知 provider：${provider}`)
    const fields: Record<string, string> = {}
    const legacyPrice = rest.length > 0 && rest.every((cell) => !cell.includes("="))
    if (legacyPrice) fields.price = rest.join(",")
    else for (const cell of rest) {
      const eq = cell.indexOf("=")
      if (eq < 1) throw new Error(`${label} 请勿混用位置价格和 key=value`)
      const key = cell.slice(0, eq)
      if (!["family", "efforts", "price"].includes(key)) throw new Error(`${label} 未知 key：${key}`)
      if (key in fields) throw new Error(`${label} 重复 key：${key}`)
      fields[key] = cell.slice(eq + 1)
    }
    const family = fields.family ?? catalog[alias]?.family
    if (!family || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(family)) throw new Error(`${label} 能力 ${alias} 缺少或无效的 family`)
    const levels = fields.efforts !== undefined ? fields.efforts.split(",") : catalog[alias]?.efforts[provider as ProviderName] ?? null
    if (levels && (!levels.length || new Set(levels).size !== levels.length)) throw new Error(`${label} efforts 不能为空或重复`)
    const identity = `${alias}\0${provider}\0${modelId}`
    if (seen.has(identity)) throw new Error(`${label} 重复路由：${alias}@${provider}`)
    seen.add(identity)
    rows.push({ alias, provider: provider as ProviderName, modelId, family, efforts: levels?.map((level) => effort(level, label)) ?? null, legacyPrice, price: prices((fields.price ?? "").split(",")) })
  }
  if (!rows.length) throw new Error("models.conf 没有启用的路由")
  return rows
}
function candidate(value: unknown, label: string, defaultEffort?: string): RoleModel {
  if (typeof value === "string" && defaultEffort) return { model: text(value, label), effort: defaultEffort }
  const record = bag(value, label)
  keys(record, ["model", "effort"], label)
  return { model: text(record.model, `${label}.model`), effort: effort(record.effort, `${label}.effort`) }
}
function chain(value: unknown, label: string, defaultEffort?: string): RoleModel[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} 候选链不能为空`)
  const candidates = value.map((item) => candidate(item, label, defaultEffort))
  if (new Set(candidates.map((item) => item.model)).size !== candidates.length) throw new Error(`${label} 候选能力不能重复`)
  return candidates
}
function parseDocument(source: string): { routing: Routing, safety: SafetyConfig } {
  const document = toml(source, "routing.toml")
  keys(document, ["positions", "safety"], "routing.toml")
  const positions = bag(document.positions, "positions")
  keys(positions, ["explore", "plan", "exec", "review"], "positions")
  const position = (name: string, timeout: number): Position => {
    const record = bag(positions[name], `positions.${name}`)
    keys(record, name === "review" ? ["chain", "timeout_min", "max_rounds"] : ["chain", "timeout_min"], `positions.${name}`)
    return { chain: chain(record.chain, `positions.${name}.chain`), timeoutMin: positive(record.timeout_min, timeout, `${name}.timeout_min`) }
  }
  const exec = bag(positions.exec, "positions.exec")
  keys(exec, ["effort", "default_pool", "timeout_min", "pools"], "positions.exec")
  const pools = bag(exec.pools, "positions.exec.pools")
  keys(pools, POOLS, "positions.exec.pools")
  const execEffort = effort(exec.effort ?? "high", "positions.exec.effort")
  const defaultPool = exec.default_pool as PoolName
  if (!POOLS.includes(defaultPool)) throw new Error("positions.exec.default_pool 必须是 mechanical、standard 或 hard")
  const review = position("review", 15)
  const maxRounds = positive(bag(positions.review, "review").max_rounds, 2, "review.max_rounds", true)
  if (!Number.isInteger(maxRounds)) throw new Error("review.max_rounds 必须是整数")
  const safety = bag(document.safety ?? {}, "safety")
  keys(safety, ["sensitive_extra", "unsafe_read", "unsafe_exec", "verify_env", "cli_env", "extra_writable", "verify_timeout_min"], "safety")
  const providerList = (key: string): ProviderName[] => strings(safety[key] ?? [], `safety.${key}`).map((name) => {
    if (!PROVIDERS.includes(name as ProviderName)) throw new Error(`safety.${key} 未知 provider：${name}`)
    return name as ProviderName
  })
  const envNames = (value: unknown, label: string) => strings(value ?? [], label).map((name) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${label} 只能写环境变量名，不能写值`)
    return name
  })
  const cliEnv = bag(safety.cli_env ?? {}, "safety.cli_env")
  keys(cliEnv, PROVIDERS, "safety.cli_env")
  return {
    routing: {
      explore: position("explore", 5), plan: position("plan", 10), review: { ...review, maxRounds },
      exec: { effort: execEffort, defaultPool, timeoutMin: positive(exec.timeout_min, 30, "exec.timeout_min"), pools: Object.fromEntries(POOLS.map((name) => [name, chain(pools[name], `exec.pools.${name}`, execEffort)])) as Routing["exec"]["pools"] },
    },
    safety: {
      sensitiveExtra: strings(safety.sensitive_extra ?? [], "safety.sensitive_extra"), unsafeRead: providerList("unsafe_read"), unsafeExec: providerList("unsafe_exec"),
      verifyEnv: envNames(safety.verify_env, "safety.verify_env"), cliEnv: Object.fromEntries(Object.entries(cliEnv).map(([name, value]) => [name, envNames(value, `safety.cli_env.${name}`)])),
      extraWritable: strings(safety.extra_writable ?? [], "safety.extra_writable"), verifyTimeoutMin: positive(safety.verify_timeout_min, 10, "safety.verify_timeout_min"),
    },
  }
}
export function parseRouting(source: string): Routing { return parseDocument(source).routing }
export function parseSafety(source: string): SafetyConfig { return parseDocument(source).safety }
export function validateConfig(config: Pick<LoadedConfig, "models" | "routing">): void {
  const { models, routing } = config
  for (const row of models) if (typeof row.family !== "string" || !row.family.trim()) throw new Error(`能力 ${row.alias} 缺少 family`)
  const all = [...routing.explore.chain, ...routing.plan.chain, ...routing.review.chain, ...Object.values(routing.exec.pools).flat()]
  for (const item of all) if (!models.some((row) => row.alias === item.model)) throw new Error(`routing.toml 引用了未配置的能力：${item.model}`)
  for (const alias of new Set(models.map((row) => row.alias))) {
    const families = new Set(models.filter((row) => row.alias === alias).map((row) => row.family))
    if (families.size !== 1) throw new Error(`能力 ${alias} 的路由 family 不一致`)
  }
  for (const [name, pool] of Object.entries(routing.exec.pools)) if (!pool.some((item) => models.some((row) => row.alias === item.model && row.provider !== "pi"))) throw new Error(`执行池 ${name} 只有 pi 路由，pi 不能执行`)
}
export function validateExecPin(alias: string | undefined, config: Pick<LoadedConfig, "models">): void {
  if (alias && !config.models.some((row) => row.alias === alias)) throw new Error(`--exec 未知能力：${alias}`)
  if (alias && !config.models.some((row) => row.alias === alias && row.provider !== "pi")) throw new Error(`--exec ${alias} 只有 pi 路由，不能执行`)
}
export function loadConfig(location: ConfigLocation | string = resolveConfigDir()): LoadedConfig {
  const resolved = typeof location === "string" ? { dir: location, usingSample: false, modelsFile: "models.conf", routingFile: "routing.toml" } : location
  const catalog = loadCatalog()
  const models = parseModels(readFileSync(path.join(resolved.dir, resolved.modelsFile), "utf8"), catalog)
  const { routing, safety } = parseDocument(readFileSync(path.join(resolved.dir, resolved.routingFile), "utf8"))
  const config: LoadedConfig = { models, routing, safety, catalog, usingSample: resolved.usingSample, dir: resolved.dir, warnings: [] }
  validateConfig(config)
  if (models.some((row) => row.legacyPrice)) config.warnings.push("models.conf 使用旧位置价格列；config.sh init --propose 可迁移为 price=")
  if (resolved.usingSample) config.warnings.push("使用 skill 示例配置（不是本机已验证路由）")
  return config
}
/** Unknown authors conflict with every family; never infer a family from an alias. */
export function familyOf(alias: string, models: ModelRow[] = []): string {
  const families = new Set(models.filter((row) => row.alias === alias).map((row) => row.family))
  return families.size === 1 ? [...families][0] : "unknown"
}
export function serializeModels(rows: ModelRow[]): string {
  return "# <capability> <provider> <local-id> [family=...] [efforts=...] [price=input,output,cache-read,cache-write]\n" + rows.map((row) => {
    const fields = [`${row.alias} ${row.provider} ${row.modelId}`, `family=${row.family}`]
    if (row.efforts) fields.push(`efforts=${row.efforts.join(",")}`)
    if (Object.values(row.price).some((value) => value !== null)) fields.push(`price=${[row.price.input, row.price.output, row.price.cacheRead, row.price.cacheWrite].map((value) => value ?? "").join(",")}`)
    return fields.join(" ")
  }).join("\n") + "\n"
}
