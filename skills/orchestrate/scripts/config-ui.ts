import { spawn } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { applyProposal, discover, serializeRouting, type Discovery } from "./config-cli.ts"
import { EFFORTS, loadCatalog, parseModels, parseRouting, parseSafety, serializeModels, skillRoot, validateConfig, type Catalog, type ModelRow, type SafetyConfig } from "./config.ts"
import type { ProviderName } from "./providers/types.ts"
import { scanText } from "./safety.ts"

const POOLS = ["mechanical", "standard", "hard"] as const
type PoolName = (typeof POOLS)[number]
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,240}$/

export interface LocalRoute {
  key: string
  provider: ProviderName
  modelId: string
  alias: string
  family: string
  efforts: string[] | null
  matched: boolean
}
export interface ChainPick { alias: string, effort: string }
export interface UiState {
  hosts: { provider: ProviderName, installed: boolean, loggedIn: boolean }[]
  routes: Array<LocalRoute & { enabled: boolean }>
  explore: ChainPick[]
  plan: ChainPick[]
  review: ChainPick[]
  pools: Record<PoolName, ChainPick[]>
  timeouts: { explore: number, plan: number, review: number, exec: number }
  maxRounds: number
  execEffort: string
  warnings: string[]
}
export interface SaveBody {
  enabled: string[]
  explore: ChainPick[]
  plan: ChainPick[]
  review: ChainPick[]
  pools: Record<PoolName, ChainPick[]>
  timeouts: UiState["timeouts"]
  maxRounds: number
  execEffort: string
}

export function claudeCatalogDir(): string {
  return path.join(homedir(), ".claude/cache/model-catalog")
}

/** Claude Code 没有模型列表命令；只读本机模型目录里的 id。 */
export function readClaudeModelIds(dir = claudeCatalogDir()): string[] {
  if (!existsSync(dir)) return []
  let stats
  try { stats = lstatSync(dir) } catch { return [] }
  if (!stats.isDirectory() || stats.isSymbolicLink()) return []
  const ids = new Set<string>()
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    const file = path.join(dir, name)
    let fileStat
    try { fileStat = lstatSync(file) } catch { continue }
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 5_000_000) continue
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { catalog?: { config?: { models?: { id?: unknown }[] } } }
      for (const model of data.catalog?.config?.models ?? []) {
        if (typeof model?.id === "string" && SAFE_ID.test(model.id)) ids.add(model.id)
      }
    } catch { /* 单个目录损坏不影响其余模型。 */ }
  }
  return [...ids]
}

export function aliasFromModelId(modelId: string): string {
  const cleaned = modelId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")
  const base = cleaned ? cleaned.slice(0, 80).replace(/[^a-zA-Z0-9]+$/g, "") : ""
  return base || "m-model"
}

function claimAlias(base: string, family: string, modelId: string, provider: ProviderName, routes: LocalRoute[], catalog: Catalog): string {
  let candidate = catalog[base] ? `${base}-${provider}`.slice(0, 80) : base
  let n = 2
  const clash = (name: string) => routes.some((row) => row.alias === name && (row.family !== family || (row.provider === provider && row.modelId !== modelId)))
  while (clash(candidate)) {
    if (n > 50) throw new Error(`无法为 ${modelId} 分配不冲突的能力名`)
    candidate = `${base}-${provider}-${n++}`.slice(0, 80)
  }
  return candidate
}

export function routesFromDiscovery(catalog: Catalog, discovered: Discovery[], claudeIds: string[] = []): LocalRoute[] {
  const routes: LocalRoute[] = []
  const seen = new Set<string>()
  for (const host of discovered) {
    if (!host.installed || !host.loggedIn) continue
    const ids = host.provider === "claude" ? claudeIds : host.ids
    for (const modelId of ids) {
      if (!SAFE_ID.test(modelId) || scanText(modelId).flags.length) continue
      const matches = Object.entries(catalog).filter(([, capability]) => capability.match.some((pattern) => new RegExp(pattern, "i").test(modelId)))
      const specs = matches.length
        ? matches.map(([alias, capability]) => ({ alias, family: capability.family, efforts: capability.efforts[host.provider] ?? null, matched: true }))
        : [{ alias: claimAlias(aliasFromModelId(modelId), host.provider, modelId, host.provider, routes, catalog), family: host.provider, efforts: null, matched: false }]
      for (const spec of specs) {
        const key = `${host.provider}\0${modelId}\0${spec.alias}`
        if (seen.has(key)) continue
        seen.add(key)
        routes.push({ key, provider: host.provider, modelId, alias: spec.alias, family: spec.family, efforts: spec.efforts, matched: spec.matched })
      }
    }
  }
  return routes
}

function bag(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}
function keepChain(chain: { model: string, effort: string }[], enabled: Set<string>, warnings: string[], label: string): ChainPick[] {
  const out: ChainPick[] = []
  for (const item of chain) {
    if (!enabled.has(item.model)) warnings.push(`${label} 里的 ${item.model} 不在当前启用的本机模型中，已从页面去掉`)
    else if (!out.some((row) => row.alias === item.model)) out.push({ alias: item.model, effort: item.effort })
  }
  return out
}
function emptyPools(): Record<PoolName, ChainPick[]> {
  return { mechanical: [], standard: [], hard: [] }
}

export function buildState(discovered: Discovery[], routes: LocalRoute[], modelsSource = "", routingSource = ""): UiState {
  const warnings: string[] = []
  let existing: ModelRow[] = []
  if (modelsSource.trim()) {
    try { existing = parseModels(modelsSource) }
    catch (error) { warnings.push(`现有 models.conf 无法读取，页面不沿用它：${(error as Error).message}`) }
  }
  const enabledKeys: string[] = []
  for (const row of existing) {
    const hit = routes.find((route) => route.provider === row.provider && route.modelId === row.modelId && route.alias === row.alias)
    if (!hit) warnings.push(`本机没有 ${row.alias}@${row.provider} ${row.modelId}，保存时不会保留`)
    else if (!enabledKeys.includes(hit.key)) enabledKeys.push(hit.key)
  }
  const ordered = [
    ...enabledKeys.map((key) => routes.find((route) => route.key === key)!),
    ...routes.filter((route) => !enabledKeys.includes(route.key)),
  ]
  const enabledAliases = new Set(ordered.filter((route) => enabledKeys.includes(route.key)).map((route) => route.alias))
  const state: UiState = {
    hosts: discovered.map((host) => ({ provider: host.provider, installed: host.installed, loggedIn: host.loggedIn })),
    routes: ordered.map((route) => ({ ...route, enabled: enabledKeys.includes(route.key) })),
    explore: [], plan: [], review: [], pools: emptyPools(),
    timeouts: { explore: 5, plan: 10, review: 15, exec: 30 }, maxRounds: 2, execEffort: "high", warnings,
  }
  for (const host of discovered) {
    if (!host.installed) warnings.push(`${host.provider} 未安装`)
    else if (!host.loggedIn) warnings.push(`${host.provider} 未登录，不能选择它的模型`)
  }
  if (discovered.some((host) => host.provider === "claude" && host.installed && host.loggedIn) && !routes.some((route) => route.provider === "claude")) warnings.push("claude 已登录，但本机模型目录里没有可读的模型 ID")
  if (!routingSource.trim()) return state
  try {
    const routing = parseRouting(routingSource)
    state.explore = keepChain(routing.explore.chain, enabledAliases, warnings, "探索")
    state.plan = keepChain(routing.plan.chain, enabledAliases, warnings, "方案")
    state.review = keepChain(routing.review.chain, enabledAliases, warnings, "审查")
    state.timeouts = { explore: routing.explore.timeoutMin, plan: routing.plan.timeoutMin, review: routing.review.timeoutMin, exec: routing.exec.timeoutMin }
    state.maxRounds = routing.review.maxRounds
    state.execEffort = routing.exec.effort
    for (const name of POOLS) state.pools[name] = keepChain(routing.exec.pools[name], enabledAliases, warnings, `${name} 执行池`)
  } catch (error) { warnings.push(`现有 routing.toml 无法读取，阶段留空：${(error as Error).message}`) }
  return state
}

function picks(value: unknown, label: string): ChainPick[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} 至少选择一个本机模型`)
  const out: ChainPick[] = []
  for (const item of value) {
    const row = bag(item, label)
    if (Object.keys(row).some((key) => key !== "alias" && key !== "effort")) throw new Error(`${label} 含未知字段`)
    if (typeof row.alias !== "string" || typeof row.effort !== "string") throw new Error(`${label} 格式无效`)
    if (!EFFORTS.includes(row.effort)) throw new Error(`${label} 未知思考程度：${row.effort}`)
    if (out.some((pick) => pick.alias === row.alias)) throw new Error(`${label} 能力 ${row.alias} 重复`)
    out.push({ alias: row.alias, effort: row.effort })
  }
  return out
}
function effortChoices(alias: string, enabled: LocalRoute[]): string[] {
  const rows = enabled.filter((route) => route.alias === alias)
  if (!rows.length || rows.some((route) => !route.efforts)) return [...EFFORTS]
  return [...new Set(rows.flatMap((route) => route.efforts ?? []))].filter((effort) => EFFORTS.includes(effort))
}
function timeout(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} 必须是正数`)
  return value
}

export function compileSelection(routes: LocalRoute[], body: unknown, existing: ModelRow[], safety: SafetyConfig): { modelsText: string, routingText: string } {
  const raw = bag(body, "保存内容")
  const allowed = ["enabled", "explore", "plan", "review", "pools", "timeouts", "maxRounds", "execEffort"]
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error("保存内容含未知字段")
  if (!Array.isArray(raw.enabled) || raw.enabled.some((key) => typeof key !== "string")) throw new Error("启用列表无效")
  if (new Set(raw.enabled).size !== raw.enabled.length) throw new Error("启用列表有重复")
  const enabled = (raw.enabled as string[]).map((key) => {
    const route = routes.find((item) => item.key === key)
    if (!route) throw new Error("页面里的模型已过期或不在本机列表中，请刷新")
    return route
  })
  if (!enabled.length) throw new Error("至少启用一条本机模型")
  const families = new Map<string, string>()
  for (const route of enabled) {
    const previous = families.get(route.alias)
    if (previous && previous !== route.family) throw new Error(`能力 ${route.alias} 的家族不一致`)
    families.set(route.alias, route.family)
  }
  const aliases = new Set(enabled.map((route) => route.alias))
  const check = (chain: ChainPick[], label: string) => {
    for (const pick of chain) {
      if (!aliases.has(pick.alias)) throw new Error(`${label} 的 ${pick.alias} 没有启用的本机模型`)
      const choices = effortChoices(pick.alias, enabled)
      if (!choices.includes(pick.effort)) throw new Error(`${label} 的 ${pick.alias} 不支持思考程度 ${pick.effort}`)
    }
  }
  const explore = picks(raw.explore, "探索")
  const plan = picks(raw.plan, "方案")
  const review = picks(raw.review, "审查")
  const poolsRaw = bag(raw.pools, "执行池")
  if (Object.keys(poolsRaw).some((key) => !POOLS.includes(key as PoolName))) throw new Error("执行池名称无效")
  const pools = Object.fromEntries(POOLS.map((name) => [name, picks(poolsRaw[name], `${name} 执行池`)])) as Record<PoolName, ChainPick[]>
  for (const [name, chain] of Object.entries(pools)) {
    check(chain, `${name} 执行池`)
    const executable = enabled.filter((route) => chain.some((pick) => pick.alias === route.alias) && route.provider !== "pi")
    if (!executable.length) throw new Error(`执行池 ${name} 只有 pi 路由，pi 不能执行`)
  }
  check(explore, "探索"); check(plan, "方案"); check(review, "审查")
  const times = bag(raw.timeouts, "超时")
  for (const key of ["explore", "plan", "review", "exec"]) if (!(key in times)) throw new Error(`缺少超时 ${key}`)
  if (Object.keys(times).some((key) => !["explore", "plan", "review", "exec"].includes(key))) throw new Error("超时含未知字段")
  if (typeof raw.maxRounds !== "number" || !Number.isInteger(raw.maxRounds) || raw.maxRounds < 0) throw new Error("审查轮次必须是非负整数")
  if (typeof raw.execEffort !== "string" || !EFFORTS.includes(raw.execEffort)) throw new Error("执行默认思考程度无效")
  const prices = new Map(existing.map((row) => [`${row.alias}\0${row.provider}\0${row.modelId}`, row.price]))
  const models: ModelRow[] = enabled.map((route) => ({
    alias: route.alias, provider: route.provider, modelId: route.modelId, family: route.family, efforts: route.efforts, legacyPrice: false,
    price: prices.get(`${route.alias}\0${route.provider}\0${route.modelId}`) ?? { input: null, output: null, cacheRead: null, cacheWrite: null },
  }))
  const asRole = (chain: ChainPick[]) => chain.map((pick) => ({ model: pick.alias, effort: pick.effort }))
  const routing = {
    explore: { chain: asRole(explore), timeoutMin: timeout(times.explore, "探索超时") },
    plan: { chain: asRole(plan), timeoutMin: timeout(times.plan, "方案超时") },
    review: { chain: asRole(review), timeoutMin: timeout(times.review, "审查超时"), maxRounds: raw.maxRounds },
    exec: { effort: raw.execEffort, timeoutMin: timeout(times.exec, "执行超时"), pools: Object.fromEntries(POOLS.map((name) => [name, asRole(pools[name])])) as Record<PoolName, { model: string, effort: string }[]> },
  }
  const modelsText = serializeModels(models)
  const routingText = serializeRouting(routing, safety)
  if (scanText(modelsText).flags.length || scanText(routingText).flags.length) throw new Error("配置含敏感内容，未写入")
  validateConfig({ models: parseModels(modelsText), routing: parseRouting(routingText) })
  parseSafety(routingText)
  return { modelsText, routingText }
}

export function commitSelection(dir: string, modelsText: string, routingText: string): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(dir, "models.conf.proposed"), modelsText, { mode: 0o600 })
  writeFileSync(path.join(dir, "routing.toml.proposed"), routingText, { mode: 0o600 })
  return applyProposal(dir)
}

function readOptional(file: string): string {
  if (!existsSync(file)) return ""
  const stats = lstatSync(file)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1_000_000) return ""
  return readFileSync(file, "utf8")
}
function safetyOf(routingSource: string): SafetyConfig {
  if (routingSource.trim()) {
    try { return parseSafety(routingSource) } catch { /* 损坏的路由仍使用示例里的安全段，不放宽准入。 */ }
  }
  return parseSafety(readFileSync(path.join(skillRoot(), "references/routing.example.toml"), "utf8"))
}
function sameToken(got: string, expected: string): boolean {
  const left = Buffer.from(got)
  const right = Buffer.from(expected)
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right)
}
function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url]
  try {
    const child = spawn(command[0], command.slice(1), { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  } catch { /* 打不开浏览器时，终端里的地址仍然可用。 */ }
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orchestrate 模型配置</title>
<style>
  :root { color-scheme: light; --ink: #1c1915; --muted: #5c564c; --paper: #f4f0e6; --card: #fffdf8; --line: #ddd4c4; --accent: #0f6e56; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.45 "Iowan Old Style", Palatino, "Songti SC", serif; }
  header, main { max-width: 1100px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 28px; margin: 0 0 6px; }
  h2 { font-size: 18px; margin: 0 0 10px; }
  p { margin: 0; color: var(--muted); }
  main { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(320px, 1fr); gap: 18px; padding-top: 0; }
  section { background: var(--card); border: 1px solid var(--line); padding: 14px; }
  .host { display: flex; gap: 12px; flex-wrap: wrap; margin: 8px 0 12px; }
  .warn { color: #8a4b08; }
  label.row, .pick { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; padding: 6px 0; border-top: 1px solid var(--line); }
  .pick { grid-template-columns: 1fr auto auto auto; }
  code { font-family: ui-monospace, monospace; font-size: 12px; }
  button, select, input { font: inherit; }
  button { background: var(--accent); color: white; border: 0; padding: 6px 10px; }
  button.quiet { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  .bar { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .times { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
  .times label { display: flex; justify-content: space-between; gap: 8px; }
  #msg { min-height: 1.4em; margin-top: 8px; }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>模型配置</h1>
  <p>只显示本机已登录 CLI 列出的模型，以及 Claude 本机模型目录中的 ID。保存后写入 models.conf 和 routing.toml，并先备份。不改隔离准入。</p>
  <div id="hosts" class="host"></div>
  <div id="warnings"></div>
</header>
<main>
  <section>
    <h2>本机模型</h2>
    <div id="routes"></div>
  </section>
  <section>
    <h2>阶段顺序</h2>
    <div id="stages"></div>
    <div class="times" id="times"></div>
    <div class="bar"><button id="save" type="button">保存</button><button id="refresh" class="quiet" type="button">重新读取本机模型</button></div>
    <p id="msg"></p>
  </section>
</main>
<script id="boot" type="application/json">__BOOT__</script>
<script>
const boot = JSON.parse(document.getElementById("boot").textContent)
let state = boot.state
const token = boot.token
const stages = [["explore", "探索"], ["plan", "方案"], ["review", "审查"]]
const pools = [["mechanical", "机械执行"], ["standard", "常规执行"], ["hard", "困难执行"]]
const text = (value) => document.createTextNode(value)
function el(tag, attrs, children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children || []) node.append(child)
  return node
}
function choices(alias) {
  const rows = state.routes.filter((route) => route.enabled && route.alias === alias)
  if (!rows.length || rows.some((route) => !route.efforts)) return ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
  return [...new Set(rows.flatMap((route) => route.efforts))]
}
function defaultEffort(alias) {
  const list = choices(alias)
  return list.includes("medium") ? "medium" : list[0]
}
function enabledAliases() {
  return [...new Set(state.routes.filter((route) => route.enabled).map((route) => route.alias))]
}
function dropAlias(alias) {
  if (state.routes.some((route) => route.enabled && route.alias === alias)) return
  for (const [name] of stages) state[name] = state[name].filter((item) => item.alias !== alias)
  for (const [name] of pools) state.pools[name] = state.pools[name].filter((item) => item.alias !== alias)
}
function move(list, index, dir) {
  const next = index + dir
  if (next < 0 || next >= list.length) return
  const [item] = list.splice(index, 1)
  list.splice(next, 0, item)
  render()
}
function effortSelect(pick) {
  const select = el("select")
  for (const effort of choices(pick.alias)) select.append(el("option", { value: effort }, [text(effort)]))
  if (![...select.options].some((option) => option.value === pick.effort)) pick.effort = defaultEffort(pick.alias)
  select.value = pick.effort
  select.addEventListener("change", () => { pick.effort = select.value })
  return select
}
function chainView(title, list) {
  const box = el("div")
  box.append(el("h2", {}, [text(title)]))
  list.forEach((pick, index) => {
    const row = el("div", { class: "pick" }, [
      el("code", {}, [text(pick.alias)]),
      effortSelect(pick),
      el("button", { class: "quiet", type: "button" }, [text("上移")]),
      el("button", { class: "quiet", type: "button" }, [text("移除")]),
    ])
    row.children[2].addEventListener("click", () => move(list, index, -1))
    row.children[3].addEventListener("click", () => { list.splice(index, 1); render() })
    box.append(row)
  })
  const select = el("select")
  select.append(el("option", { value: "" }, [text("加入本机能力")]))
  for (const alias of enabledAliases()) {
    if (!list.some((item) => item.alias === alias)) select.append(el("option", { value: alias }, [text(alias)]))
  }
  const add = el("button", { class: "quiet", type: "button" }, [text("加入")])
  add.addEventListener("click", () => {
    if (!select.value || list.some((item) => item.alias === select.value)) return
    list.push({ alias: select.value, effort: defaultEffort(select.value) })
    render()
  })
  box.append(el("div", { class: "bar" }, [select, add]))
  return box
}
function render() {
  const hosts = document.getElementById("hosts")
  hosts.replaceChildren(...state.hosts.map((host) => el("span", {}, [text(host.provider + " " + (!host.installed ? "未安装" : host.loggedIn ? "已登录" : "未登录"))])))
  const warnings = document.getElementById("warnings")
  warnings.replaceChildren(...state.warnings.map((warning) => el("p", { class: "warn" }, [text(warning)])))
  const routes = document.getElementById("routes")
  const enabled = state.routes.filter((route) => route.enabled)
  routes.replaceChildren(...state.routes.map((route) => {
    const box = el("input", { type: "checkbox" })
    box.checked = route.enabled
    box.addEventListener("change", () => {
      route.enabled = box.checked
      dropAlias(route.alias)
      const on = state.routes.filter((item) => item.enabled)
      const off = state.routes.filter((item) => !item.enabled)
      state.routes = [...on, ...off]
      render()
    })
    const index = enabled.findIndex((item) => item.key === route.key)
    const up = el("button", { class: "quiet", type: "button" }, [text("上移")])
    up.disabled = !route.enabled || index <= 0
    up.addEventListener("click", () => {
      const order = state.routes.filter((item) => item.enabled)
      const at = order.findIndex((item) => item.key === route.key)
      const [item] = order.splice(at, 1)
      order.splice(at - 1, 0, item)
      state.routes = [...order, ...state.routes.filter((item) => !item.enabled)]
      render()
    })
    const note = route.matched ? route.alias + " · " + route.family : route.alias + " · 未入能力目录，家族记为 " + route.family
    return el("div", { class: "row" }, [box, el("span", {}, [el("code", {}, [text(route.provider + "  " + route.modelId)]), el("div", {}, [text(note)])]), up])
  }))
  const stagesNode = document.getElementById("stages")
  stagesNode.replaceChildren(
    ...stages.map(([name, title]) => chainView(title, state[name])),
    ...pools.map(([name, title]) => chainView(title, state.pools[name])),
  )
  const times = document.getElementById("times")
  if (!times.childElementCount) {
    for (const [key, label] of [["explore", "探索超时（分）"], ["plan", "方案超时（分）"], ["review", "审查超时（分）"], ["exec", "执行超时（分）"], ["maxRounds", "审查轮次"], ["execEffort", "执行默认思考档"]]) {
      const input = key === "execEffort" ? el("select") : el("input")
      if (key === "execEffort") {
        for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) input.append(el("option", { value: effort }, [text(effort)]))
        input.value = state.execEffort
        input.addEventListener("change", () => { state.execEffort = input.value })
      } else {
        input.type = "number"
        input.min = key === "maxRounds" ? "0" : "1"
        input.step = key === "maxRounds" ? "1" : "any"
        input.value = key === "maxRounds" ? state.maxRounds : state.timeouts[key]
        input.addEventListener("input", () => {
          const value = Number(input.value)
          if (key === "maxRounds") state.maxRounds = value
          else state.timeouts[key] = value
        })
      }
      times.append(el("label", {}, [text(label), input]))
    }
  }
}
async function send(path, payload) {
  const response = await fetch(path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(payload) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || "请求失败")
  return data
}
document.getElementById("save").addEventListener("click", async () => {
  const msg = document.getElementById("msg")
  msg.textContent = "正在保存…"
  try {
    const data = await send("/api/save", {
      enabled: state.routes.filter((route) => route.enabled).map((route) => route.key),
      explore: state.explore, plan: state.plan, review: state.review, pools: state.pools,
      timeouts: state.timeouts, maxRounds: Number(state.maxRounds), execEffort: state.execEffort,
    })
    msg.textContent = data.lines.join(" ")
  } catch (error) { msg.textContent = error.message }
})
document.getElementById("refresh").addEventListener("click", async () => {
  const msg = document.getElementById("msg")
  msg.textContent = "正在重新读取本机模型…"
  try { state = (await send("/api/refresh", {})).state; document.getElementById("times").replaceChildren(); render(); msg.textContent = "已重新读取。未保存的修改已丢弃。" }
  catch (error) { msg.textContent = error.message }
})
render()
</script>
</body>
</html>
`

export interface UiHandle { url: string, stop: () => void }
export async function startConfigUi(options: {
  dir: string
  port?: number
  open?: boolean
  discoverModels?: () => Promise<Discovery[]>
  claudeIds?: string[]
  claudeCatalog?: string
  catalog?: Catalog
} ): Promise<UiHandle> {
  const catalog = options.catalog ?? loadCatalog()
  const load = async () => {
    const discovered = await (options.discoverModels ?? discover)()
    const claudeIds = options.claudeIds ?? readClaudeModelIds(options.claudeCatalog ?? claudeCatalogDir())
    const routes = routesFromDiscovery(catalog, discovered, claudeIds)
    const modelsSource = readOptional(path.join(options.dir, "models.conf"))
    const routingSource = readOptional(path.join(options.dir, "routing.toml"))
    return { discovered, routes, state: buildState(discovered, routes, modelsSource, routingSource), modelsSource, routingSource }
  }
  let snapshot = await load()
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url)
      const header = req.headers.get("authorization") ?? ""
      const presented = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token") ?? ""
      if (!sameToken(presented, token)) return new Response("not found", { status: 404 })
      if (req.method === "GET" && url.pathname === "/") {
        const page = PAGE.replace("__BOOT__", JSON.stringify({ state: snapshot.state, token }).replace(/</g, "\\u003c"))
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
      }
      if (req.method === "GET" && url.pathname === "/api/state") return json({ state: snapshot.state })
      if (req.method !== "POST" || (url.pathname !== "/api/save" && url.pathname !== "/api/refresh")) return json({ error: "未知请求" }, 404)
      const raw = await req.text()
      if (raw.length > 100_000) return json({ error: "请求过大" }, 400)
      try {
        if (url.pathname === "/api/refresh") {
          snapshot = await load()
          return json({ state: snapshot.state })
        }
        let existing: ModelRow[] = []
        if (snapshot.modelsSource.trim()) { try { existing = parseModels(snapshot.modelsSource) } catch { existing = [] } }
        const { modelsText, routingText } = compileSelection(snapshot.routes, raw ? JSON.parse(raw) : {}, existing, safetyOf(snapshot.routingSource))
        const lines = commitSelection(options.dir, modelsText, routingText)
        const modelsSource = readOptional(path.join(options.dir, "models.conf"))
        const routingSource = readOptional(path.join(options.dir, "routing.toml"))
        snapshot = { ...snapshot, modelsSource, routingSource, state: buildState(snapshot.discovered, snapshot.routes, modelsSource, routingSource) }
        return json({ lines })
      } catch (error) {
        return json({ error: scanText((error as Error).message).text.slice(0, 500) }, 400)
      }
    },
  })
  const url = `http://127.0.0.1:${server.port}/?token=${token}`
  if (options.open !== false) openBrowser(url)
  return { url, stop: () => server.stop(true) }
}

export function portNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error("--port 必须是 0 到 65535 的整数")
  return Number(raw)
}

export async function serveUntilStopped(options: { dir: string, port?: number, open?: boolean }): Promise<string> {
  const handle = await startConfigUi(options)
  console.log(`配置页：${handle.url}\n在浏览器里勾选本机模型并保存。Ctrl+C 关闭；未保存的修改不会写入。`)
  await new Promise<void>((resolve) => {
    const done = () => { handle.stop(); resolve() }
    process.once("SIGINT", done)
    process.once("SIGTERM", done)
  })
  return handle.url
}
