import { addUsage, emptyUsage, type Provider, type ProviderResult, type StageRequest, type Usage } from "./types.ts"

export interface StageReport {
  results: ProviderResult[]
  total: Usage
}

/** 按顺序跑完每个阶段，用量相加。会话续接由调用方在请求里带 sessionId。 */
export async function runStages(provider: Provider, stages: StageRequest[]): Promise<StageReport> {
  const results: ProviderResult[] = []
  let total = emptyUsage()
  for (const stage of stages) {
    const result = await provider.run(stage)
    results.push(result)
    total = addUsage(total, result.usage)
  }
  return { results, total }
}
