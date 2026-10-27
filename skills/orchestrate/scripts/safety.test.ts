import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { credentialReadPaths, isSensitivePath, safeEnv, sanitizeValue, scanText } from "./safety.ts"

describe("sensitive path policy", () => {
  test("matches root/nested paths and does not exempt keys inside template directories", () => {
    for (const file of [".env", ".env.local", "app/.env.prod", "a.pem", "a.key", "a.p12", "a.pfx", "a.jks", "a.keystore", "id_rsa.pub", "id_ed25519", "id_ecdsa.test", ".npmrc", "app/.pypirc", ".netrc", ".git-credentials", "vault.kdbx", "a.tfstate.backup", "secrets", "secrets/data", "mysecret.txt", "myCredentials.json", "kubeconfig.dev", ".aws/config", "app/.ssh/config", "x.example/a.key"]) expect(isSensitivePath(file)).toBe(true)
    for (const file of [".env.example", ".env.local.sample", "app/.env.template", "app/main.ts", "app/monkey.ts", "templates/example.txt"]) expect(isSensitivePath(file)).toBe(false)
    expect(isSensitivePath("secrets/.env.example")).toBe(true)
  })

  test("extra rules append to defaults and support home paths", () => {
    expect(isSensitivePath("private/data.json", ["private/**"])).toBe(true)
    expect(isSensitivePath(".env", ["private/**"])).toBe(true)
    expect(isSensitivePath("public/data.json", ["private/**"])).toBe(false)
    expect(isSensitivePath(path.join(homedir(), "custom-auth/token"), ["~/custom-auth/**"])).toBe(true)
  })

  test("credential read deny list covers verify-only CLI directories", () => {
    expect(credentialReadPaths("verify")).toContain(path.join(homedir(), ".codex"))
    expect(credentialReadPaths("claude")).not.toContain(path.join(homedir(), ".claude"))
    expect(credentialReadPaths("verify", ["~/extra-auth", "private/**"])).toContain(path.join(homedir(), "extra-auth"))
  })
})

describe("content scanning", () => {
  test("redacts complete PEM blocks, including an unterminated block", () => {
    for (const suffix of ["\n-----END RSA PRIVATE KEY-----", ""]) {
      const text = "before\n-----BEGIN RSA PRIVATE KEY-----\n" + "A".repeat(40) + suffix
      const result = scanText(text)
      expect(result.text).toBe("before\n[redacted:private-key]")
      expect(result.flags).toEqual(["private-key"])
    }
  })

  test("redacts high-confidence standalone credential shapes", () => {
    const values = ["AKIA" + "A".repeat(16), "ASIA" + "B".repeat(16), "ghp_" + "c".repeat(36), "github_pat_" + "d".repeat(50), "sk-" + "e".repeat(25), "sk-ant-" + "f".repeat(30), "xoxb-" + "1".repeat(30)]
    const result = scanText(values.join("\n"))
    for (const value of values) expect(result.text).not.toContain(value)
    expect(result.flags).toEqual(["aws-key", "github-token", "api-token", "slack-token"])
    expect(scanText(result.text)).toEqual({ text: result.text, flags: [] })
  })

  test("redacts long assignments without exposing values in flags", () => {
    const value = "synthetic".repeat(4)
    for (const prefix of ["api_key=", '"token": "', "PASSWORD='", "CLIENT_SECRET = ", "ACCESS_TOKEN="]) {
      const result = scanText(prefix + value)
      expect(result.text).not.toContain(value)
      expect(result.flags).toEqual(["credential-value"])
    }
    expect(scanText("token=short password=test api_key=example")).toEqual({ text: "token=short password=test api_key=example", flags: [] })
  })

  test("sanitizes structured artifacts without destroying JSON or changing input", () => {
    const input = { token: "synthetic".repeat(4), nested: [{ message: "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(40), count: 12 }], keep: "ordinary text", nullable: null }
    const result = sanitizeValue(input)
    expect(result.value.token).toBe("[redacted:credential-value]")
    expect(result.value.nested[0].message).toBe("[redacted:private-key]")
    expect(result.value.nested[0].count).toBe(12)
    expect(result.value.keep).toBe(input.keep)
    expect(input.token).toBe("synthetic".repeat(4))
    expect(JSON.parse(JSON.stringify(result.value))).toEqual(result.value)
    expect(sanitizeValue(result.value).flags).toEqual([])
    expect(result.flags.sort()).toEqual(["credential-value", "private-key"])
  })
})

describe("environment allowlist", () => {
  test("excludes inherited auth and git overrides unless explicitly named", () => {
    const names = ["ORCH_TEST_SECRET", "SSH_AUTH_SOCK", "GIT_CONFIG_GLOBAL", "GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]
    const old = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    try {
      for (const name of names) process.env[name] = "synthetic-value"
      const env = safeEnv("verify", [], "/tmp/orch-tests")
      expect(env.ORCH_TEST_SECRET).toBeUndefined()
      expect(env.SSH_AUTH_SOCK).toBeUndefined()
      expect(env.GIT_DIR).toBeUndefined()
      expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null")
      expect(env.GIT_CONFIG_NOSYSTEM).toBe("1")
      expect(env.GIT_CONFIG_COUNT).toBe("1")
      expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper")
      expect(env.GIT_CONFIG_VALUE_0).toBe("")
      expect(env.GIT_OPTIONAL_LOCKS).toBe("0")
      expect(env.TMPDIR).toBe("/tmp/orch-tests")
      expect(env.PATH).toContain(".bun/bin")
      expect(safeEnv("claude", ["ORCH_TEST_SECRET"]).ORCH_TEST_SECRET).toBe("synthetic-value")
      expect(safeEnv("verify", ["GIT_CONFIG_GLOBAL"]).GIT_CONFIG_GLOBAL).toBe("/dev/null")
      expect(safeEnv("verify", names).GIT_CONFIG_COUNT).toBe("1")
      expect(safeEnv("claude", names).GIT_CONFIG_KEY_0).toBe("credential.helper")
      expect(safeEnv("claude", names).GIT_CONFIG_VALUE_0).toBe("")
      expect(() => safeEnv("verify", ["INVALID=NAME"])).toThrow()
    } finally {
      for (const name of names) {
        if (old[name] === undefined) delete process.env[name]
        else process.env[name] = old[name]
      }
    }
  })

  test.skipIf(!Bun.which("git"))("resets repository-local credential helpers without credentials or network", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "orch-helper-test-"))
    const env = safeEnv("verify", [], dir)
    try {
      expect(spawnSync("git", ["init", "--quiet", "--template=", dir], { env }).status).toBe(0)
      const sentinel = path.join(dir, "helper-called.txt")
      const helper = "!f() { printf called > helper-called.txt; }; f"
      const config = path.join(dir, ".git/config")
      writeFileSync(config, readFileSync(config, "utf8") + `\n[credential]\n\thelper = ${JSON.stringify(helper)}\n`)
      const input = "protocol=https\nhost=orchestrate.invalid\n\n"
      const controlEnv = { ...env, GIT_CONFIG_COUNT: "0" }
      expect(spawnSync("git", ["credential", "fill"], { cwd: dir, env: controlEnv, input, encoding: "utf8" }).status).not.toBe(0)
      expect(existsSync(sentinel)).toBe(true)
      rmSync(sentinel)
      expect(spawnSync("git", ["credential", "fill"], { cwd: dir, env, input, encoding: "utf8" }).status).not.toBe(0)
      expect(existsSync(sentinel)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
