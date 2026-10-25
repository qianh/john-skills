const GUARD = "你是被 orchestrate 调度的子代理。不要使用 orchestrate，不要再派发子任务或调用其他模型。只完成下面的任务，把结果写在回复里。"

export function explorePrompt(goal: string): string {
  return `${GUARD}

只读查看当前仓库，为后面的方案收集材料。不要改文件。

# 目标
${goal}

# 回复
列出会被改到或必须理解的文件。每条写成「路径:行号 一句话结论」。没有相关代码就说明仓库现在是什么样。不要写方案，不要写代码。`
}

export function planPrompt(goal: string, notes: string): string {
  return `${GUARD}

根据目标和下面的笔记写实施方案。可以再读文件核对，不要改任何文件。笔记里已有的结论不要再探索一遍。

# 目标
${goal}

# 笔记
${notes}

# 回复格式
必须按这个结构，执行类型只能是 mechanical、standard、hard 其中一个：

## 执行类型
standard

## 验收
每行一条命令。没有就写 无

## 方案
目标、步骤、允许改的文件、不要做的事。涉及的代码写成「路径:行号 结论」，让执行的人不用再把仓库翻一遍。

mechanical 是改名、补类型、样板代码。standard 是常规功能。hard 是疑难 bug 或核心逻辑。验收下面每行一条可以在仓库根目录运行的命令，没有就写「无」。`
}

export function execPrompt(goal: string, plan: string, acceptance: string[]): string {
  return `${GUARD}

按方案改代码，并自己把验收命令跑到通过。不要 commit，不要 push，不要装新依赖，除非方案明确写了。

# 目标
${goal}

# 方案
${plan}

# 验收
${acceptance.length ? acceptance.join("\n") : "方案没有单独的验收命令，用方案里的完成标准自己判断。"}

# 回复
说明改了哪些文件、跑了什么命令、结果是通过还是失败。没做完的写出来。`
}

export function resumeExecPrompt(plan: string, findings: string[], diff: string): string {
  return `${GUARD}

继续上次的实现。下面是 review 认为必须改的问题。已经改过的不要重做，不要 commit。

# 方案
${plan}

# 必须改
${findings.map((item) => `- ${item}`).join("\n")}

# 当前 diff
${diff}

改完把验收再跑一遍，并说明结果。`
}

export function takeoverExecPrompt(goal: string, plan: string, diff: string, reason: string): string {
  return `${GUARD}

上一个执行模型没有做完（${reason}）。从当前代码继续，不要推倒重来，不要 commit。

# 目标
${goal}

# 方案
${plan}

# 当前 diff
${diff}

做完说明改了什么、验收结果、还没做的部分。`
}

export function reviewPrompt(goal: string, plan: string, diff: string): string {
  return `${GUARD}

只读审查这次改动。对照方案和目标，找会让验收失败或行为错误的问题。不要按自己的口味改风格。不要改文件。

# 目标
${goal}

# 方案
${plan}

# diff
${diff}

# 回复格式
## P1
- 必须改的问题，带文件路径和行号。没有就写「无」

## P2
- 可以以后再改的问题。没有就写「无」`
}

export function rereviewPrompt(diff: string): string {
  return `${GUARD}

执行模型按你上次的 P1 改了一轮。只看下面这份新 diff 里有没有还没解决的 P1。不要重审已经没问题的部分，不要改文件。

# 新 diff
${diff}

# 回复格式
## P1
- 仍要改的问题。没有就写「无」

## P2
- 可以以后再改的问题。没有就写「无」`
}
