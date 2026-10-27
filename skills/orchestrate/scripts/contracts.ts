import type { PoolName } from "./config.ts"

export interface Criterion { id: string; kind: "command" | "check"; text: string; commands?: string[] }
export interface Plan {
  exec_type: PoolName
  criteria: Criterion[]
  allowed_paths: string[]
  needs_permission: { category: string; reason: string }[]
  steps: string[]
  context: { ref: string; note: string }[]
}
export interface Finding { ref: string; issue: string }
export interface Review {
  p1: Finding[]
  p2: Finding[]
  criteria: { id: string; verdict: "pass" | "fail" | "unknown"; note: string }[]
  out_of_scope: { path: string; accept: boolean; reason: string }[]
  reviewed_tree: string
}
export interface Checks { checked_tree: string; checks: { id: string; verdict: "pass" | "fail" | "unknown"; evidence: string }[] }

function demand(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
function object(value: unknown): Record<string, unknown> {
  demand(value && typeof value === "object" && !Array.isArray(value), "必须是 JSON 对象")
  return value as Record<string, unknown>
}
function fields(value: unknown, names: string[]): Record<string, unknown> {
  const row = object(value)
  demand(Object.keys(row).every((key) => names.includes(key)), "存在未知字段")
  demand(names.every((key) => Object.hasOwn(row, key)), `缺少字段：${names.filter((key) => !Object.hasOwn(row, key)).join(", ")}`)
  return row
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function member(value: unknown, allowed: string[]): boolean { return typeof value === "string" && allowed.includes(value) }
function strings(value: unknown, min = 0): value is string[] { return Array.isArray(value) && value.length >= min && value.every(nonempty) }
function exactIds(actual: string[], expected: string[], title: string): void {
  demand(new Set(actual).size === actual.length && actual.length === expected.length && actual.every((id) => expected.includes(id)), `${title}必须恰好覆盖：${expected.join(", ") || "空列表"}`)
}

/** Reject duplicate keys before JSON.parse can silently overwrite them. */
export function strictJSON(text: string): unknown {
  let at = 0
  const whitespace = () => { while (/\s/.test(text[at] ?? "") && at < text.length) at++ }
  const string = (): string => {
    const start = at++
    while (at < text.length) {
      const ch = text[at++]
      if (ch === "\\") { at++; continue }
      if (ch === '"') return JSON.parse(text.slice(start, at))
    }
    throw new Error("JSON 字符串未闭合")
  }
  const value = (): void => {
    whitespace()
    if (text[at] === "{") {
      at++; whitespace()
      const seen = new Set<string>()
      if (text[at] === "}") { at++; return }
      while (at < text.length) {
        demand(text[at] === '"', "JSON 对象键必须是字符串")
        const key = string()
        demand(!seen.has(key), `JSON 重复键：${key}`)
        seen.add(key); whitespace()
        demand(text[at++] === ":", "JSON 缺少冒号")
        value(); whitespace()
        const next = text[at++]
        if (next === "}") return
        demand(next === ",", "JSON 缺少逗号")
        whitespace()
      }
      throw new Error("JSON 对象未闭合")
    }
    if (text[at] === "[") {
      at++; whitespace()
      if (text[at] === "]") { at++; return }
      while (at < text.length) {
        value(); whitespace()
        const next = text[at++]
        if (next === "]") return
        demand(next === ",", "JSON 数组缺少逗号")
      }
      throw new Error("JSON 数组未闭合")
    }
    if (text[at] === '"') { string(); return }
    const literal = text.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)
    demand(literal, "JSON 值无效")
    at += literal[0].length
  }
  value(); whitespace()
  demand(at === text.length, "JSON 后有多余内容")
  return JSON.parse(text)
}

export function parseContractText(text: string, provider?: string): unknown {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  if (provider === "pi") {
    demand(blocks.length === 1 && (text.match(/```/g) ?? []).length === 2, "pi 必须回复恰好一个 json 代码块")
    return strictJSON(blocks[0][1].trim())
  }
  if (blocks.length) {
    demand(blocks.length === 1 && text.replace(blocks[0][0], "").trim() === "", "结构化回复不能混入正文或多个代码块")
    return strictJSON(blocks[0][1].trim())
  }
  return strictJSON(text.trim())
}

export function validatePlan(value: unknown): Plan {
  const p = fields(value, ["exec_type", "criteria", "allowed_paths", "needs_permission", "steps", "context"])
  demand(member(p.exec_type, ["mechanical", "standard", "hard"]), "exec_type 无效")
  demand(Array.isArray(p.criteria) && p.criteria.length > 0, "criteria 不能为空")
  const ids: string[] = []
  for (const raw of p.criteria) {
    const c = object(raw)
    fields(c, c.kind === "command" ? ["id", "kind", "text", "commands"] : ["id", "kind", "text"])
    demand(nonempty(c.id) && nonempty(c.text) && member(c.kind, ["command", "check"]), "criterion 无效")
    demand(!ids.includes(c.id), "criterion id 重复"); ids.push(c.id)
    if (c.kind === "command") demand(strings(c.commands, 1) && c.commands.every((cmd) => !/[\r\n\0]/.test(cmd)), "commands 必须是非空单行命令数组")
  }
  demand(strings(p.allowed_paths, 1) && p.allowed_paths.every((s) => !s.startsWith("/") && !s.split("/").includes("..") && !s.startsWith("~") && !/[\0\r\n]/.test(s)), "allowed_paths 必须是工作区内相对 glob")
  demand(strings(p.steps, 1), "steps 不能为空")
  demand(Array.isArray(p.needs_permission), "needs_permission 必须是数组")
  for (const raw of p.needs_permission) {
    const n = fields(raw, ["category", "reason"])
    demand(member(n.category, ["deps", "network", "publish", "deploy", "push", "data", "prod-config", "other"]) && nonempty(n.reason), "授权需求无效")
  }
  demand(Array.isArray(p.context), "context 必须是数组")
  for (const raw of p.context) {
    const c = fields(raw, ["ref", "note"])
    demand(nonempty(c.ref) && nonempty(c.note), "context 无效")
  }
  return p as unknown as Plan
}

export function validateReview(value: unknown, plan: Plan, tree: string, outOfScope: string[]): Review {
  const r = fields(value, ["p1", "p2", "criteria", "out_of_scope", "reviewed_tree"])
  for (const key of ["p1", "p2"]) {
    demand(Array.isArray(r[key]), `${key} 必须是数组`)
    for (const raw of r[key] as unknown[]) {
      const f = fields(raw, ["ref", "issue"])
      demand(nonempty(f.ref) && nonempty(f.issue), "finding ref/issue 不能为空")
    }
  }
  demand(r.reviewed_tree === tree, "reviewed_tree 与当前快照不一致")
  demand(Array.isArray(r.criteria) && Array.isArray(r.out_of_scope), "criteria/out_of_scope 必须是数组")
  for (const raw of r.criteria) {
    const c = fields(raw, ["id", "verdict", "note"])
    demand(nonempty(c.id) && member(c.verdict, ["pass", "fail", "unknown"]) && nonempty(c.note), "审查标准无效")
  }
  for (const raw of r.out_of_scope) {
    const c = fields(raw, ["path", "accept", "reason"])
    demand(nonempty(c.path) && typeof c.accept === "boolean" && nonempty(c.reason), "越界判断无效")
  }
  exactIds(r.criteria.map((c: any) => c.id), plan.criteria.filter((c) => c.kind === "check").map((c) => c.id), "criteria")
  exactIds(r.out_of_scope.map((c: any) => c.path), outOfScope, "out_of_scope")
  return r as unknown as Review
}

export function reviewFindings(r: Review): Finding[] {
  return [...r.p1, ...r.criteria.filter((c) => c.verdict === "fail").map((c) => ({ ref: c.id, issue: c.note })), ...r.out_of_scope.filter((c) => !c.accept).map((c) => ({ ref: c.path, issue: c.reason }))]
}

export function validateChecks(value: unknown, plan: Plan, tree: string): Checks {
  const c = fields(value, ["checked_tree", "checks"])
  demand(c.checked_tree === tree, "checks 针对的快照不一致")
  demand(Array.isArray(c.checks), "checks 必须是数组")
  for (const raw of c.checks) {
    const row = fields(raw, ["id", "verdict", "evidence"])
    demand(nonempty(row.id) && member(row.verdict, ["pass", "fail", "unknown"]) && nonempty(row.evidence), "核验证据无效")
  }
  exactIds(c.checks.map((r: any) => r.id), plan.criteria.filter((r) => r.kind === "check").map((r) => r.id), "checks")
  return c as unknown as Checks
}

export function renderPlan(p: Plan): string {
  return [`# 方案`, `执行类型：${p.exec_type}`, `## 完成标准`, ...p.criteria.map((c) => `- ${c.id} [${c.kind}] ${c.text}${c.commands ? `\n${c.commands.map((s) => `  ${s}`).join("\n")}` : ""}`), `## 允许路径`, ...p.allowed_paths.map((s) => `- ${s}`), `## 授权需求`, ...p.needs_permission.map((n) => `- ${n.category}: ${n.reason}`), `## 步骤`, ...p.steps.map((s) => `- ${s}`), `## 上下文`, ...p.context.map((c) => `- ${c.ref} ${c.note}`)].join("\n")
}

const str = { type: "string", minLength: 1 }
const arr = (items: unknown, minItems = 0) => ({ type: "array", items, minItems })
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false })
const finding = obj({ ref: str, issue: str })
export const planSchema = obj({ exec_type: { enum: ["mechanical", "standard", "hard"] }, criteria: arr({ oneOf: [obj({ id: str, kind: { const: "command" }, text: str, commands: arr({ ...str, pattern: "^[^\\r\\n]+$" }, 1) }), obj({ id: str, kind: { const: "check" }, text: str })] }, 1), allowed_paths: arr(str, 1), needs_permission: arr(obj({ category: { enum: ["deps", "network", "publish", "deploy", "push", "data", "prod-config", "other"] }, reason: str })), steps: arr(str, 1), context: arr(obj({ ref: str, note: str })) })
export const reviewSchema = obj({ p1: arr(finding), p2: arr(finding), criteria: arr(obj({ id: str, verdict: { enum: ["pass", "fail", "unknown"] }, note: str })), out_of_scope: arr(obj({ path: str, accept: { type: "boolean" }, reason: str })), reviewed_tree: str })
export const checksSchema = obj({ checked_tree: str, checks: arr(obj({ id: str, verdict: { enum: ["pass", "fail", "unknown"] }, evidence: str })) })
