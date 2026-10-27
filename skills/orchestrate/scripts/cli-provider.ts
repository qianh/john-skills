import { commandFor } from "./providers/args.ts"
import { parseProviderOutput } from "./providers/parse.ts"
import { ProviderOutputError, unknownUsage, type Provider, type ProviderResult } from "./providers/types.ts"
import { runProcess, type WorkerHooks } from "./runtime.ts"
import { safeEnv, scanText } from "./safety.ts"

export function cliProvider(hooks: WorkerHooks = {}): Provider {
  return {
    async run(req): Promise<ProviderResult> {
      let command
      try { command = commandFor(req) }
      catch (error) {
        const failure = new ProviderOutputError(String(error), { text: "", sessionId: null, model: req.model, usage: unknownUsage(), models: {} })
        Object.assign(failure, { notSent: true })
        throw failure
      }
      const output = await runProcess(command.argv, { cwd: req.cwd, env: req.env ?? safeEnv(req.provider), timeoutMs: req.timeoutMs ?? 20 * 60_000, role: req.role, ...hooks })
      const result = parseProviderOutput(req.provider, output.stdout, output.stderr)
      if (output.timedOut || output.code !== 0 || result.error) {
        const message = scanText(`${output.timedOut ? "timeout" : result.error ?? `退出码 ${output.code}`}\n${output.stderr}\n${result.text}`).text.slice(-1500)
        const error = new ProviderOutputError(message, result)
        Object.assign(error, { timedOut: output.timedOut, notSent: output.notSent })
        throw error
      }
      return result
    },
  }
}
