import { existsSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { type Plan } from "./contracts.ts"
import { runProcess, type ProcessResult, type WorkerHooks } from "./runtime.ts"
import { isSensitivePath, safeEnv, scanText } from "./safety.ts"

const CATEGORIES = new Set(["deps", "publish", "deploy", "push", "data", "prod-config"])
export function parseAllow(value: string | string[] | undefined): string[] {
  const parts = (Array.isArray(value) ? value : [value ?? ""]).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean)
  const allow: string[] = []
  let network = false
  for (const part of parts) {
    if (part.startsWith("network:")) {
      const domain = part.slice(8)
      if (domain !== "*" && !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(domain)) throw new Error("network 必须带域名或 *")
      allow.push(`network:${domain.toLowerCase()}`); network = true
    } else if (CATEGORIES.has(part)) { allow.push(part); network = false }
    else if (network && part.includes(".") && /^[a-zA-Z0-9.-]+$/.test(part)) allow.push(`network:${part.toLowerCase()}`)
    else throw new Error(`未知授权或缺少范围：${part}；联网需 network:<域名> 或 network:*`)
  }
  return [...new Set(allow)]
}
export function commandPermissions(command: string): string[] {
  const result: string[] = []
  if (/\bgit\s+(?:[^;&|]*\s)?push\b/.test(command)) result.push("push")
  if (/\b(?:npm|pnpm|yarn|bun|cargo)\s+(?:[^;&|]*\s)?publish\b|\btwine\s+upload\b/.test(command)) result.push("publish")
  if (/\bdeploy\b|\b(?:kubectl\s+apply|terraform\s+apply)\b/.test(command)) result.push("deploy")
  if (/\brm\b[\s\S]*(?:--recursive|--force|-[^-\s]*r[^\s]*|-[^-\s]*f[^\s]*)|\bgit\s+clean\b|\bfind\b[\s\S]+(?:-delete|-exec\s+[^;]*\brm\b)|\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE)\b/i.test(command)) result.push("data")
  if (/\b(?:npm|pnpm|yarn|bun|pip|pip3|uv|cargo)\s+(?:add|install)\b|\bgo\s+get\b/.test(command)) result.push("deps")
  return result
}
export function missingPermissions(plan: Plan, allow: string[]): string[] {
  const needed = [...plan.needs_permission.map((n) => n.category), ...plan.criteria.flatMap((c) => (c.commands ?? []).flatMap(commandPermissions))]
  return [...new Set(needed.filter((n) => n === "other" || (n === "network" ? !allow.some((a) => a.startsWith("network:")) : !allow.includes(n))))]
}
export function dependencyPath(file: string): boolean {
  return /(?:^|\/)(?:package\.json|(?:package-lock|npm-shrinkwrap)\.json|(?:bun|yarn|pnpm|Cargo|poetry|uv|Pipfile|Gemfile)\.lock(?:b)?|pnpm-lock\.yaml|go\.(?:sum|mod)|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml|Pipfile|Gemfile|composer\.(?:json|lock))$/i.test(file)
}

const quote = (s: string) => JSON.stringify(s)
// Seatbelt #"..." is a regex literal: JSON escaping would double its backslashes.
const regexLiteral = (s: string) => {
  if (/[\r\n\0]/.test(s)) throw new Error("沙箱路径含控制字符，拒绝裸跑")
  return `#"${s.replaceAll('"', '\\"')}"`
}
const real = (s: string) => existsSync(s) ? realpathSync(s) : path.resolve(s)
export const credentialPaths = [".ssh", ".aws", ".azure", ".config/gcloud", ".kube", ".docker/config.json", ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".config/gh", ".gnupg", ".config/orchestrate", ".claude", ".grok", ".codex", ".pi"]

function globRegex(glob: string): string {
  if (/[{}[\]\\]/.test(glob)) throw new Error(`沙箱暂不支持此 sensitive_extra glob，拒绝裸跑：${glob}`)
  let result = ""
  for (let i = 0; i < glob.length; i++) {
    if (glob.slice(i, i + 3) === "**/") { result += "(.*/)?"; i += 2 }
    else if (glob.slice(i, i + 2) === "**") { result += ".*"; i++ }
    else if (glob[i] === "*") result += "[^/]*"
    else if (glob[i] === "?") result += "[^/]"
    else result += glob[i].replace(/[.+^$()|]/g, "\\$&")
  }
  return result
}
function ciLiteral(text: string): string { return [...text].map((ch) => /[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") }

export interface SandboxOptions {
  cwd: string
  gitDir: string
  tmpDir: string
  allow: string[]
  sensitiveExtra?: string[]
  sensitivePaths?: string[]
  extraWritable?: string[]
  verifyEnv?: string[]
  timeoutMs?: number
}
export function sandboxProfile(options: SandboxOptions): string {
  const cwd = real(options.cwd), temp = real(options.tmpDir), gitDir = real(options.gitDir)
  const rules = ["(version 1)", "(allow default)", "(deny file-write*)", `(allow file-write* (literal "/dev/null") (subpath ${quote(cwd)}) (subpath ${quote(temp)})${(options.extraWritable ?? []).map((p) => ` (subpath ${quote(real(p.replace(/^~(?=\/)/, homedir())))})`).join("")})`, `(deny file-write* (subpath ${quote(gitDir)}) (subpath ${quote(path.join(cwd, ".git"))}))`]
  // A linked worktree's common object/ref directory is outside its own git-dir.
  const common = path.resolve(gitDir, "../..")
  if (gitDir.includes(`${path.sep}worktrees${path.sep}`)) rules.push(`(deny file-write* (subpath ${quote(common)}))`)
  if (!options.allow.includes("network:*")) rules.push("(deny network*)")
  rules.push(`(deny file-read* (require-all (regex ${regexLiteral(`(^|/)${ciLiteral(".env")}($|\\.)`)}) (require-not (regex ${regexLiteral(`\\.(${["example", "sample", "template"].map(ciLiteral).join("|")})$`)}))))`)
  const bases = [".npmrc", ".pypirc", ".netrc", ".git-credentials", ".aws", ".ssh", "secrets"].map(ciLiteral)
  const patterns = [...bases, `[^/]*\\.(${["pem", "key", "p12", "pfx", "jks", "keystore", "kdbx"].map(ciLiteral).join("|")})`, `${ciLiteral("id_")}(${["rsa", "ed25519", "ecdsa"].map(ciLiteral).join("|")})[^/]*`, `${ciLiteral(".tfstate")}[^/]*`, `${ciLiteral("kubeconfig")}[^/]*`]
  rules.push(`(deny file-read* (regex ${regexLiteral(`(^|/)(${patterns.join("|")})(/|$)`)}))`)
  for (const p of [...credentialPaths.map((p) => path.join(homedir(), p)), ...(options.sensitivePaths ?? []).map((p) => path.resolve(cwd, p))]) rules.push(`(deny file-read* (subpath ${quote(real(p))}))`)
  for (const glob of options.sensitiveExtra ?? []) {
    if (glob.startsWith("~/")) {
      const expanded = path.join(homedir(), glob.slice(2))
      if (/[*?]/.test(glob)) rules.push(`(deny file-read* (regex ${regexLiteral(`^${globRegex(expanded)}$`)}))`)
      else rules.push(`(deny file-read* (subpath ${quote(real(expanded))}))`)
    }
    else rules.push(`(deny file-read* (regex ${regexLiteral(`^${globRegex(cwd)}/${globRegex(glob)}$`)}))`)
  }
  return rules.join("\n") + "\n"
}

export interface VerificationOutput { code: number; stdout: string; stderr: string; blocked?: boolean; timedOut?: boolean; flags?: string[] }
export async function verifyCommand(command: string, options: SandboxOptions, hooks: WorkerHooks = {}): Promise<VerificationOutput> {
  if (process.platform !== "darwin" || !Bun.which("sandbox-exec")) return { code: 125, stdout: "", stderr: "平台没有已验证的验收沙箱；未执行命令", blocked: true }
  const missing = commandPermissions(command).filter((c) => !options.allow.includes(c))
  if (missing.length) return { code: 125, stdout: "", stderr: `缺少用户授权：${missing.join(", ")}`, blocked: true }
  let profile: string
  try { profile = sandboxProfile(options) } catch (error) { return { code: 125, stdout: "", stderr: String(error), blocked: true } }
  const profileFile = path.join(options.tmpDir, `verify-${crypto.randomUUID()}.sb`)
  writeFileSync(profileFile, profile, { mode: 0o600 })
  const output: ProcessResult = await runProcess(["sandbox-exec", "-f", profileFile, "/bin/sh", "-c", command], { cwd: real(options.cwd), env: safeEnv("verify", options.verifyEnv ?? [], options.tmpDir), timeoutMs: options.timeoutMs ?? 600_000, role: "verify", ...hooks })
  const stdout = scanText(output.stdout), stderr = scanText(output.stderr)
  const deniedLines = `${output.stdout}\n${output.stderr}`.split("\n").filter((line) => /Operation not permitted|PermissionError|Permission denied/i.test(line))
  const blocked = output.code !== 0 && (/sandbox-exec:|sandbox_init:|sandbox_apply:|error reading profile/.test(output.stderr) || deniedLines.some((line) => /\.(?:env|ssh|aws|codex|claude|grok|pi)\b|secret|credential|\.(?:pem|key|p12|pfx|jks|keystore|kdbx)\b/i.test(line) || line.split(/[\s'"=:]+/).some((token) => isSensitivePath(token, options.sensitiveExtra))))
  return { code: output.code, stdout: stdout.text.slice(-8000), stderr: stderr.text.slice(-8000), timedOut: output.timedOut, blocked, flags: [...stdout.flags, ...stderr.flags, ...(output.outputTruncated ? ["验收输出过大，已丢弃内容，证据不完整"] : [])] }
}

// Only reviewed evidence, tied to an adapter and CLI version, can enable strict routes.
// No provider has been certified by this offline implementation.
export function routeAdmission(provider: string, role: string, safety: { unsafeRead: string[]; unsafeExec: string[] }): { admitted: boolean; reason: string } {
  if (provider === "pi" && role === "exec") return { admitted: false, reason: "pi 永远不能执行" }
  if (!safety.unsafeRead.includes(provider)) return { admitted: false, reason: `${provider} 读取隔离尚未通过真实探针；默认禁用` }
  if (role === "exec" && !safety.unsafeExec.includes(provider)) return { admitted: false, reason: `${provider} 五层隔离尚未通过真实探针；默认不能执行` }
  return { admitted: true, reason: `${provider} 使用用户声明的 unsafe_${role === "exec" ? "exec/unsafe_read" : "read"} 例外` }
}
