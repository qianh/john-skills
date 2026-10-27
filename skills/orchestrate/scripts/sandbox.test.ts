import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { commandPermissions, gitWriteDenyPaths, missingPermissions, parseAllow, routeAdmission, sandboxProfile, verifyCommand, type SandboxOptions } from "./sandbox.ts"
import type { Plan } from "./contracts.ts"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
test("network scopes and destructive categories remain independent", () => {
  expect(parseAllow("deps,network:registry.npmjs.org,example.org,push")).toEqual(["deps", "network:registry.npmjs.org", "network:example.org", "push"])
  expect(() => parseAllow("network")).toThrow("范围")
  expect(() => parseAllow("network:https://example.org")).toThrow("域名")
  for (const [cmd, needed] of [["git push origin main", "push"], ["npm publish", "publish"], ["make deploy", "deploy"], ["rm -rf output", "data"], ["rm --recursive --force output", "data"], ["git clean -fdx", "data"], ["find . -delete", "data"], ["npm install thing", "deps"]]) expect(commandPermissions(cmd)).toContain(needed)
  const plan: Plan = { exec_type: "standard", criteria: [{ id: "C1", text: "release", kind: "command", commands: ["npm publish", "git push"] }], needs_permission: [], allowed_paths: ["**"], steps: ["release"], context: [] }
  expect(missingPermissions(plan, ["network:*"])).toEqual(["publish", "push"])
  expect(missingPermissions({ ...plan, needs_permission: [{ category: "other", reason: "manual action" }] }, ["network:*", "publish", "push"])).toEqual(["other"])
})
test("unverified providers are denied by default, pi never executes", () => {
  expect(routeAdmission("claude", "plan", { unsafeRead: [], unsafeExec: [] }).admitted).toBe(false)
  expect(routeAdmission("grok", "exec", { unsafeRead: ["grok"], unsafeExec: [] }).admitted).toBe(false)
  expect(routeAdmission("pi", "exec", { unsafeRead: ["pi"], unsafeExec: ["pi"] }).admitted).toBe(false)
  expect(routeAdmission("claude", "exec", { unsafeRead: ["claude"], unsafeExec: ["claude"] }).admitted).toBe(true)
})
test("profile generation never widens domain-only networking", () => {
  const options = { cwd: "/tmp", gitDir: "/tmp/.git", tmpDir: "/tmp", allow: ["network:example.invalid"] }
  expect(sandboxProfile(options)).toContain("(deny network*)")
  expect(sandboxProfile({ ...options, allow: ["network:*"] })).not.toContain("(deny network*)")
  expect(() => sandboxProfile({ ...options, sensitiveExtra: ["secrets/[a-z]*"] })).toThrow("拒绝裸跑")
})
test("worktree metadata protection is shared with execution, including a nonstandard common directory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "orch-worktree-sandbox-")); roots.push(root)
  const cwd = path.join(root, "workspace"), common = path.join(cwd, "shared-meta"), gitDir = path.join(cwd, "private-meta"), tmpDir = path.join(root, "temp")
  for (const dir of [cwd, common, gitDir, tmpDir]) mkdirSync(dir)
  writeFileSync(path.join(gitDir, "commondir"), "../shared-meta\n")
  const denied = gitWriteDenyPaths(cwd, gitDir)
  expect(denied).toEqual([realpathSync(gitDir), path.join(realpathSync(cwd), ".git"), realpathSync(common)])
  const options = { cwd, gitDir, tmpDir, allow: [] }
  const profile = sandboxProfile(options)
  for (const dir of denied) expect(profile).toContain(`(subpath ${JSON.stringify(dir)})`)
  if (process.platform === "darwin" && Bun.which("sandbox-exec")) {
    for (const dir of [common, gitDir]) expect((await verifyCommand(`printf unsafe > ${JSON.stringify(path.join(dir, "config"))}`, options)).code).not.toBe(0)
    expect((await verifyCommand("printf safe > source.txt", options)).code).toBe(0)
  }
})
test("new sensitive paths are denied by pattern, including uppercase directories and root ** extras", async () => {
  if (process.platform !== "darwin" || !Bun.which("sandbox-exec")) return
  const root = mkdtempSync(path.join(tmpdir(), "orch-sandbox-")); roots.push(root)
  const cwd = path.join(root, "workspace"), tmpDir = path.join(root, "temp")
  mkdirSync(cwd); mkdirSync(tmpDir); mkdirSync(path.join(cwd, ".git")); mkdirSync(path.join(cwd, ".AWS")); mkdirSync(path.join(cwd, "private"))
  for (const file of [".AWS/config", ".ENV", "fixture.PEM", "private/data.txt", ".env.example"]) writeFileSync(path.join(cwd, file), "synthetic fixture only\n")
  const options: SandboxOptions = { cwd, gitDir: path.join(cwd, ".git"), tmpDir, allow: [], sensitiveExtra: ["**/private/**"] }
  for (const file of [".AWS/config", ".ENV", "fixture.PEM", "private/data.txt"]) {
    const output = await verifyCommand(`/bin/cat '${file}'`, options)
    expect(output.code).not.toBe(0); expect(output.blocked).toBe(true)
  }
  expect((await verifyCommand("/bin/cat .env.example", options)).code).toBe(0)
}, 10_000)
