import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { ProviderName } from "./providers/types.ts"

export type PoolName = "mechanical" | "standard" | "hard"

export interface ModelRow {
  alias: string
  provider: ProviderName
  modelId: string
  /** 美元 / 百万 token。缺了哪一列就是 null。 */
  price: { input: number | null, output: number | null, cacheRead: number | null, cacheWrite: number | null }
}

export interface RoleModel {
  model: string
  effort: string
}

export interface Routing {
  plan: { model: string, effort: string, fallback: string[], explore?: RoleModel }
  exec: { effort: string, defaultPool: PoolName, pools: Record<PoolName, string[]> }
  review: { model: string, effort: string, fallback: string[], fallbackEffort: string, maxRounds: number }
}

export interface ConfigLocation {
  dir: string
  usingSample: boolean
  modelsFile: string
  routingFile: string
}

export interface LoadedConfig {
  models: ModelRow[]
  routing: Routing
  /** 用的是 skill 自带示例，不是用户目录。 */
  usingSample: boolean
  dir: string
}

const PROVIDERS = new Set<ProviderName>(["claude", "codex", "grok", "pi"])

export function skillRoot(): string {
  return path.resolve(import.meta.dir, "..")
}

export function resolveConfigDir(): ConfigLocation {
  const sample = path.join(skillRoot(), "references")
  const fromEnv = process.env.ORCHESTRATE_HOME
  if (fromEnv && existsSync(path.join(fromEnv, "models.conf")) && existsSync(path.join(fromEnv, "routing.toml"))) {
    return { dir: fromEnv, usingSample: false, modelsFile: "models.conf", routingFile: "routing.toml" }
  }
  const user = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "orchestrate")
  if (existsSync(path.join(user, "models.conf")) && existsSync(path.join(user, "routing.toml"))) {
    return { dir: user, usingSample: false, modelsFile: "models.conf", routingFile: "routing.toml" }
  }
  return { dir: sample, usingSample: true, modelsFile: "models.sample.conf", routingFile: "routing.example.toml" }
}

export function loadConfig(dir: ConfigLocation | string = resolveConfigDir()): LoadedConfig {
  const resolved: ConfigLocation = typeof dir === "string"
    ? { dir, usingSample: false, modelsFile: "models.conf", routingFile: "routing.toml" }
    : dir
  return {
    models: parseModels(readFileSync(path.join(resolved.dir, resolved.modelsFile), "utf8")),
    routing: parseRouting(readFileSync(path.join(resolved.dir, resolved.routingFile), "utf8")),
    usingSample: resolved.usingSample,
    dir: resolved.dir,
  }
}

function priceOf(cell: string | undefined): number | null {
  if (!cell || !/^\d+(\.\d+)?$/.test(cell)) return null
  return Number(cell)
}

export function parseModels(text: string): ModelRow[] {
  const rows: ModelRow[] = []
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim()
    if (!line || line.startsWith("#")) continue
    const [alias, provider, modelId, input, output, cacheRead, cacheWrite] = line.split(/\s+/)
    if (!alias || !provider || !modelId) throw new Error(`models.conf 列数不够：${raw}`)
    if (!PROVIDERS.has(provider as ProviderName)) throw new Error(`models.conf 未知 provider：${provider}`)
    rows.push({
      alias,
      provider: provider as ProviderName,
      modelId,
      price: {
        input: priceOf(input),
        output: priceOf(output),
        cacheRead: priceOf(cacheRead),
        cacheWrite: priceOf(cacheWrite),
      },
    })
  }
  return rows
}

function stripComment(line: string): string {
  let quote = ""
  let out = ""
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      out += ch
      if (ch === quote) quote = ""
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      continue
    }
    if (ch === "#") break
    out += ch
  }
  return out.trim()
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseValue(raw: string): unknown {
  const value = raw.trim()
  if (value.startsWith("[")) {
    const body = value.slice(1, value.lastIndexOf("]"))
    if (!body.trim()) return []
    return body.split(",").map((item) => unquote(item)).filter(Boolean)
  }
  if (value.startsWith("{")) {
    const body = value.slice(1, value.lastIndexOf("}"))
    const record: Record<string, string> = {}
    for (const part of body.split(",")) {
      const eq = part.indexOf("=")
      if (eq < 0) continue
      record[part.slice(0, eq).trim()] = unquote(part.slice(eq + 1))
    }
    return record
  }
  if (/^\d+$/.test(value)) return Number(value)
  return unquote(value)
}

/** 只覆盖 routing.example.toml 用到的写法。 */
export function parseRouting(text: string): Routing {
  const bag: Record<string, Record<string, unknown>> = {}
  let section = ""
  for (const raw of text.split("\n")) {
    const line = stripComment(raw)
    if (!line) continue
    const heading = line.match(/^\[(.+)]$/)
    if (heading) {
      section = heading[1]
      bag[section] ??= {}
      continue
    }
    const eq = line.indexOf("=")
    if (eq < 0 || !section) throw new Error(`routing.toml 无法解析：${raw}`)
    bag[section][line.slice(0, eq).trim()] = parseValue(line.slice(eq + 1))
  }
  const plan = bag["roles.plan"] ?? {}
  const exec = bag["roles.exec"] ?? {}
  const review = bag["roles.review"] ?? {}
  const explore = plan.explore
  const pools = {
    mechanical: stringList(exec["pool.mechanical"]),
    standard: stringList(exec["pool.standard"]),
    hard: stringList(exec["pool.hard"]),
  }
  const defaultPool = exec.default_pool
  if (defaultPool !== "mechanical" && defaultPool !== "standard" && defaultPool !== "hard") {
    throw new Error("routing.toml 的 default_pool 必须是 mechanical、standard 或 hard")
  }
  if (!pools[defaultPool].length) throw new Error(`routing.toml 的 pool.${defaultPool} 是空的`)
  return {
    plan: {
      model: String(plan.model ?? ""),
      effort: String(plan.effort ?? "medium"),
      fallback: stringList(plan.fallback),
      explore: isRoleModel(explore) ? explore : undefined,
    },
    exec: { effort: String(exec.effort ?? "high"), defaultPool, pools },
    review: {
      model: String(review.model ?? ""),
      effort: String(review.effort ?? "xhigh"),
      fallback: stringList(review.fallback),
      fallbackEffort: String(review.fallback_effort ?? "medium"),
      maxRounds: typeof review.max_rounds === "number" ? review.max_rounds : 2,
    },
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function isRoleModel(value: unknown): value is RoleModel {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.model === "string" && typeof record.effort === "string"
}

const FAMILIES: Record<string, string> = {
  "opus-5.5": "anthropic",
  "sonnet-5.5": "anthropic",
  "haiku-5.5": "anthropic",
  "gpt-6.1-sol": "openai",
  "grok-4.7": "xai",
  "grok-4.7-build-fast": "xai",
  "glm-5.3-flash": "zhipu",
  "deepseek-v4.1-flash": "deepseek",
}

export function familyOf(alias: string): string {
  return FAMILIES[alias] ?? alias
}
