import type { ProviderName } from "./providers/types.ts"

export interface HostStatus {
  provider: ProviderName
  installed: boolean
  loggedIn: boolean
  detail: string
}

export interface Probe {
  code: number
  stdout: string
  stderr: string
}

export type ProbeRunner = (argv: string[]) => Promise<Probe>

async function probe(argv: string[], timeoutMs = 20_000): Promise<Probe> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(timeoutMs) })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

async function statusOf(provider: ProviderName, login: () => Promise<Probe>, loggedIn: (result: Probe) => boolean, which: (name: string) => unknown): Promise<HostStatus> {
  if (!which(provider)) return { provider, installed: false, loggedIn: false, detail: "未安装" }
  try {
    const result = await login()
    const ok = result.code === 0 && loggedIn(result)
    return { provider, installed: true, loggedIn: ok, detail: ok ? "已登录" : "未登录" }
  } catch {
    return { provider, installed: true, loggedIn: false, detail: "登录检查失败或超时（未发模型请求）" }
  }
}

/** 只检查安装和登录，不发模型请求。 */
export async function detectHosts(options: { probe?: ProbeRunner, which?: (name: string) => unknown } = {}): Promise<HostStatus[]> {
  const run = options.probe ?? probe
  const which = options.which ?? Bun.which
  return Promise.all([
    statusOf("claude", () => run(["claude", "auth", "status"]), (result) => /"loggedIn"\s*:\s*true/.test(result.stdout), which),
    statusOf("codex", () => run(["codex", "login", "status"]), (result) => /logged in/i.test(`${result.stdout}\n${result.stderr}`) && !/not logged in/i.test(`${result.stdout}\n${result.stderr}`), which),
    statusOf("grok", () => run(["grok", "models"]), (result) => result.code === 0, which),
    statusOf("pi", () => run(["pi", "--list-models"]), (result) => result.code === 0 && /provider/i.test(result.stdout), which),
  ])
}

export function ready(hosts: HostStatus[]): ProviderName[] {
  return hosts.filter((host) => host.installed && host.loggedIn).map((host) => host.provider)
}
