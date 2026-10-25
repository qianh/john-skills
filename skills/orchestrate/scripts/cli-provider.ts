import { commandFor } from "./providers/args.ts"
import { parseClaude, parseCodex, parseGrok, parsePi } from "./providers/parse.ts"
import type { Provider, ProviderResult, StageRequest } from "./providers/types.ts"

const parsers = {
  claude: parseClaude,
  codex: parseCodex,
  grok: parseGrok,
  pi: parsePi,
}

function clip(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim()
  return trimmed.length > 500 ? trimmed.slice(-500) : trimmed
}

/** 按 P0 实测的参数启动对应 CLI，并把 stdout 解析成用量。 */
export function cliProvider(timeoutMs = 8 * 60 * 1000): Provider {
  return {
    async run(req: StageRequest): Promise<ProviderResult> {
      const command = commandFor(req)
      let stdout = ""
      let stderr = ""
      let code = 1
      try {
        const proc = Bun.spawn(command.argv, {
          cwd: req.cwd,
          stdout: "pipe",
          stderr: "pipe",
          signal: AbortSignal.timeout(timeoutMs),
        })
        ;[stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
      } catch (error) {
        const name = (error as Error).name
        if (name === "TimeoutError" || name === "AbortError") throw new Error("timeout")
        throw error
      }
      if (code !== 0) throw new Error(clip(`${stderr}\n${stdout}`) || `退出码 ${code}`)
      try {
        return parsers[req.provider](stdout)
      } catch (error) {
        throw new Error(clip(`${(error as Error).message}\n${stderr}`))
      }
    },
  }
}
