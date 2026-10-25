import { emptyUsage, type Provider, type ProviderResult, type StageRequest } from "./types.ts"

/** 测试用。不启动任何 CLI。 */
export class FakeProvider implements Provider {
  readonly calls: StageRequest[] = []

  constructor(private readonly reply: (req: StageRequest) => ProviderResult = fakeReply) {}

  async run(req: StageRequest): Promise<ProviderResult> {
    this.calls.push(req)
    return this.reply(req)
  }
}

function fakeReply(req: StageRequest): ProviderResult {
  const usage = { ...emptyUsage(), input: 10, output: 2, costUsd: 0.01 }
  return {
    text: `${req.role}:ok`,
    sessionId: `${req.provider}-${req.role}`,
    model: req.model,
    usage,
    models: { [req.model]: usage },
  }
}
