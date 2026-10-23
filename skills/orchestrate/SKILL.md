---
name: orchestrate
description: 多模型调度编排。把任务拆成 plan / 执行 / review 三段，按用户配置的路由偏好选模型，并通过 claude、codex、grok、pi 四个 Provider 的无头调用把子任务派给不同模型。当用户输入 /orchestrate、说"调度/编排多个模型"、"让 X 模型来 plan/做/review"、"用不同模型分工完成这个任务"、"多模型协作/并行执行"时触发。
---

# Orchestrate · 多模型调度

主控（用户当前打开的 Provider）只负责**分级 → 路由 → 派发 → 核验 → 汇报**。能自己做的小活不调度。

- 用户配置（**每个人的环境不同，不随 skill 分发**）位置用 `config.sh where` 查看，默认 `~/.config/orchestrate/`：
  - `models.conf`：模型别名 × Provider → 模型参数（机器读取）
  - `routing.md`：分级、plan/exec/review 选型偏好、外壳选择规则（你读，用户可编辑）
- 脚本在 `${CLAUDE_SKILL_DIR}/scripts/`：`config.sh`（初始化/探测/校验）、`dispatch.sh`（派发）。路径中的 skill 目录由 Claude Code 加载时自动填入（占位符名为 CLAUDE_SKILL_DIR）；Codex 等不填入、路径里仍是该占位符的环境，取本 SKILL.md 所在目录。下文裸写的 `config.sh` / `dispatch.sh` 都指这两个脚本，**实际执行时必须写完整路径**（不同安装方式下 skill 所在位置不同，不要假设固定路径）。
- 与 `john:spec` 的关系：spec 管"需求→工程产物"的流程，orchestrate 只管"模型怎么分工"。spec 的 N5/N6 需要选模型或外壳时可调用本 skill；本 skill 不产出 spec 文档。

## 流程

### Step 0 · 读配置，分级并亮出调度计划

先读 `models.conf` 与 `routing.md`。**任一不存在 → 先走下面「初始化与配置」，不要硬编码模型继续**。同时读 `routing.md §0` 的「调度确认」模式（缺失或写法不明时按"先确认"）。

按 `routing.md §1` 判 T0 / T1 / T2 / TR。

- **T0**：直接自己做，不走后续步骤。
- **TR（纯审阅）**：不改文件、只做大范围评审，走下面「纯审阅流程」，跳过 Step 1、3、4、6。
- **T1 / T2**：开跑前先亮出调度计划，亮出后直接推进 plan，不在这里停（派发前是否停下确认，由「调度确认」决定，见 Step 2）；用户中途改口就按新要求重排。固定格式：

  ```
  这是一个【<任务类型>】类任务，判定 T<n>：<依据：规模 / 风险 / 是否可逆>。
  调度计划：
  1. plan：<模型>（<外壳>）            # 主控自己 plan 时写"主控自己"
  2. 执行：待 plan 拆分后确定，预计 <模型>（<外壳>）
  3. review：待定，预计 <模型>，原因：<如 reviewer 不能与 executor 同模型>
  ```

  exec 和 review 要等 plan 交付任务清单才定得下来，所以这里写"预计"；最终分工在 Step 2 之后、派发前再亮一次。

  计划里涉及删除数据、部署、改生产配置等不可逆动作时，该动作单独按全局规则确认，不因调度计划整体授权而放行。

### Step 1 · Plan

- 按 `routing.md §2` 选 planner。主控模型已满足条件时自己 plan，不另派。
- 派发（只读）：
  ```bash
  "${CLAUDE_SKILL_DIR}/scripts/dispatch.sh" -p <外壳> -m <模型别名> -r plan -C <项目目录> -f <提示词文件>
  ```
- 子模型**看不到当前对话**，提示词必须自包含：目标、背景、约束、相关文件路径、期望输出格式。
- planner 必须交付**可直接派发的任务清单**，每项含：
  1. 目标（一句话）
  2. 允许修改的文件/目录范围
  3. 依赖哪些任务
  4. 验收命令（可运行、有明确通过标准）
  5. 任务特征（对应 `routing.md §3` 的哪一类）

### Step 2 · 校验 plan（主控）

主控读完 plan 再放行：文件范围有无重叠、验收命令是否真能跑、依赖是否成环。不合格就让 planner 改，**不自己悄悄改 plan 后假装是 planner 的**。

校验通过后、**派发前必须再亮一次最终分工**：

```
plan 已完成，拆成 <N> 个任务，最终分工：
| 任务 | 模型 | 外壳 | 并行 | 理由 |
|---|---|---|---|---|
```

然后按「调度确认」处理：
- **先确认**：用 AskUserQuestion 停下，选项为"按此分工执行"、"修改模型"、"取消调度，主控自己做"；用户选定后再派发。
- **自动**：亮出后直接派发，不等确认。

后续因验收失败等原因要换模型（如 Step 6 升一档），换之前同样先说明换成谁、为什么。

### Step 3 · Execute

按 `routing.md §3` 给每个任务选 executor，按依赖拓扑派发。

**何时开多个 executor（subagent）**
- 开：任务相互独立、文件范围不相交、可并行，或需要大范围检索不想污染主上下文。
- 不开：强依赖的串行步骤、改动小、需要主控全程掌握上下文。

**写冲突规则**
- 并行 executor 要么**文件范围严格不相交**，要么**各自一个 git worktree**（`git worktree add`），由主控合并。两者都做不到就串行。
- executor **不 commit、不 push、不装依赖**，除非任务明确写了。

**外壳**按 `routing.md §5`：默认外壳 = 主控时用主控原生 subagent；否则用 dispatch：
```bash
"${CLAUDE_SKILL_DIR}/scripts/dispatch.sh" -p <外壳> -m <模型别名> -r exec -C <工作目录> -f <提示词文件>
```
多个独立任务在同一条消息里并行发起（后台运行，等通知），不要轮询。

**executor 提示词必含**：目标、可改文件范围、**禁止事项**（范围外文件、commit/push）、验收命令、汇报格式（改了哪些文件 / 跑了什么命令及结果 / 未完成项）。

### Step 4 · 核验（主控亲自跑）

executor 说"通过"不算通过。主控自己运行验收命令并看 `git diff`，确认：改动在范围内、没有无关改动、命令真的通过。**成功不跨层外推**：某个 executor 的子任务通过，只证明它那一层，集成后要再跑整体检查。

### Step 5 · Review

- 按 `routing.md §4` 选 reviewer：**不得与该 diff 的 executor 同模型，尽量跨家族**；T2 双审。
- 派发（只读），提示词给出：需求/plan 摘要、`git diff` 范围、验收结果、输出要求（按 P1/P2 分级，附文件路径+行号，只报真问题）。
  ```bash
  "${CLAUDE_SKILL_DIR}/scripts/dispatch.sh" -p <外壳> -m <模型别名> -r review -C <项目目录> -f <提示词文件>
  ```
- 主控对 finding **逐条核对再采信**，不原样转发。

### Step 6 · 修复回路

- P1 → 回给原 executor（或升一档模型）修，修完回到 Step 4。最多 2 轮。
- 2 轮仍不过 → 停下，向用户汇报卡点与已尝试的做法，不继续烧模型。
- P2 → 列入汇报，不阻塞。

### Step 7 · 汇报

中文，先说结论。包含：
- 实际用了哪些模型/外壳做了什么（对照 Step 0 计划，偏离的说明原因）
- 改了什么（文件路径）
- 验证结果（命令 + 通过/失败）
- review 结论（P1/P2 数量，已修/未修）
- 未完成事项与未验证部分

## 纯审阅流程（TR）

适用于对文档、需求、方案或代码做评审、不改任何文件的任务。

1. **亮出计划**（固定格式，不等确认地推进到分工表）：
   ```
   这是一个【审阅】类任务，判定 TR：<依据：范围 / 是否影响后续决策>。
   调度计划：不拆 plan 和执行，派 <模型A>、<模型B> 各自独立审阅，主控合并。
   ```
2. **亮出分工表**，按「调度确认」处理（先确认则用 AskUserQuestion 停下）。表中写明每个审阅模型、外壳、审阅范围。
3. **并行派发**（只读），按 `routing.md §4` 的 TR 规则选 2 个不同家族的模型：
   ```bash
   "${CLAUDE_SKILL_DIR}/scripts/dispatch.sh" -p <外壳> -m <模型别名> -r review -C <项目目录> -f <提示词文件>
   ```
   提示词必须自包含：要审的文件路径清单、用户的审阅问题、关注点、输出要求。两个 reviewer 的提示词保持一致，不互相透露对方的结论，以保持独立。
4. **主控合并**：
   - 先自己抽查关键 finding 对应的文件和行号，**逐条核对再采信**，不原样转发。
   - 两边都提到的问题标为"双方一致"；只有一方提到的，核对后注明来源；互相矛盾的，列出分歧并给出自己的判断依据。
5. **汇报**：先说结论（方向是否需要调整），再按 P1 / P2 列问题，附文件路径+行号和来源模型，最后写未核对的部分。**不自动修改任何文件**；用户要求落实时，改动另按 T0/T1/T2 分级。

## 初始化与配置

触发：Step 0 发现配置缺失；或用户说 `/orchestrate init`、"配置/调整 orchestrate"、"加一个模型"、"换掉 X 模型"、"检查调度配置"。

### 首次初始化

1. `config.sh init`：创建配置目录；`models.conf` 由本机探测结果生成骨架（**候选行全部注释，需启用**），`routing.md` 复制示例。**已存在的文件不覆盖**。
2. `config.sh detect`：列出本机已安装的 Provider 和各自可用的模型 ID（只读）。claude 没有列表命令，其 ID 向用户确认。
3. 把要用的候选行复制到 `models.conf` 的「已启用」区（**行序即优先级：同一别名的第一行是默认外壳**，别在候选区就地取消注释；候选行即 detect 的真实 ID；`references/models.sample.conf` 是作者环境的样本，仅供参考写法，**不要照抄其中的 ID**），**所有模型 ID 必须来自 detect 输出或用户明确给出，不得猜**：
   - 用户用到哪些 Provider、想用哪些模型（用 AskUserQuestion 逐项确认，别替用户决定）。
   - 每个别名按"默认外壳放第一行、兜底放后面"写行。别名自己起，要和 `routing.md` 一致。
4. 按用户的模型清单改写 `routing.md` 的选型偏好（示例是作者的偏好，只当起点）。只有一个 Provider/模型时如实简化，别硬凑多模型。
5. `config.sh check --probe`：逐行实测。**这会消耗少量 token，先告知用户再跑**。FAIL 的行要么修 ID、要么删掉，不留没验证过的行。
6. **全局指引**（可选，需用户同意）：让各 Provider "动手前先判断是否调度"，不必每次带触发词。
   - `config.sh instructions status` 看各已安装 Provider 的现状（claude / codex / pi；grok 直接读 `~/.claude/CLAUDE.md`，随 claude 覆盖）。
   - `config.sh instructions install --dry-run` 把**将写入的变更逐个展示给用户**，再用 AskUserQuestion 征得同意；同意后去掉 `--dry-run` 执行。只改文件里 `orchestrate:begin/end` 标记块，写入前备份到 `$(config.sh where)/backups/`。
   - pi 默认看不到 skill，`install` 会建软链 `~/.pi/agent/skills/orchestrate`；codex 没装插件时才建 `~/.agents/skills/orchestrate`（装了插件就不建，避免重复加载；旧版本留下的共用软链会被迁移掉）。
   - 用户拒绝就跳过，之后随时可补；想撤销用 `instructions remove`。
7. 汇报：配置目录位置、可用组合表、全局指引写入情况、WARN/FAIL 及处理结果。

### 后续调整

- 用户直接编辑 `models.conf` / `routing.md` 即可；或用自然语言让你改（"把 X 加进批量档"、"review 不要用 Y"），你改完跑 `config.sh check` 复核；新增或改动了模型行，再对这些行 `--probe`。
- 改动前先读现有文件，只改被要求的部分，保留用户已有的其他修改。
- 配置目录可用环境变量 `ORCHESTRATE_HOME` 指定（例如按项目隔离一套配置）。
- 配置文件里不放 API key、token 等敏感信息（认证由各 Provider 自己管理）。
- 插件升级后建议跑一次 `config.sh instructions status`：指引内容过期或 codex/pi 的软链指向旧版本时，`install` 会更新（幂等）。

## 红线

- 不对 `dispatch.sh` 加 bypass / yolo / always-approve 类参数；exec 权限仅限工作目录。
- 提示词和汇报中不带密钥、token、`.env` 内容。
- 子模型的输出是**待核验的材料**，不是结论。
- 为 T0 任务起多模型调度是浪费，不要做。
