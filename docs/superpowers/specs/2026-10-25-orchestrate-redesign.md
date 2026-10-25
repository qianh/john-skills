# orchestrate 重设计方案

日期：2026-10-25
状态：方案已确认。P0、P1、P2 都已完成（2026-10-25）。实测见第 16 节，端到端见第 16.8 节。

## 1. 背景与问题

现有 orchestrate（`skills/orchestrate/`）有三个问题：

1. **每道检查都新开一个会话。**
   - `dispatch.sh` 不带 `-R` 时是一次性会话（codex `--ephemeral`、pi `--no-session`），续接要靠主会话手动 `run.sh new` 并每次记得加 `-R`。
   - T0 规则要求小活也"按执行层选模型外派"，小检查、小问答都会冷启动一个无头进程，重付系统提示词、工具定义和重读文件的钱。
   - Claude 原生 subagent 路径无法续接。
2. **分工不符合预期。** 原设计按"简单 / 复杂"两档整体换模型（简单档甚至由 gpt plan、haiku 执行），而不是"顶级模型 plan、中低档执行、中高档 review"。
3. **流程是拼凑的。** SKILL.md 里写了 7 步手工流程，由主会话照着逐步派发、核验、续接，没有一个执行器把阶段串起来。

## 2. 定位

**流程与"一个模型从头做到尾"完全一致：想方案 → 写代码、跑测试、修 → 检查 → 交付。唯一区别是每个阶段换成最合适的模型。**

目标：

- 高质量完成任务（质量是前提）；
- 尽可能减少花费；
- 模型物尽其用：每个已配置的模型都有明确位置。

非目标（明确不做）：

- 不做难度分档、升级梯子、ticket 看板、gate 脚本、lane 轮换。单模型流程里没有这些，换模型也不该引入。
- 不做按单次请求的模型网关（那是 claude-code-router 的事）。
- 不在主会话里逐步指挥 worker（不做微操）。

反目标（出现即视为失败）：

- 同一角色在一次运行中反复新开会话；
- 主会话上下文被 worker 的完整输出、代码细节污染；
- 小活被外派，花费反而高于直接做；
- 悄悄替换模型而不告知。

## 3. 流程

```
主会话（推荐 sonnet-5.5 · medium，跑在 Claude Code）
 ├─ 小活：主会话自己直接做，不调用 orchestrate
 └─ 大活：调用一次 orch run "<目标>"，后台等结果
      │
      ├─ 0. 预检    脚本检查 CLI 是否安装 / 已登录，定下实际阵容（0 token）
      ├─ 1. Plan    opus-5.5 · medium    写方案、步骤、验收命令、执行类型 → plan.md
      ├─ 2. 执行    按执行类型选模型 · high  读 plan.md，改代码、跑测试、修，一个会话做完
      ├─ 3. Review  gpt-6.1-sol · xhigh  读 plan.md + git diff，按 P1/P2 列问题
      ├─ 4. 修复    P1 → 续接第 2 步的执行会话修 → 续接同一 reviewer 会话复审，最多 2 轮
      └─ 5. 复核    脚本实际跑一次验收命令（0 token），不采信模型自报
      │
主会话：读汇总，向用户汇报
```

- 改动直接落在用户工作区，不建分支、不 commit、不 push（与单模型一致）。
- 2 轮修复后 review 仍有 P1：停下，把卡点交给用户决定。
- 执行模型自己负责跑测试和修（与单模型一致），第 5 步只是事实复核。

## 4. 角色、模型与思考程度

### 4.1 主流程

| 阶段 | 默认模型 | 思考程度 | 调用方式 | 权限 |
|---|---|---|---|---|
| Plan | opus-5.5 | medium | `claude -p --effort medium` | 只读 |
| 执行 | 见 4.2 执行池 | high | 各模型原生 CLI | 仅工作目录可写 |
| Review | gpt-6.1-sol | xhigh | 本机先走 pi：`pi --model magpie/copilot/gpt-6.1-sol --thinking xhigh`。pi 和 grok 上这个 id 都回 400，实际落到 opus-5.5 · medium。见第 16.6、16.8 节 | 只读 |

规则：

- **reviewer 与 executor 不得同家族。** 执行是 gpt 时，review 自动改由 opus-5.5（medium）来审。
- 用户点名（如"这次执行用 sonnet"）优先于自动选择。

### 4.2 执行池：planner 按活的类型选一次

planner 在 plan.md 里写明执行类型，脚本从对应池子取第一个可用的模型。**一次运行只选一次，执行全程一个会话，中途不换模型。**

| 执行类型 | 池（按顺序） | 思考程度 |
|---|---|---|
| mechanical：改名、补类型、批量改文案、样板代码 | glm-5.3-flash → deepseek-v4.1-flash → haiku-5.5 | high |
| standard（默认） | grok-4.7 → sonnet-5.5 | high |
| hard：疑难 bug、核心逻辑 | gpt-6.1-sol | high |

pi 没有文件系统沙箱，不能承担执行；glm / deepseek 执行时走 grok 或 codex 外壳。

### 4.3 探索

探索（grep、读文件、找调用点）轮次多、思考少，交给便宜模型。P0 实测后改为**单独一次只读调用**，不走外壳内部的 subagent：

| 探索模型 | 思考程度 | 外壳 | 原因 |
|---|---|---|---|
| haiku-5.5 | low | claude，精简启动 | 一次约 8k token、约 $0.001 |
| glm-5.3-flash | low（不要传 off） | pi，`--no-mcp` | 一次约 7k token，CLI 直接给出金额 |

不用外壳内部 subagent 的原因见第 16 节：Claude 的 `--safe-mode` 和「固定子会话模型」不能同时成立；grok 的探索用量拆不开，而且卸不掉 skill 列表。

### 4.4 全部模型的位置

| 模型 | 默认角色 | 兜底角色 |
|---|---|---|
| opus-5.5 | Plan（medium） | gpt 执行时的 reviewer |
| gpt-6.1-sol | Review（xhigh）；hard 执行（high） | Plan 备选 |
| grok-4.7 | standard 执行 | — |
| sonnet-5.5 | 推荐主控 | standard 执行备选 |
| glm-5.3-flash | mechanical 执行 | — |
| deepseek-v4.1-flash | — | mechanical 执行备选 |
| haiku-5.5 | Plan 阶段探索 | mechanical 执行最后备选 |
| grok-4.7-build-fast | 执行阶段探索 | — |

池内顺序是按模型定位给的起点，不是实测结论；用账本数据调整。

### 4.5 主控模型

推荐 **sonnet-5.5 · medium，跑在 Claude Code**。

- 主控只做：对话、分流判断、小活自己做、调 `orch run`、读汇总、汇报。大活的 plan 已交给 opus，主控不需要顶级推理。
- 主控是对话最多、会话最长的，单价会乘以整个会话长度。
- cope 实测：小任务直接用 Sonnet，质量与 Opus 持平，花费约一半。
- 不推荐 haiku / flash 当主控：分流判断错误代价大，小活质量没保证。

## 5. 分流（小活 / 大活）

主会话判断，不输出任何声明。

| 判定 | 起点判据 | 处理 |
|---|---|---|
| 小活 | ≤2 个文件、方案明确、一眼能验证；问答；小范围排查 | 主会话自己做 |
| 大活 | 多文件 / 新功能 / 需要设计取舍 / 需要独立 review | `orch run` |

门槛随主控模型调整（`routing.toml [triage]`）：

- 主控是 sonnet 档：自己做很便宜，门槛高，只有确实大的活才外派；
- 主控是 opus：自己做变贵，门槛放低。

拆分有固定成本（至少执行和 review 各冷启动一次），只有执行足够长时才赚得回来。门槛之后按账本数据调。

## 6. 调用方式：直接调用 CLI 无头模式

- 由 `orch` 脚本直接调用各家 CLI，每个模型跑在自家原生外壳里。执行阶段工具调用最多，受外壳影响最大，必须用原生外壳。
- 不用桥接（pal clink、grok-build 插件等）：桥接本质也是调 CLI，多一层转发开销（grok-delegate 还多一个 Claude 转发 subagent），且有限制（grok-build 思考程度最高 high、续接只有 `--resume-last`）。
- 网关（magpie / dzg）只作为外壳兜底（`models.conf` 中同一模型的后续行）。

各家参数（本机 `--help` 已确认）：

| CLI | 思考程度 | 续接 | 用量输出 |
|---|---|---|---|
| claude | `--effort low/medium/high/xhigh/max` | `-r <id>` / `--session-id` | `--output-format json`（usage、total_cost_usd、session_id） |
| codex | `-c model_reasoning_effort=<level>` | `codex exec resume <id>` | `--json` 的 `turn.completed`（含 cached_input_tokens） |
| grok | `--reasoning-effort none…max` | `-r <id>` / `-s <id>` | `--output-format json`，`grok usage <sid>` |
| pi | `--thinking off…max` 或 `模型:<level>` | `--session-id` | 待实测 |

## 7. 会话与交接

- **每个角色在一次运行中只开一个会话。** 修复续接执行会话，复审续接 review 会话。会话 id 由脚本自动记录到 `sessions.json`，按（运行, 角色, 模型）为键，主会话无需管理。
- **交接靠文件，不靠对话历史：**
  - plan.md：目标、已定事项、步骤、验收命令、执行类型，以及"文件:行号 + 关键结论"形式的上下文，让执行模型不必重新探索；
  - reviewer 拿 plan.md + `git diff` + 验收结果。
- 换模型时内容可以传递，但缓存不能共享（缓存是模型对前缀的计算结果，与模型权重绑定）。所以交接的目标是避免"重新探索"，读入一次的全价成本不可避免。
- **主会话上下文干净：** worker 完整输出只落文件，`orch run` 只返回汇总（约 30 行以内）。
- **worker 精简启动：** 不加载 MCP、skill 列表、全局指令，只保留文件和命令工具。各家开关待 P0 实测（claude `--strict-mcp-config` / `--setting-sources`，codex `-c` 覆盖，grok `--disallowed-tools` / `--rules`，pi 待查）。
- **全局指引不再写进 `CLAUDE.md` 等全局文件**，避免每个 worker 都读一遍；改为仅在主会话中由 skill 触发。

## 8. 不可用时的兜底

三级：

1. 同一模型换外壳：`models.conf` 中该模型的下一行。
2. 换成该角色的备选模型：`routing.toml` 的 `fallback` 或执行池中的下一个。
3. 都不可用：主会话自己做这一步，并在汇总中标注原因；同家族自审标"独立性不足"。

时机：

- **开跑前预检**：只查不花 token 的项（`which`、各 CLI 登录状态）。按结果定阵容，汇总开头一行亮出替换情况，不停下等确认。
- **运行中出错**：
  - 限流、网络、5xx：等待后原样重试 1 次；
  - 登录失效、模型 ID 不存在、额度用完：直接按三级兜底换下一个。
- **中途换人**：已改文件保留在工作区；新模型开新会话，拿 plan.md + 当前 `git diff` + 完成进度，从断点继续，不从头重做。
- **思考程度不支持**：取该模型支持的最接近一档，记入账本。

所有替换写进汇总：哪一步、原定模型、实际模型、原因。

## 9. 记账

- 每次调用一行 `usage.jsonl`：阶段、模型、外壳、思考程度、会话 id、新输入、缓存读、缓存写、输出、思考 token（若 CLI 单独报告）、美元、耗时。探索子会话的用量如能拆分则单独记。
- 数据来源为各 CLI 自报的用量 JSON；价格在 `models.conf` 新增价格列，按用户网关实际价格填写。
- 汇总给出各阶段花费，以及"全程用 opus 约多少"的粗略对照（明确标注为估算）。
- 历史账本用于调整：执行池顺序、思考程度、分流门槛。

## 10. 汇总格式

```
结论：完成 / 卡在 xxx
阵容：plan opus-5.5 · 执行 grok-4.7 · review gpt-6.1-sol（替换：无）
改动：<文件清单>
验收：<命令> 通过（脚本复核）
Review：P1 2 条已修，P2 1 条未修（列出）
账单：plan $x · 执行 $y · review $z · 合计 $t（全程用 opus 约 $u，估算）
```

## 11. 配置

### 11.1 `models.conf`（新增价格列）

```
# <别名>  <provider>  <模型参数>  <输入$/M>  <输出$/M>  <缓存读$/M>  <缓存写$/M>
opus-5.5   claude  claude-opus-5-5   5  25  0.5  6.25   # 示例数字，按网关实际价格填
```

同一别名多行：第一行是默认外壳，其余是兜底。价格列可留空（只记 token 不算钱）。

### 11.2 `routing.toml`（取代 `routing.md`）

```toml
[triage]
# 主控模型档 → 外派门槛（起点值，按账本调整）
sonnet = "high"
opus = "low"

[roles.plan]
model = "opus-5.5"
effort = "medium"
explore = { model = "haiku-5.5", effort = "low" }
fallback = ["gpt-6.1-sol"]

[roles.exec]
effort = "high"
explore = { model = "grok-4.7-build-fast", effort = "low" }
default_pool = "standard"
pool.mechanical = ["glm-5.3-flash", "deepseek-v4.1-flash", "haiku-5.5"]
pool.standard = ["grok-4.7", "sonnet-5.5"]
pool.hard = ["gpt-6.1-sol"]

[roles.review]
model = "gpt-6.1-sol"
effort = "xhigh"
fallback = ["opus-5.5"]   # executor 是 gpt 时也用它（effort 取 medium）
max_rounds = 2
```

## 12. 文件结构

```
skills/orchestrate/
  SKILL.md
  scripts/
    providers/             # 命令行、用量解析、思考程度、假 provider
      args.ts effort.ts parse.ts run.ts fake.ts types.ts
      fixtures/ providers.test.ts
    orch.ts                # preflight | run | continue
    config.sh              # where | detect | init | check | preflight
    flow.ts prompts.ts
  references/
    models.sample.conf     # 含示例价格列
    routing.example.toml
```

已删除：`dispatch.sh`、`run.sh`、`routing.example.md`，以及 SKILL.md 中的 7 步手工流程、T0 强制外派规则、"必须先亮一行声明"的要求、全局指引安装（`config.sh instructions`）。

运行记录：`.git/orchestrate/<run>/`（git 和测试看不到），包含 plan.md、各阶段输出、sessions.json、usage.jsonl。

## 13. 安全红线（保留并收紧）

- 不对任何 CLI 加 bypass / yolo / always-approve 类参数；执行写权限仅限工作目录，续接时同样生效。
- 只读角色（plan、review）禁止可写 subagent。grok 的 subagent 不受父会话 plan 模式约束，只读角色会加 `--no-subagents`。
- pi 不承担执行。
- 提示词、汇总、运行记录中不带密钥、token、`.env` 内容。
- worker 提示词带子代理守卫：不得加载 orchestrate、不得再派发。
- 子模型输出是待核验材料：验收结果以脚本复核为准，review finding 由主会话抽查后再采信。

## 14. 实现顺序

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| P0 实测 | 各 CLI 精简启动开关；用量 JSON 格式（含 pi）；续接时改思考程度是否使缓存失效；flash 类模型是否支持思考参数；Claude Explore subagent 能否固定 haiku；grok explore 子会话用量能否拆分 | **已完成。** 结论在第 16 节，代码在 `scripts/providers/`，`bun test` 14 项通过 |
| P1 主流程 | `orch run` 串起预检 → plan → 执行 → review → 修复 → 复核；会话自动续接；三级兜底 | **已完成。** `/tmp/orch-p1-demo` 端到端通过，每个角色一个会话。见第 16.8 节 |
| P2 记账与收尾 | usage.jsonl、汇总报表与 opus 对照；SKILL.md 精简改写；删除旧脚本 | **已完成。** 汇总含「全程用 opus 约 $u，估算」。旧入口已删除 |

## 15. 已做出的取舍（实现者的判断，可由用户推翻）

- 执行池顺序、探索助手的思考程度（low）、分流门槛均为起点值，以账本数据为准调整。
- 脚本用 bun + TypeScript（解析四家 JSON 用量、状态管理比 bash 稳）；`config.sh` 暂保留 bash。
- 运行记录放 `.git/orchestrate/` 而非 `~/.cache`，便于按仓库查看且对 git、测试不可见。
- 主控默认推荐 sonnet-5.5，但不强制；主控是什么模型由用户打开的会话决定。
- 探索改为单独的只读调用，不用外壳内部 subagent。这是 P0 实测后的改动，见第 16 节。

## 16. P0 实测结论（2026-10-25）

探针是一句 `Reply with exactly: pong`，工作目录 `/tmp/orch-p0`。版本：claude 2.1.310、grok 1.0.70、codex-cli 0.42.0、pi 以本机为准。适配器按这些结论生成命令、解析用量。

### 16.1 精简启动

| CLI | 能用的开关 | 实测结果 |
|---|---|---|
| claude | `--safe-mode --strict-mcp-config --disable-slash-commands --no-chrome --tools Read,Grep,Glob --permission-mode plan --permission-prompts none` | init 里 tools 只有这三个，mcp `[]`，skills `[]`。冷启动约 6.3k token（其中约一半命中 1 小时缓存）。不要用 `--bare`，它不读 OAuth |
| grok | `--no-subagents --disallowed-tools Agent --disable-web-search --tools read_file,grep,list_dir --system-prompt-override` | 没有卸掉 skill 和 MCP 的开关。不收窄约 25k token、6 个 MCP、一百多个 skill；收窄后仍约 17.5k。只读角色必须加 `--no-subagents` |
| pi | `--no-mcp --tools read --mode json` | 冷启动约 7k token，不写会话文件。金额由 CLI 给出 |
| codex | `-s read-only -c approval_policy="never"` | 沙箱和审批参数能被接受。用户配置里的 MCP 仍会启动。`--ephemeral` 在 0.42.0 已不存在 |

### 16.2 用量 JSON

| CLI | 怎么读 | 字段 |
|---|---|---|
| claude | `--output-format json` 的 `result` | `usage` 是这一轮父会话；`modelUsage` 按模型拆开，**续接时是整个会话的累计值**。有 `total_cost_usd` 和 `thinkingTokens` |
| grok | `--output-format json` | `usage` 含 `reasoning_tokens`、缓存读写。`modelUsage.*.costUSD` 为 0 或缺失时不当成免费，适配器记 `null` |
| pi | `--mode json` 的最后一条 `message_end` | `usage.input/output/cacheRead/cacheWrite/reasoning` 和 `usage.cost.total` |
| codex | 本机这次没有成功的调用 | 会话记录里的形状是 `token_count.last_token_usage`：`input_tokens`、`cached_input_tokens`、`cache_write_input_tokens`、`reasoning_output_tokens`。当前 `--json` 把事件包在 `msg` 里。解析器两种都认，成功路径留到 P1 再对一次 |

传给 claude 的模型必须是完整 id。`--model haiku` 的 init 显示 `claude-haiku-5-5`，实际按 `claude-sonnet-5-5` 计费（同一次约 $0.013，而完整 id 的 haiku 约 $0.001）。

### 16.3 续接时改思考程度

| CLI | 做法 | 缓存 |
|---|---|---|
| claude | 同一 session，effort 从 low 改到 high | 没有整段失效。这一轮 cache read 4398、cache write 2820（1 小时档）。high 产生了 107 个思考 token |
| grok | 同一 session，glm 从 low 改到 high | 没有失效。新输入 287，cache read 18432，cache write 0 |
| pi | 同一 `--session-id`，`--thinking high` | 前缀命中缓存（cache read 7040），reasoning 9 |
| codex | 未测 | 登录态跑不起模型，见 16.5 |

### 16.4 flash 模型的思考参数

非法档位在 grok 上会于请求发出前被拒绝，报错里带该模型允许的列表：

| 模型 | 外壳 | 允许的档位 |
|---|---|---|
| grok-4.7 | grok | low、medium、high、xhigh |
| glm-5.3-flash、deepseek-v4.1-flash | grok | low、high、max |
| glm-5.3-flash | pi | CLI 接受 off 到 max。实测 off 被改写成 low；high 产生了 reasoning token。非法值只警告，不失败，所以适配器先校验 |
| deepseek-v4.1-flash | pi | `--thinking high` 被接受。这次 pong 的 reasoning 是 0，金额 CLI 报了 0 |

claude 的 `--effort low` 不等于不思考：haiku-5.5 在 low 下仍有 295 个思考 token。

适配器在请求前把档位改到最近的一档，距离相同取更高的一档。所以 glm 上的 medium 变成 high，xhigh 变成 max；grok-4.7 上的 max 变成 xhigh。

### 16.5 探索子会话

- **Claude 内置 Explore 固定不到 haiku。** `--safe-mode` 会忽略 `--agents`。去掉 `--safe-mode` 后，自定义的 `scout`（`model: claude-haiku-5-5`）确实跑在 haiku 上，`modelUsage` 也能按模型拆开；但上下文从约 6k 涨到约 68k（这次父会话 $0.085，子会话 $0.003）。不划算。
- **grok 的 explore 用量拆不开。** `--agents` 里写了 glm，`modelUsage` 仍只有 `grok-4.7-build-fast` 一个键（`modelCalls: 4`）。加上卸不掉 skill 列表，不拿它做探索。
- **结论：** 探索是一次单独的只读调用，用 claude 上的 haiku（精简启动）或 pi 上的 glm。不在 plan / 执行会话里面再开子会话。

### 16.6 codex 登录态

本机 `codex` 用 ChatGPT 登录。`codex exec` 拒绝了配置里的 `gpt-6-astra`，也拒绝了模型缓存里的 `gpt-6-luna`，错误都是 `model_not_found`（ChatGPT 账号不支持该模型）。账号模型列表里没有 `gpt-6.1-sol`。

因此 review 的 `gpt-6.1-sol` 不走当前这个 codex 登录。P1 实测里，pi 和 grok 上的 `magpie/copilot/gpt-6.1-sol` 都回 `400 Copilot: The requested model is not supported.`（pi 进程退出码仍是 0）。review 按兜底落到 opus-5.5。codex 适配器先留着，等有能用的模型再对一次用量。

### 16.7 代码

`skills/orchestrate/scripts/providers/`：四家的命令行、用量解析、思考程度折算、假 provider。测试：

```bash
~/.bun/bin/bun test skills/orchestrate/scripts/providers/providers.test.ts
```

适配器测试在 `providers.test.ts`。流程和账单测试在 `flow.test.ts`。

### 16.8 P1 端到端（2026-10-25）

仓库是 `/tmp/orch-p1-demo`，任务是给 `src/math.js` 补 `mul`。没有改本 skill 仓库，也没有 commit。

- 预检：claude、grok、pi 已登录。codex 的登录信息在 stderr，预检改为同时看 stderr 后是已登录。示例配置里没有 codex 行。
- opus 把这次判成 mechanical。执行模型是 grok 上的 glm-5.3-flash，一个会话写完 `mul`。
- review 先试 pi 上的 gpt-6.1-sol（约 1 秒，400），再试 grok 上的同一个 id（约 13 秒，同样 400），然后落到 claude 上的 opus-5.5 · medium。成功的 review 会话只有这一个。
- 脚本自己跑了 `node --test test/math.test.js`，2 项通过。review 的 P1、P2 都是「无」。
- 这一次能看到的金额：explore $0.0019，plan $0.0559，review $0.0547，合计 $0.1124。grok 执行没有回金额。
- `pi` 的 API 错误退出码是 0，解析器现在会把 `stopReason: error` 抛出去，流程才能换下一个外壳。
- SKILL.md 调用 `orch.ts run`。`dispatch.sh`、`run.sh`、`routing.example.md` 和 `config.sh instructions` 已删除。opus 的示例价格写在 `models.sample.conf`，汇总用它估算「全程用 opus」。
