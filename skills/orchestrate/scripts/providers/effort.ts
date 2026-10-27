// 支持的档位来自路由或能力目录，不按模型 ID 或 provider 猜测。

const ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

export interface EffortChoice {
  effort: string
  /** 和请求的档位不同时说明原因 */
  adjusted?: string
}

function nearest(requested: string, allowed: string[]): string {
  const at = ORDER.indexOf(requested)
  if (at < 0) throw new Error(`未知思考程度: ${requested}`)
  let best = allowed[0]
  let bestDist = Infinity
  let bestAt = -1
  for (const name of allowed) {
    const pos = ORDER.indexOf(name)
    if (pos < 0) continue
    const dist = Math.abs(pos - at)
    // 距离相同取更高的一档
    if (dist < bestDist || (dist === bestDist && pos > bestAt)) {
      best = name
      bestDist = dist
      bestAt = pos
    }
  }
  return best
}

/** 在一份明确的允许列表里取最近的档位。距离相同取更高的一档。 */
export function pickEffort(requested: string, allowed: string[]): string {
  if (!allowed.length) throw new Error("允许的思考程度是空的")
  if (allowed.includes(requested)) return requested
  return nearest(requested, allowed)
}

export function clampEffort(provider: string, model: string, requested: string, allowed?: string[] | null): EffortChoice {
  if (!ORDER.includes(requested)) throw new Error(`未知思考程度: ${requested}`)
  if (!allowed) return { effort: requested }
  if (!allowed.length || allowed.some((effort) => !ORDER.includes(effort))) throw new Error("允许的思考程度不合法")
  if (allowed.includes(requested)) return { effort: requested }
  const effort = nearest(requested, allowed)
  return { effort, adjusted: `${provider} 上的 ${model} 没有 ${requested}，改用 ${effort}` }
}

/** grok 报错形如：unknown effort level 'medium'; use one of: low, high, max */
export function parseEffortRejection(text: string): string[] | null {
  const matched = text.match(/use one of: ([a-z][a-z, ]*)/)
  if (!matched) return null
  const levels = matched[1].split(",").map((s) => s.trim()).filter(Boolean)
  return levels.length ? levels : null
}
