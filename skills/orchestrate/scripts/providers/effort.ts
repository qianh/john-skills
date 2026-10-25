// 思考程度。允许的档位来自 2026-10-25 的实测，不支持的档位在发出请求前改到最近的一档。
// grok 会在请求发出前拒绝非法档位，并在报错里给出该模型允许的列表。

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

/** 实测过的允许档位。没命中的模型不改档，交给 CLI 自己拒绝。 */
export function allowedEfforts(provider: string, model: string): string[] | null {
  if (provider === "claude") return ["low", "medium", "high", "xhigh", "max"]
  if (provider === "codex") {
    if (model.includes("terra")) return ["low", "medium", "high", "xhigh", "max", "ultra"]
    return ["low", "medium", "high", "xhigh", "max"]
  }
  if (provider === "pi") return ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
  if (provider === "grok") {
    if (model.includes("glm-5.3-flash") || model.includes("deepseek-v4")) {
      return ["low", "high", "max"]
    }
    // grok-4.7 实测为 low/medium/high/xhigh。build-fast 只实测了 low 能用，其余档先按同一组，
    // CLI 会在请求前拒绝非法值。
    if (model.includes("grok-4.7")) return ["low", "medium", "high", "xhigh"]
  }
  return null
}

/** 在一份明确的允许列表里取最近的档位。距离相同取更高的一档。 */
export function pickEffort(requested: string, allowed: string[]): string {
  if (!allowed.length) throw new Error("允许的思考程度是空的")
  if (allowed.includes(requested)) return requested
  return nearest(requested, allowed)
}

export function clampEffort(provider: string, model: string, requested: string): EffortChoice {
  const allowed = allowedEfforts(provider, model)
  if (!allowed) return { effort: requested }
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
