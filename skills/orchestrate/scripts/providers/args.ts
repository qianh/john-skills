import { clampEffort } from "./effort.ts"
import type { StageRequest } from "./types.ts"

export interface Command {
  argv: string[]
  effort: string
  adjusted?: string
}

function promptOf(req: StageRequest): string {
  if (req.provider === "pi" && req.schema) {
    return `${req.prompt}\n\n回复中必须恰好包含一个 json 代码块，内容遵循下面的 JSON Schema：\n${JSON.stringify(req.schema)}`
  }
  return req.prompt
}

function effortOf(req: StageRequest) {
  return clampEffort(req.provider, req.model, req.effort, req.supportedEfforts)
}

/**
 * Claude 精简启动（实测，claude 2.1.310）：
 * --safe-mode --strict-mcp-config --disable-slash-commands --no-chrome
 * 把工具收成 Read/Grep/Glob，mcp 和 skills 都是空的，一次冷启动约 6k token。
 * 不要用 --bare：它不读 OAuth。
 * 不要用模型别名（haiku 会被按 sonnet 计费），传完整 id。
 * --safe-mode 会忽略 --agents，自定义子会话固定不了模型。
 */
export function claudeCommand(req: StageRequest): Command {
  const choice = effortOf(req)
  const readOnly = req.role !== "exec"
  const argv = [
    "claude", "-p",
    "--output-format", "json",
    "--model", req.model,
    "--effort", choice.effort,
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--tools", readOnly ? "Read,Grep,Glob" : "Read,Grep,Glob,Bash,Edit,Write",
    "--permission-mode", readOnly ? "plan" : "acceptEdits",
  ]
  if (readOnly) argv.push("--permission-prompts", "none")
  else argv.push("--allowedTools", "Bash,Read,Edit,Write,Grep,Glob")
  if (req.schema) argv.push("--json-schema", JSON.stringify(req.schema))
  if (req.sandbox?.settings) argv.push("--settings", JSON.stringify(req.sandbox.settings))
  if (req.resume) {
    if (!req.sessionId) throw new Error("续接 claude 需要 sessionId")
    argv.push("-r", req.sessionId)
  } else if (req.sessionId) {
    argv.push("--session-id", req.sessionId)
  }
  argv.push(promptOf(req))
  return { argv, effort: choice.effort, adjusted: choice.adjusted }
}

/**
 * grok 1.0.70：没有能卸掉 skill 列表和 MCP 的开关。
 * --system-prompt-override 加 --tools 收窄后，冷启动仍约 17k token（不收窄约 25k）。
 * 只读角色必须 --no-subagents，plan 模式挡不住子会话写文件。
 * --ephemeral 不存在。续接用 -r。
 */
export function grokCommand(req: StageRequest): Command {
  const choice = effortOf(req)
  const readOnly = req.role !== "exec"
  const argv = [
    "grok", "-p", promptOf(req),
    "--output-format", "json",
    "--model", req.model,
    "--reasoning-effort", choice.effort,
    "--disable-web-search",
    "--permission-mode", readOnly ? "plan" : "acceptEdits",
    "--cwd", req.cwd,
  ]
  if (readOnly) {
    argv.push("--no-subagents", "--disallowed-tools", "Agent", "--max-turns", "8")
    argv.push("--tools", "read_file,grep,list_dir")
  } else {
    // 并发交给调度器，不让 grok 自己再开子会话，否则账拆不开。
    argv.push("--no-subagents", "--disallowed-tools", "Agent", "--max-turns", "30")
  }
  if (req.schema) argv.push("--json-schema", JSON.stringify(req.schema))
  if (req.sandbox?.profile) argv.push("--sandbox", req.sandbox.profile)
  if (req.resume) {
    if (!req.sessionId) throw new Error("续接 grok 需要 sessionId")
    argv.push("-r", req.sessionId)
  } else if (req.sessionId) {
    argv.push("--session-id", req.sessionId)
  }
  return { argv, effort: choice.effort, adjusted: choice.adjusted }
}

/**
 * pi：--no-mcp --tools 能把冷启动压到约 7k token，并且直接给出金额。
 * 非法思考程度只警告、不失败，所以必须在这里挡掉。
 * pi 没有文件沙箱，不能执行。
 */
export function piCommand(req: StageRequest): Command {
  if (req.role === "exec") throw new Error("pi 不能承担执行：写权限限制不住")
  const choice = effortOf(req)
  const effort = choice.effort
  const argv = [
    "pi", "-p",
    "--mode", "json",
    "--model", req.model,
    "--thinking", effort,
    "--no-mcp",
    "--tools", "read,grep,find,ls",
  ]
  if (req.sessionDir) argv.push("--session-dir", req.sessionDir)
  if (req.sessionId) argv.push("--session-id", req.sessionId)
  else argv.push("--no-session")
  argv.push(promptOf(req))
  return { argv, effort, adjusted: choice.adjusted }
}

/**
 * codex 0.164.0：-s、--color、-C 属于 exec 父命令，必须放在 resume 前。
 * --help 已离线核对参数位置；真实模型调用及沙箱强度仍需单独实测。
 */
export function codexCommand(req: StageRequest): Command {
  const choice = effortOf(req)
  const readOnly = req.role !== "exec"
  const argv = [
    "codex", "exec",
    "-s", readOnly ? "read-only" : "workspace-write",
    "--color", "never",
    "-C", req.cwd,
  ]
  if (req.resume) {
    if (!req.sessionId) throw new Error("续接 codex 需要 sessionId")
    argv.push("resume", req.sessionId)
  }
  argv.push("--skip-git-repo-check", "-m", req.model,
    "-c", 'approval_policy="never"',
    "-c", `model_reasoning_effort="${choice.effort}"`, "--json")
  if (req.schema && !req.schemaPath) throw new Error("codex 结构化输出需要 schemaPath")
  if (req.schemaPath) argv.push("--output-schema", req.schemaPath)
  argv.push(promptOf(req))
  return { argv, effort: choice.effort, adjusted: choice.adjusted }
}

export function commandFor(req: StageRequest): Command {
  switch (req.provider) {
    case "claude": return claudeCommand(req)
    case "grok": return grokCommand(req)
    case "pi": return piCommand(req)
    case "codex": return codexCommand(req)
  }
}
