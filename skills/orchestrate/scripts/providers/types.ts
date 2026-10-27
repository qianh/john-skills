export type Role = "plan" | "exec" | "review" | "explore"
export type ProviderName = "claude" | "codex" | "grok" | "pi"

export interface Usage {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  reasoning: number | null
  /** null 表示 CLI 没给出可采信的金额。grok 的 0 不算免费。 */
  costUsd: number | null
}

export interface ProviderResult {
  text: string
  sessionId: string | null
  /** 实际计费的模型。可能和请求的别名不同。 */
  model: string | null
  /** 这一次调用的用量。Claude 父会话的 result.usage 不含子会话，见 models。 */
  usage: Usage
  /** 按模型拆开的用量。Claude 在续接时是整个会话的累计值。 */
  models: Record<string, Usage>
  /** Claude 的会话累计金额必须由调用方按 session 求差值。 */
  costBasis?: "incremental" | "cumulative"
  /** 原生结构化结果仍需经过业务契约校验。 */
  structured?: unknown
  error?: string
}

export interface StageSandbox {
  /** grok 的命名沙箱；这里只转交配置，不代表已验证隔离。 */
  profile?: string
  /** Claude 的 CLI settings；准入和内容由安全模块负责。 */
  settings?: Record<string, unknown>
}

export interface StageRequest {
  provider: ProviderName
  role: Role
  model: string
  effort: string
  prompt: string
  cwd: string
  sessionId?: string
  resume?: boolean
  /** pi 的会话目录。同一个目录加同一个 sessionId 才能续接。 */
  sessionDir?: string
  schema?: Record<string, unknown>
  schemaPath?: string
  timeoutMs?: number
  /** 仅供记录，不能代替安全准入。 */
  securityProfile?: string
  env?: Record<string, string>
  sandbox?: StageSandbox
  /** 路由或能力目录声明的允许档位，优先于内置兼容表。 */
  supportedEfforts?: string[]
}

export interface Provider {
  run(req: StageRequest): Promise<ProviderResult>
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null }
}

export function unknownUsage(): Usage {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, costUsd: null }
}

/** 模型失败不应丢弃同一份输出里已经回报的用量。 */
export class ProviderOutputError extends Error {
  constructor(message: string, readonly result: ProviderResult) {
    super(message)
    this.name = "ProviderOutputError"
  }
}

export function addUsage(a: Usage, b: Usage): Usage {
  const sum = (x: number | null, y: number | null) => x == null || y == null ? null : x + y
  return {
    input: sum(a.input, b.input),
    output: sum(a.output, b.output),
    cacheRead: sum(a.cacheRead, b.cacheRead),
    cacheWrite: sum(a.cacheWrite, b.cacheWrite),
    reasoning: sum(a.reasoning, b.reasoning),
    costUsd: a.costUsd == null && b.costUsd == null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  }
}
