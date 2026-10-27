import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { verifyCommand, type SandboxOptions } from "./sandbox.ts"
import { safeEnv, scanText } from "./safety.ts"

export interface IsolationProbe { name: string; outcome: "pass" | "fail" | "skip"; code?: number; reason: string }
export interface VerificationIsolation {
  target: "verify-only"
  status: "pass" | "fail" | "unavailable"
  date: string
  platform: string
  probes: IsolationProbe[]
  limitations: string[]
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Synthetic local probes only: no model request and no real credential is inspected. */
export async function runVerificationIsolation(): Promise<VerificationIsolation> {
  const result: VerificationIsolation = {
    target: "verify-only", status: "unavailable", date: new Date().toISOString(), platform: process.platform, probes: [],
    limitations: ["只验证脚本验收沙箱，不证明任何模型 CLI 已隔离", "凭证探针使用临时合成路径，不读取真实凭证或钥匙串", "任一成功不外推到未测试的平台、工具或 CLI 版本"],
  }
  if (process.platform !== "darwin" || !Bun.which("sandbox-exec")) {
    result.probes.push({ name: "sandbox-available", outcome: "skip", reason: "没有已支持的 sandbox-exec；未裸跑命令" })
    return result
  }
  const root = mkdtempSync(path.join(tmpdir(), "orch-isolation-"))
  const cwd = path.join(root, "workspace"), tmp = path.join(root, "temp"), gitDir = path.join(cwd, ".git")
  mkdirSync(gitDir, { recursive: true }); mkdirSync(tmp)
  mkdirSync(path.join(cwd, "mock-home/.aws"), { recursive: true })
  writeFileSync(path.join(cwd, "fixture.key"), "synthetic fixture; not a key\n")
  writeFileSync(path.join(cwd, "mock-home/.aws/config"), "synthetic fixture; not credentials\n")
  const outside = path.join(root, "outside.txt")
  writeFileSync(outside, "unchanged")
  const options: SandboxOptions = { cwd, gitDir, tmpDir: tmp, allow: [], sensitivePaths: ["fixture.key", "mock-home/.aws/config"], timeoutMs: 15_000 }
  const probe = async (name: string, command: string, expected: "allow" | "deny", overrides: Partial<SandboxOptions> = {}, check?: () => boolean) => {
    const output = await verifyCommand(command, { ...options, ...overrides })
    const ok = (expected === "allow" ? output.code === 0 : output.code !== 0 && !output.timedOut) && (!check || check())
    const diagnostic = scanText(`${output.stderr}\n${output.stdout}`).text.replace(/\s+/g, " ").slice(-350)
    result.probes.push({ name, outcome: ok ? "pass" : "fail", code: output.code, reason: ok ? expected === "allow" ? "合成操作获准" : "合成越界操作被拒绝" : output.blocked ? "沙箱不能初始化或规则不符合预期" : `结果不符合预期；没有扩大权限重试${diagnostic ? `：${diagnostic}` : ""}` })
    return output
  }
  let server: ReturnType<typeof createServer> | undefined
  try {
    const first = await probe("workspace-write", "printf ok > inside.txt", "allow", {}, () => existsSync(path.join(cwd, "inside.txt")))
    if (first.blocked && first.code !== 0) return result
    await probe("outside-write-denied", `printf changed > ${quote(outside)}`, "deny", {}, () => readFileSync(outside, "utf8") === "unchanged")
    await probe("git-metadata-write-denied", "printf forbidden > .git/forbidden", "deny", {}, () => !existsSync(path.join(gitDir, "forbidden")))
    await probe("private-temp-write", 'printf ok > "$TMPDIR/probe.txt"', "allow", {}, () => existsSync(path.join(tmp, "probe.txt")))
    await probe("sensitive-file-read-denied", "/bin/cat fixture.key", "deny")
    await probe("synthetic-credential-read-denied", "/bin/cat mock-home/.aws/config", "deny")
    const env = await probe("minimal-environment", "/usr/bin/env | /usr/bin/cut -d= -f1", "allow")
    const names = env.stdout.trim().split("\n").filter(Boolean)
    const unexpected = names.filter((name) => !["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS", "PWD", "SHLVL", "_"].includes(name) && !name.startsWith("LC_"))
    if (unexpected.length) { result.probes.at(-1)!.outcome = "fail"; result.probes.at(-1)!.reason = `出现白名单外的变量名（不含值）：${unexpected.join(", ")}` }
    const git = Bun.which("git")
    if (git) {
      const init = spawnSync(git, ["init", "--quiet", "--template=", cwd], { env: safeEnv("verify", [], tmp), encoding: "utf8" })
      if (init.status === 0) {
        const sentinel = path.join(cwd, "helper-called.txt")
        const config = path.join(gitDir, "config")
        const helper = "!f() { printf called > helper-called.txt; }; f"
        writeFileSync(config, readFileSync(config, "utf8") + `\n[credential]\n\thelper = ${JSON.stringify(helper)}\n`)
        const control = spawnSync(git, ["credential", "fill"], { cwd, env: { ...safeEnv("verify", [], tmp), GIT_CONFIG_COUNT: "0" }, input: "protocol=https\nhost=orchestrate.invalid\n\n", encoding: "utf8" })
        const called = existsSync(sentinel)
        result.probes.push({ name: "local-helper-positive-control", outcome: called ? "pass" : "fail", code: control.status ?? undefined, reason: called ? "合成仓库的本地 helper 哨兵确实可调用；没有凭证或联网" : "本地 helper 哨兵未被调用，不能证明后续限制有效" })
        if (called) rmSync(sentinel)
        await probe("local-credential-helper-disabled", `printf 'protocol=https\\nhost=orchestrate.invalid\\n\\n' | ${quote(git)} credential fill`, "deny", {}, () => !existsSync(sentinel))
      } else result.probes.push({ name: "local-credential-helper-disabled", outcome: "fail", reason: "合成 Git 仓库初始化失败，未接触真实凭证" })
    } else result.probes.push({ name: "local-credential-helper-disabled", outcome: "skip", reason: "没有 Git，未测试本地 credential.helper 覆盖" })
    let hits = 0
    server = createServer((_req, res) => { hits++; res.end("local isolation sentinel") })
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve) })
    const address = server.address()
    if (address && typeof address !== "string") {
      const curl = Bun.which("curl")
      if (curl) {
        const command = `${quote(curl)} --noproxy '*' --max-time 2 --silent --show-error http://127.0.0.1:${address.port}/`
        await probe("default-network-denied", command, "deny", {}, () => hits === 0)
        await probe("domain-only-still-denied", command, "deny", { allow: ["network:example.invalid"] }, () => hits === 0)
        await probe("explicit-network-star-local-only", command, "allow", { allow: ["network:*"] }, () => hits === 1)
      } else result.probes.push({ name: "network", outcome: "skip", reason: "没有 curl，未测试网络边界" })
    }
    // Test collectors may stat every sibling; remove only our already-tested fixtures.
    rmSync(path.join(cwd, "fixture.key"))
    rmSync(path.join(cwd, "mock-home"), { recursive: true })
    writeFileSync(path.join(cwd, "probe.test.ts"), 'import { expect, test } from "bun:test"; test("synthetic", () => expect(2 + 2).toBe(4))\n')
    await probe("bun-test", `${quote(process.execPath)} test probe.test.ts`, "allow")
    const npm = Bun.which("npm")
    if (npm) {
      writeFileSync(path.join(cwd, "package.json"), '{"private":true,"scripts":{"test":"node --test probe.node.cjs"}}\n')
      writeFileSync(path.join(cwd, "probe.node.cjs"), 'require("node:test")("synthetic", () => require("node:assert/strict").equal(2 + 2, 4));\n')
      await probe("npm-test", `${quote(npm)} --cache "$TMPDIR/npm-cache" test`, "allow")
    } else result.probes.push({ name: "npm-test", outcome: "skip", reason: "没有 npm，未安装新依赖" })
    const pytest = Bun.which("pytest")
    if (pytest) {
      writeFileSync(path.join(cwd, "test_probe.py"), "def test_synthetic():\n    assert 2 + 2 == 4\n")
      const pyenv = pytest.includes("/.pyenv/shims/") ? Bun.which("pyenv") : null
      const select = pyenv ? `PYENV_VERSION="$(${quote(pyenv)} whence pytest | /usr/bin/head -n 1)" ` : ""
      await probe("pytest", `${select}${quote(pytest)} -q test_probe.py -p no:cacheprovider`, "allow")
      if (pyenv) result.limitations.push("pytest 只在该探针进程中选用已安装版本，没有修改全局 pyenv 配置")
    } else result.probes.push({ name: "pytest", outcome: "skip", reason: "没有 pytest，未安装新依赖" })
    result.status = result.probes.some((item) => item.outcome === "fail") ? "fail" : "pass"
    return result
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}
