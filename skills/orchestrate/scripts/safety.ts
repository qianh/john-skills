import { homedir } from "node:os"
import path from "node:path"

export interface SafetyPolicy {
  sensitiveExtra?: string[]
}

export const DEFAULT_SENSITIVE_GLOBS = [
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx",
  "**/*.jks", "**/*.keystore", "**/id_rsa*", "**/id_ed25519*", "**/id_ecdsa*",
  "**/.npmrc", "**/.pypirc", "**/.netrc", "**/.git-credentials", "**/*.kdbx",
  "**/*.tfstate*", "**/secrets/**", "**/*secret*", "**/*credential*",
  "**/kubeconfig*", "**/.aws/**", "**/.ssh/**",
] as const
const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".kt", ".php", ".py", ".rb", ".rs", ".swift", ".ts", ".tsx", ".vue"])
const DEFAULT_SENSITIVE_MATCHERS = DEFAULT_SENSITIVE_GLOBS.map((glob) => ({ glob, matcher: new Bun.Glob(glob) }))

const HOME_CREDENTIALS = [
  ".ssh", ".aws", ".azure", ".config/gcloud", ".kube", ".docker/config.json",
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".config/gh", ".gnupg",
  ".config/orchestrate",
]

function normalized(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "")
}

export function isSensitivePath(file: string, extra: readonly string[] = []): boolean {
  const value = normalized(file)
  const lower = value.toLowerCase()
  const base = path.posix.basename(lower)
  const sampleEnv = base.startsWith(".env.") && /\.(example|sample|template)$/.test(base)
  const parts = lower.split("/")
  if (parts.some((part) => ["secrets", ".aws", ".ssh"].includes(part))) return true
  if (DEFAULT_SENSITIVE_MATCHERS.some(({ glob, matcher }) => {
    if (sampleEnv && (glob === "**/.env" || glob === "**/.env.*")) return false
    if (SOURCE_EXTENSIONS.has(path.posix.extname(lower)) && ["**/*secret*", "**/*credential*"].includes(glob)) return false
    return matcher.match(lower)
  })) return true
  return extra.some((glob) => {
    const expanded = glob.startsWith("~/") ? path.join(homedir(), glob.slice(2)) : glob
    return new Bun.Glob(normalized(expanded)).match(value)
  })
}

/** Paths used by the sandbox, not files to inspect for credentials. */
export function credentialReadPaths(kind: string, extra: readonly string[] = []): string[] {
  const names = kind === "verify" ? [...HOME_CREDENTIALS, ".claude", ".grok", ".codex", ".pi"] : HOME_CREDENTIALS
  return [...names.map((name) => path.join(homedir(), name)), ...extra.filter((name) => name.startsWith("~/")).map((name) => path.join(homedir(), name.slice(2)))]
}

export function scanText(input: string): { text: string, flags: string[] } {
  const flags = new Set<string>()
  let text = input
  const redact = (kind: string) => {
    flags.add(kind)
    return `[redacted:${kind}]`
  }
  // Replace the whole PEM payload, not merely its identifying header.
  text = text.replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g, () => redact("private-key"))
  text = text.replace(/(\b[A-Z0-9_]*(?:api[_-]?key|secret|token|password)[A-Z0-9_]*\b["']?\s*[:=]\s*["']?)([^\s"',;}\]]{12,})/gi, (_, prefix: string, value: string) => {
    if (value.startsWith("[redacted:")) return prefix + value
    // References and calls are source code, not embedded credential values.
    if (/^(?:process\.env\.[A-Z0-9_]+|[A-Za-z_$][\w$]*\([^)]*\)|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)$/.test(value)) return prefix + value
    return prefix + redact("credential-value")
  })
  const patterns: [string, RegExp][] = [
    ["aws-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ["github-token", /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
    ["api-token", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g],
    ["slack-token", /\bxox[a-z]-[A-Za-z0-9-]{12,}\b/g],
  ]
  for (const [kind, pattern] of patterns) text = text.replace(pattern, () => redact(kind))
  return { text, flags: [...flags] }
}

/** Scan JSON values before serialization so an unterminated PEM cannot eat JSON syntax. */
export function sanitizeValue<T>(input: T): { value: T, flags: string[] } {
  const flags = new Set<string>()
  const seen = new Set<object>()
  const visit = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (/(?:api[_-]?key|secret|token|password)/i.test(key) && value.length >= 12 && !value.startsWith("[redacted:")) {
        flags.add("credential-value")
        return "[redacted:credential-value]"
      }
      const scanned = scanText(value)
      for (const flag of scanned.flags) flags.add(flag)
      return scanned.text
    }
    if (!value || typeof value !== "object") return value
    if (seen.has(value)) throw new Error("Cannot sanitize cyclic JSON values")
    seen.add(value)
    try {
      if (Array.isArray(value)) return value.map((item) => visit(item))
      const output: Record<string, unknown> = Object.create(null)
      for (const [name, item] of Object.entries(value)) {
        const scannedKey = scanText(name)
        for (const flag of scannedKey.flags) flags.add(flag)
        output[scannedKey.text] = visit(item, name)
      }
      return output
    } finally {
      seen.delete(value)
    }
  }
  return { value: visit(input) as T, flags: [...flags] }
}

/** Only names are configured; values must never be written to run artifacts. */
export function safeEnv(kind: string, extraNames: readonly string[] = [], tmpDir?: string): Record<string, string> {
  void kind
  const env: Record<string, string> = {}
  const names = new Set(["PATH", "HOME", "USER", "LANG", "TERM", ...Object.keys(process.env).filter((name) => /^LC_[A-Z0-9_]+$/.test(name)), ...extraNames])
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable name: ${name}`)
    if (process.env[name] !== undefined) env[name] = process.env[name]!
  }
  const home = env.HOME || homedir()
  env.HOME = home
  env.PATH = [...new Set([...(env.PATH || "/usr/bin:/bin").split(path.delimiter), path.join(home, ".bun/bin"), path.join(home, ".local/bin")])].join(path.delimiter)
  env.TMPDIR = tmpDir || process.env.TMPDIR || "/tmp"
  env.GIT_CONFIG_GLOBAL = "/dev/null"
  env.GIT_CONFIG_NOSYSTEM = "1"
  // An empty highest-priority helper resets helpers declared in the local repo too.
  env.GIT_CONFIG_COUNT = "1"
  env.GIT_CONFIG_KEY_0 = "credential.helper"
  env.GIT_CONFIG_VALUE_0 = ""
  env.GIT_TERMINAL_PROMPT = "0"
  env.GIT_OPTIONAL_LOCKS = "0"
  return env
}
