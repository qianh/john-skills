export type Role = "plan" | "exec" | "review" | "explore"
export type ProviderName = "claude" | "codex" | "grok" | "pi"

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
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
  error?: string
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
}

export interface Provider {
  run(req: StageRequest): Promise<ProviderResult>
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    costUsd: a.costUsd == null && b.costUsd == null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  }
}
