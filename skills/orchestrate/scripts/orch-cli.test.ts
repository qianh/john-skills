import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { main, parseArgs, report } from "./orch.ts"
import { stopWorkers } from "./runtime.ts"
const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const cli = path.join(import.meta.dir, "orch.ts")
function fixture(git = true) {
  const root = mkdtempSync(path.join(tmpdir(), "orch-cli-")); roots.push(root)
  const cwd = path.join(root, "repo"), config = path.join(root, "config"), bin = path.join(root, "bin")
  mkdirSync(cwd); mkdirSync(config); mkdirSync(bin); mkdirSync(path.join(cwd, "src"))
  writeFileSync(path.join(cwd, "src/x.ts"), "before\n")
  if (git) {
    for (const args of [["init", "-q"], ["add", "src/x.ts"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "fixture"]]) {
      const result = spawnSync("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }); if (result.status !== 0) throw new Error("fixture git failed")
    }
  }
  writeFileSync(path.join(config, "models.conf"), "haiku-5.5 claude fixture-haiku\nopus-5.5 claude fixture-opus\nsonnet-5.5 claude fixture-sonnet\ngpt-6.1-sol grok fixture-gpt\n")
  writeFileSync(path.join(config, "routing.toml"), `
[positions.explore]
chain = [{ model = "haiku-5.5", effort = "low" }]
[positions.plan]
chain = [{ model = "opus-5.5", effort = "medium" }]
[positions.review]
chain = [{ model = "gpt-6.1-sol", effort = "high" }]
[positions.exec]
default_pool = "standard"
[positions.exec.pools]
mechanical = ["sonnet-5.5"]
standard = ["sonnet-5.5"]
hard = ["sonnet-5.5"]
[safety]
unsafe_read = ["claude", "grok"]
unsafe_exec = ["claude"]
[safety.cli_env]
claude = ["ORCH_FIXTURE_DELAY"]
`)
  const source = `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2), provider=path.basename(process.argv[1]);
const val=(n)=>args[args.indexOf(n)+1];
if(args[0]==='auth'){console.log('{"loggedIn":true}');process.exit(0)}
if(args[0]==='models'){console.log('- fixture-gpt');process.exit(0)}
if(provider==='pi'||provider==='codex'){process.exit(1)}
const schema=args.includes('--json-schema')?JSON.parse(val('--json-schema')):null;
const prompt=provider==='grok'?val('-p'):args.at(-1);
const session=val('--session-id')||val('-r')||crypto.randomUUID();
let answer='notes';
if(schema?.properties?.exec_type){answer={exec_type:'standard',criteria:[{id:'C1',kind:'command',text:'changed',commands:[${JSON.stringify(JSON.stringify(process.execPath) + ' -e \'if (require("node:fs").readFileSync("src/x.ts","utf8").trim() !== "after") process.exit(1)\'')}]}],allowed_paths:['src/**'],needs_permission:[],steps:['change src'],context:[]}}
else if(schema){answer={p1:[],p2:[],criteria:[],out_of_scope:[],reviewed_tree:prompt.match(/原样填：([^\\s]+)/)[1]}}
else if(provider==='claude'&&val('--tools').includes('Bash')){fs.writeFileSync('src/x.ts','after\\n');if(process.env.ORCH_FIXTURE_DELAY==='yes')await new Promise(r=>setTimeout(r,120000));answer='implemented'}
const usage={input_tokens:10,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0};
console.log(JSON.stringify(provider==='claude'?{type:'result',result:typeof answer==='string'?answer:JSON.stringify(answer),session_id:session,usage,total_cost_usd:0.01}:{text:JSON.stringify(answer),sessionId:session,usage,total_cost_usd:0.01}));
`
  for (const name of ["claude", "grok", "codex", "pi"]) { const file = path.join(bin, name); writeFileSync(file, source); chmodSync(file, 0o755) }
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, USER: "fixture", ORCHESTRATE_MODE: "dynamic", ORCHESTRATE_HOME: config, XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state") }
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, cli, ...args], { cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { stdout, stderr, code }
  }
  const runDir = () => {
    const base = git ? path.join(cwd, ".git/orchestrate") : path.join(root, "state/orchestrate")
    return path.join(base, readdirSync(base).find((n) => existsSync(path.join(base, n, "state.json")))!)
  }
  return { root, cwd, env, run, runDir }
}

test("CLI arguments reject typos/missing values and preserve a quoted goal", () => {
  expect(parseArgs(["run", "--budget", "1.5", "--allow", "deps", "fix it"]).goal).toBe("fix it")
  expect(parseArgs(["run", "--mode", "dynamic", "fix it"]).values.mode).toEqual(["dynamic"])
  expect(() => parseArgs(["run", "--typo"])).toThrow("未知")
  expect(() => parseArgs(["continue", "--run"])).toThrow("缺少值")
})
test("simple mode is an explicit no-worker handoff", async () => {
  expect(await main(["run", "--mode", "simple", "do the task"])).toBe(3)
})
test("simple mode is the default when no mode is configured", async () => {
  const previous = process.env.ORCHESTRATE_MODE
  try {
    delete process.env.ORCHESTRATE_MODE
    expect(await main(["run", "do the task"])).toBe(3)
  } finally {
    if (previous === undefined) delete process.env.ORCHESTRATE_MODE
    else process.env.ORCHESTRATE_MODE = previous
  }
})
test("report uses the ledger and discloses missing state and unreadable records", () => {
  const root = mkdtempSync(path.join(tmpdir(), "orch-report-")); roots.push(root)
  mkdirSync(path.join(root, "old")); mkdirSync(path.join(root, "broken"))
  writeFileSync(path.join(root, "old/usage.jsonl"), JSON.stringify({ role: "exec", alias: "sonnet-5.5", usage: { costUsd: null }, error: "failed" }) + "\n")
  writeFileSync(path.join(root, "broken/usage.jsonl"), "not JSON")
  const text = report(root)
  expect(text).toContain("1 次轮数未知，1 份账本无法读取")
  expect(text).toContain("失败率 100.0%")
  expect(text).toContain("未报价 1 次")
})
test("real CLI + fake workers + real git snapshots + sandbox evidence complete locally", async () => {
  const f = fixture(), output = await f.run(["run", "--cwd", f.cwd, "change source"])
  expect(output.code).toBe(process.platform === "darwin" ? 0 : 5)
  expect(output.stdout.split("\n").filter(Boolean).length).toBeLessThanOrEqual(30)
  const state = JSON.parse(readFileSync(path.join(f.runDir(), "state.json"), "utf8"))
  expect(state.calls.length).toBe(process.platform === "darwin" ? 4 : 3)
  expect(readFileSync(path.join(f.cwd, "src/x.ts"), "utf8")).toBe("after\n")
  const report = await f.run(["report"]); expect(report.code).toBe(0); expect(report.stdout).toContain("exec/sonnet-5.5")
  const status = await f.run(["status", "--run", f.runDir()]); expect(status.stdout).toContain("状态：done")
}, 60_000)
test("plan-only continues by explicit author and does not execute while waiting", async () => {
  const f = fixture(); const first = await f.run(["run", "--plan-only", "change"]); expect(first.code).toBe(3)
  expect(readFileSync(path.join(f.cwd, "src/x.ts"), "utf8")).toBe("before\n")
  const file = path.join(f.runDir(), "state.json"), saved = readFileSync(file, "utf8")
  const missing = await f.run(["continue", "--run", f.runDir()]); expect(missing.code).toBe(2)
  const invalid = await f.run(["continue", "--run", f.runDir(), "--by", "sonnet-5.5", "--budget", "1"])
  expect(invalid.code).toBe(2); expect(readFileSync(file, "utf8")).toBe(saved)
  const typo = await f.run(["continue", "--run", f.runDir(), "--by", "typo"])
  expect(typo.code).toBe(2); expect(typo.stderr).toContain("--by 未知能力"); expect(readFileSync(file, "utf8")).toBe(saved)
  const continued = await f.run(["continue", "--run", f.runDir(), "--by", "sonnet-5.5", "--budget", "1", "--max-calls", "12"])
  expect(continued.code).toBe(process.platform === "darwin" ? 0 : 5)
}, 30_000)
test("non-git editing is refused, read-only review records stay outside project", async () => {
  const f = fixture(false)
  expect((await f.run(["run", "change"])).code).toBe(2)
  writeFileSync(path.join(f.cwd, "image.bin"), Buffer.from([0, 1, 2]))
  writeFileSync(path.join(f.cwd, "large.txt"), "x".repeat(1_000_001))
  const output = await f.run(["review", "inspect"])
  expect(output.code).toBe(0); expect(existsSync(path.join(f.cwd, "orchestrate"))).toBe(false)
  expect(f.runDir()).toContain(path.join(f.root, "state"))
  expect(output.stdout).toContain("仅已展开文本"); expect(output.stdout).toContain("image.bin"); expect(output.stdout).toContain("large.txt")
}, 20_000)
test("SIGKILL leaves a tracked worker; continue refuses, stop clears it, recovery does not replay blindly", async () => {
  const f = fixture()
  const proc = Bun.spawn([process.execPath, cli, "run", "change"], { cwd: f.cwd, env: { ...f.env, ORCH_FIXTURE_DELAY: "yes" }, stdout: "ignore", stderr: "ignore" })
  let runDir = "", found = false
  try {
    // Other integration files may run in parallel; allow a slow worker spawn
    // without treating the recovery protocol as broken.
    for (let i = 0; i < 400; i++) {
      await Bun.sleep(50)
      try { runDir = f.runDir(); const state = JSON.parse(readFileSync(path.join(runDir, "state.json"), "utf8")); if (state.step === "exec" && state.workers.length) { found = true; break } } catch {}
    }
    expect(found).toBe(true)
    const executing = JSON.parse(readFileSync(path.join(runDir, "state.json"), "utf8"))
    expect(executing.authors.some((a: { alias: string }) => a.alias === "sonnet-5.5")).toBe(true)
    process.kill(proc.pid, "SIGKILL"); await proc.exited
    const blocked = await f.run(["continue", "--run", runDir, "--by", "sonnet-5.5"])
    expect(blocked.code).toBe(2); expect(blocked.stderr).toContain("worker")
    expect((await f.run(["stop", "--run", runDir])).code).toBe(4)
    const recovered = await f.run(["continue", "--run", runDir, "--by", "sonnet-5.5"])
    expect(recovered.code).toBe(process.platform === "darwin" ? 0 : 5)
    expect(recovered.stdout).toContain("合计 ≥ ")
  } finally {
    try { proc.kill("SIGKILL") } catch {}
    if (runDir) { const state = JSON.parse(readFileSync(path.join(runDir, "state.json"), "utf8")); await stopWorkers(state.workers) }
  }
}, 60_000)
