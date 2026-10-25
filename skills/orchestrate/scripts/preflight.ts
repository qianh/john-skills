import type { ProviderName } from "./providers/types.ts"

export interface HostStatus {
  provider: ProviderName
  installed: boolean
  loggedIn: boolean
  detail: string
}

interface Probe {
  code: number
  stdout: string
  stderr: string
}

async function probe(argv: string[], timeoutMs = 20_000): Promise<Probe> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(timeoutMs) })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

async function statusOf(provider: ProviderName, login: () => Promise<Probe>, loggedIn: (result: Probe) => boolean): Promise<HostStatus> {
  if (!Bun.which(provider)) return { provider, installed: false, loggedIn: false, detail: "未安装" }
  try {
    const result = await login()
    const ok = result.code === 0 && loggedIn(result)
    return { provider, installed: true, loggedIn: ok, detail: ok ? "已登录" : "未登录" }
  } catch (error) {
    return { provider, installed: true, loggedIn: false, detail: (error as Error).message.slice(0, 120) }
  }
}

/** 只检查安装和登录，不发模型请求。 */
export async function detectHosts(): Promise<HostStatus[]> {
  return Promise.all([
    statusOf("claude", () => probe(["claude", "auth", "status"]), (result) => /"loggedIn"\s*:\s*true/.test(result.stdout)),
    statusOf("codex", () => probe(["codex", "login", "status"]), (result) => /logged in/i.test(`${result.stdout}\n${result.stderr}`)),
    statusOf("grok", () => probe(["grok", "models"]), (result) => result.code === 0),
    statusOf("pi", () => probe(["pi", "--list-models"]), (result) => result.code === 0 && /provider/i.test(result.stdout)),
  ])
}

export function ready(hosts: HostStatus[]): ProviderName[] {
  return hosts.filter((host) => host.installed && host.loggedIn).map((host) => host.provider)
}
