import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { loadConfig, resolveConfigDir } from "./config.ts"
import { cliProvider } from "./cli-provider.ts"
import { continueFlow, runFlow, type CommandOutput, type WorkspaceDiff } from "./flow.ts"
import { detectHosts } from "./preflight.ts"

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function runCommand(command: string, cwd: string): Promise<CommandOutput> {
  const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" })
  return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }))
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  return result.stdout ?? ""
}

async function workspaceDiff(cwd: string): Promise<WorkspaceDiff> {
  const status = git(["status", "--short"], cwd).trim()
  const patch = git(["diff", "--no-ext-diff"], cwd)
  const untracked = git(["ls-files", "--others", "--exclude-standard"], cwd).trim()
  const extras: string[] = []
  let budget = 20_000
  for (const file of untracked ? untracked.split("\n") : []) {
    try {
      const full = path.join(cwd, file)
      const size = statSync(full).size
      if (size > budget) {
        extras.push(`未跟踪 ${file}（${size} 字节，未展开）`)
        continue
      }
      extras.push(`--- ${file}\n${readFileSync(full, "utf8")}`)
      budget -= size
    } catch {
      extras.push(`未跟踪 ${file}`)
    }
  }
  return { status, patch: [patch, extras.join("\n")].filter(Boolean).join("\n") }
}

async function preflight(): Promise<void> {
  const hosts = await detectHosts()
  for (const host of hosts) console.log(`${host.provider}\t${host.installed ? "已安装" : "未安装"}\t${host.loggedIn ? "已登录" : host.detail}`)
}

async function run(): Promise<number> {
  const goal = process.argv.slice(2).filter((item, index, all) => item !== "run" && all[index - 1] !== "--cwd" && all[index - 1] !== "--exec" && !item.startsWith("--")).join(" ").trim()
  if (!goal) {
    console.error("用法: orch.ts run [--cwd 目录] [--exec 模型别名] \"<目标>\"")
    return 2
  }
  const cwd = path.resolve(arg("--cwd") || process.cwd())
  const located = resolveConfigDir()
  const config = loadConfig(located)
  const hosts = await detectHosts()
  const gitDir = git(["rev-parse", "--git-dir"], cwd).trim()
  const root = gitDir ? path.resolve(cwd, gitDir) : cwd
  const runDir = path.join(root, "orchestrate", new Date().toISOString().replace(/[:.]/g, "-"))
  mkdirSync(runDir, { recursive: true })
  const outcome = await runFlow({
    cwd,
    goal,
    runDir,
    config,
    hosts,
    provider: cliProvider(),
    execPin: arg("--exec"),
    runCommand,
    diff: workspaceDiff,
    newId: () => crypto.randomUUID(),
    log: (line) => console.error(line),
  })
  console.log(outcome.summary)
  return outcome.ok ? 0 : 1
}

async function resume(): Promise<number> {
  const runDir = arg("--run")
  if (!runDir) {
    console.error("用法: orch.ts continue --run <运行目录>")
    return 2
  }
  const outcome = await continueFlow({
    cwd: path.resolve(arg("--cwd") || process.cwd()),
    goal: "",
    runDir: path.resolve(runDir),
    config: loadConfig(resolveConfigDir()),
    hosts: await detectHosts(),
    provider: cliProvider(),
    execPin: arg("--exec"),
    runCommand,
    diff: workspaceDiff,
    newId: () => crypto.randomUUID(),
    log: (line) => console.error(line),
  })
  console.log(outcome.summary)
  return outcome.ok ? 0 : 1
}

const command = process.argv[2]
if (command === "preflight") {
  await preflight()
} else if (command === "run") {
  process.exit(await run())
} else if (command === "continue") {
  process.exit(await resume())
} else {
  console.error("用法: orch.ts preflight | run [--cwd 目录] [--exec 模型别名] \"<目标>\" | continue --run <运行目录>")
  process.exit(2)
}
