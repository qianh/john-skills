---
name: spec
version: 1.1.0
description: 动态 Spec 编排器：按四维给需求打分，用矩阵动态编排本次该跑哪些节点(琐碎3/典型6/高风险9+)，围绕一份 spec.md 推进、两道闸人控。当用户 /spec、说"写个 spec/规格驱动"、"帮我规划这个功能/需求/改动"，或要把需求做成可验收工程产物时触发。
---

# Spec · 动态 Spec 编排器

## 核心理念（先读这段）

这不是一条写死的流水线，**也不是让你自己理解需求然后直接动手**。它是一个**纯调度器**：读需求 → 跨服务范围发现 → 四维评分 → 矩阵当场编排出节点集 + 每节点风味 → **把每个环节委派给登记表里的真实框架/工具/子代理执行** → 全程围绕**一份活的 `spec.md`** 推进。

五条不可违背的原则：
1. **节点动态**：节点数随项目伸缩（3↔9+），由矩阵从四维推出，绝不写死。
2. **单一事实源**：`spec.md` 是中枢，所有节点往里追加/精炼自己负责的章节；没跑的章节标 `N/A`。
3. **两道闸人控**：编排闸（开跑前）+ 关键节点闸（规格定稿/审查/合并前）。引擎评分可能误判，关键处必须停。
4. **无内嵌节点方法**：不得使用框架内置节点方法兜底。推荐依赖缺失时必须提示安装或调整编排，不能悄悄降级。
5. **跨执行器**：本文（逻辑）执行器无关；命令名、安装名、subagent 支持差异全在 `registry.yaml`（数据）。

---

## ⛔ 编排器铁律（零例外 — 违反任意一条即视为执行失败）

> 本节把上面 5 条原则从"建议"升级为"硬契约"。这是 markdown 能给出的最强约束（注：纯 skill 非 hook，不能在系统层物理阻断；作为执行者，你有义务逐条遵守，不得自我合理化跳过）。

1. **编排器自己不执行任何领域工作。** 需求澄清、领域建模、规格编写、任务拆解、实现、审查、归档——**每一项都必须由被绑定的真实框架（Skill 工具调用 / 外部 tool / 子代理 Task）产生**。当前 agent 不得"自己理解后直接写"，不得用一段像框架产物的文本冒充框架执行。编排器只负责：识别 → Scope 发现 → 评分 → 编排 → 依赖体检 → 开闸 → 调度 → 校验出口门 → 写 spec.md 状态。
2. **`/spec` 的第一步只做编排，不做实现。** 在 Gate 1 用户确认前，**禁止**进入任何实现、写计划、答疑、改代码。第一回合的唯一合法产出是【编排报告 + Gate 1】。若你发现自己正要直接写 plan 或直接动手——**停**，你违反了本条。
3. **Step 3 必须输出完整【编排报告】模板**（见 Step 3），缺任一字段不得开闸：四维评分 / 跨仓 Scope 结果 / 节点清单 / 每节点框架绑定 / 执行模式 / 缺失依赖。
4. **Gate 1 是硬 STOP。** 必须用 AskUserQuestion 停下等用户确认，**绝不连跑过去**。Gate 2（N3 定稿 / N6 审查 / 合并前）同理。
5. **每个节点开始前必须打印声明行**（否则不得执行该节点）：
   `▶ {节点} | 框架: {registry 绑定名} | 模式: {current-agent | subagent} | 状态: {bound | blocked:install_required}`
   让用户肉眼看到"现在是谁在执行"。
6. **需求不清 = 硬闸。** N1 出口门是「真实意图被逼出」。只要还有不理解的概念、模糊的边界、未确认的取舍，就**必须**继续 grill 框架的一问一答（grill-me / grill-with-docs），**不得**带着疑问进入 N3（规格）或 N5（实现）。不懂就问，禁止"根据项目内容自行理解"。
7. **支持 subagent 的节点必须让用户选执行模式。** 尤其 N5（实现）、N6（审查）、NS（范围发现）、N2/N4 等：进入前必须 AskUserQuestion 问 `subagent | 当前 agent`。当前环境无 subagent 能力时，亮明原因并让用户选「当前 agent 继续 / 暂停 / 安装或启用」。不得默认替用户决定。
8. **缺框架必须引导安装，禁止静默自做或绕过。** 被绑框架/工具/agent（grill-me、openspec、taskmaster、tdd-guard、superpowers、Explore 等）探测不可用时，进入 `blocked: install_required`，**必须主动引导安装为首选解法**：从 `references/install.md` 取该框架的【已核实安装命令 + 来源 + 卸载方式 + 前置条件】完整呈现给用户，并用 AskUserQuestion 给「①安装并继续（推荐）｜②改编排去掉该节点/改选已装风味｜③暂停」；用户选①即视为授权，立即按 `references/install.md` 核实 → 安装 → 验证 → 回 Step 3 重新体检。**绝不**因为"框架没装"就退化成当前 agent 自己实现，**也不得**在未先引导安装的情况下默默改编排跳过该框架。

---

## 变体触发

| 变体 | 触发方式 | 行为差异 |
|---|---|---|
| 标准模式 | `/spec` 或描述功能需求 | 走完整执行流程 |
| **branch 模式** | `/spec branch` | 仅针对当前分支 diff；按 matrix.md §0 覆写规则缩减流程 |

**branch 模式执行差异（详见 matrix.md §0）：**
- NS 替换为：`git diff main --name-only` + 涉及文件快速读（不做 Recon，不派 Explore agent）
- 四维评分规模上限锁定 M；N8 必选并标注 introduced/pre-existing
- **跳过 N4/N5**（diff 已存在，不做任务拆解与实现）；流程为 NS(diff) → N1 → [N3 记录改动] → N6 审查 → N7 验证 → N8
- 适用场景：PR review 前快速生成改动范围的 spec

---

## 执行流程

### Step 0 · 定位与初始化（编排器自身，唯一允许的非委派步骤）
- 解析用户需求文本。
- 确定 `spec.md` 落点：默认 `docs/spec/<feature-slug>/spec.md`（老项目沿用既有 docs 结构；无则建）。
- **续跑（resume）**：若目标 `spec.md` 已存在，读 front-matter `status`（drafting→spec-locked→implementing→reviewing→done）与各章节 `N/A`/勾选标记，定位下一个未完成节点继续，**不从头重跑**；编排闸亮出"已完成/待续"状态供用户确认。
- **漂移检测（续跑时）**：读 front-matter 的 `spec_commit` 字段（N3 定稿时写入的 commit hash）。若字段非空，运行 `git log --oneline {spec_commit}..HEAD -- <spec 覆盖的文件路径列表>`；若有改动，用 AskUserQuestion 提示：「spec 锁定后代码已有 N 次变更，涉及 [文件列表]，spec 可能已漂移。① 先 review 再继续（推荐）② 直接续跑（忽略漂移）」。N3 定稿时在 spec.md front-matter 写入 `spec_commit: $(git rev-parse --short HEAD)`。
- 读 `spec-template.md` 作为骨架。
- **目标锚定（Goal Condition）**：将用户需求提炼为一条 `goal_condition` 字符串，格式：
  `「当 [可验证命令退出码/输出] 为真时，本次工作完成」`
  示例：`「pytest auth/ 输出 N passed 0 failed 且 ruff check 输出为空」`
  写入规则：新建 spec 时写入 `goal_condition`，并初始化 `goal_condition_waived: false` 与 `goal_condition_waiver_reason: ""`；续跑已有 spec 时保留已有 front-matter（尤其 `goal_condition` / `goal_condition_waived` / `goal_condition_waiver_reason`），仅在字段缺失时补默认值，除非用户明确要求改写。
  - 这是 N1 拷问的参照真北：所有拷问围绕「让这个条件成立需要做什么」展开。**N1 完成后，若拷问揭露的真实意图与初值不同，必须在进入 N3 或 N5 前更新 goal_condition。**
  - 这是 N7 最终验收准则：N7 必须验证 goal_condition 成立。
  - 这是 N5 /goal 的兜底条件来源：若本轮运行了 N4，/goal 条件必须改从 N4 Done 标准提炼；若未运行 N4，才使用 N1 同步后的 goal_condition。
  - ⚠️ 条件必须 **transcript-verifiable**：写成「跑某命令 → 看某输出」而非语义判断（不可写「实现符合设计原则」此类条件）。该约束主要服务 N5 的 `/goal` 评估器（Haiku 只读 transcript、不能独立调工具，故命令须在 N5 执行中打印）；N7 最终验收可直接运行该命令、不依赖 transcript。
  - 若无法提炼非空、可验证的 goal_condition：Gate 1 须在「🏁 目标条件」状态位标出当前状态——N1 仍在待跑节点集时标 `pending:N1_anchor`（留待 N1 出口门锚定/补填，见 Step 4 N1 出口门补充），可照常开闸；N1 不在待跑节点集（如续跑时 N1 已过）时标 `blocked:goal_condition_required`，须在 Gate 1 AskUserQuestion 让用户补填或豁免后才开闸。只有用户明确选择放弃最终目标锚定时，才设 `goal_condition_waived: true` 并记录原因（状态标 `waived`）。

### NS · 跨服务/跨仓范围发现（老项目强制）

NS 拆为两个子步，顺序执行；greenfield 项目 NS-B 标 N/A，NS-A 仍执行。

#### NS-A · 意图侦察（Recon）——advisor 自读，不派子代理

- **目的**：在跨服务发现前，先读懂项目的意图与约束，防止 N1 拷问时问出已由 ADR 决定的废问题。
- **谁执行**：当前 agent（advisor）直接读，无需派子代理。
- **必读清单**：`README`、`CLAUDE.md`/`AGENTS.md`、`CONTEXT.md`、`DESIGN.md`、`PRODUCT.md`、`ADR/` 目录、`git log --oneline -30`（判断活跃演进方向）、根 config 文件（识别 build/test/lint 命令）。
- **产出**：写入 `spec.md` 的「项目意图与约束」章节（已决策 ADR / 活跃演进方向 / 不可违背约束 / 读取的意图文档清单）。
- **出口**：意图文档已读完，约束已写入 spec.md。

#### NS-B · 跨服务范围发现（Scope）——派子代理执行

- **目的**：当前路径可能只是某功能的一部分。必须先界定这个功能**真正触及的全部服务/仓**，否则后续 spec 只覆盖半边。
- **谁执行**：**不是编排器自己临时扫一下了事**。按 `registry.yaml` 的 `NS_scope_discovery.sub_steps.NS_B_scope` 绑定执行：CC 绑 `Explore`（agent kind → **必为子代理派发**，current-agent 选项在此无意义）；Codex 绑 `codebase-analyzer`（skill kind → 默认子代理，但用户可在 Gate 1 选当前 agent 直接调该 skill）。无论哪种都去发现：
  - 当前项目类型（前端 / 后端 / 服务 / 库）；
  - 关联的另一端（前端↔后端）、相关微服务、第三方/内部 API、配置文件里的服务地址、数据库、消息/GraphQL/Apollo 端点、回调与 webhook 链路；
  - 父目录 / 兄弟仓 / monorepo 包中相关代码。
- **产出**：写进 `spec.md` 的「涉及服务 / 跨仓范围」章节：列出每个涉及的服务/仓 + 它在本功能里的角色 + 改动面。
- **出口门**：跨栈范围已界定，并在 Gate 1 经用户确认完整（用户可补充遗漏的服务）。greenfield 无既有服务时标 `N/A`。

### Step 1 · 四维评分（委派 + 编排器汇总）
- 按 `matrix.md` 的 rubric，从需求文本 + NS 发现结果推断四维初值：**规模 / 风险 / 新老项目 / 领域清晰度**。
- 这些是**初值**，Step 3 的编排闸会亮给用户校准——不要假定它们一定对。

### Step 2 · 矩阵编排
- 按 `matrix.md` 的矩阵规则，从四维分数推出本次的 **{节点集 + 每节点风味}**。
- always-on 核心：`N1(轻拷问) → N5 → N7`；老项目额外 always-on `NS`；其余按升级规则叠加。

### Step 3 · 依赖体检 + 编排闸（Gate 1 · 硬 STOP）
- 读 `registry.yaml`。识别当前执行器：环境变量 `CLAUDECODE` 在 → claude-code；否则按 codex。**即便认错，下面"探在不在"也会兜底。**
- 对编排出的每个节点，从 `registry.yaml` 取"当前环境"的推荐 `skill`/`tool`/`agent` 候选，**逐一探在不在**（✅可用 / ❌缺失）。第一个可用候选进入依赖绑定清单。
- **探"在不在"必须覆盖两个来源（禁止只查其中一个）**：
  1. session start 注入的 system-reminder `available skills` 列表（runtime 已聚合，首选）；
  2. 若需手动确认，按执行器分别检查：
     - **Claude Code**：`~/.claude/plugins/`（plugin 安装，如 `john:*`）**和** `~/.claude/skills/`（直装，如 `grill-with-docs`）；
     - **Codex**：`~/.agents/skills/`（**Codex 规范的全局 skill 根**，直装 skill 如 `grill-with-docs`/`grill-me` 在此；其中的插件目录如 `superpowers/` 内部 skill 以**裸名**暴露，如 `writing-plans`/`test-driven-development`/`requesting-code-review`/`verification-before-completion`）、`~/.codex/skills/`（另一直装根）**和** `~/.codex/plugins/`（plugin 安装）。
     只查 plugins、或只查 `~/.codex/skills/` 而漏掉 `~/.agents/skills/`，都会系统性地漏掉直装 skill，算体检失败。runtime 的 `available skills` 列表（来源①）已聚合全部根目录，是最终判据——它列出的 skill 即视为可用，不得因手动探某一目录没找到就判 `blocked`。
- `current-agent` / `subagent` 是执行模式，不是依赖降级。只有节点显式声明 `native_*_allowed` 时，才允许不依赖框架直接由 agent 执行。
- 推荐 `skill`/`tool`/`agent` 都不可用且用户未选允许的 native 模式时 → `blocked: install_required`，不得继续该节点。
- Gate 1 只展示 N7 的 goal_condition（Step 0 初值或续跑当前值），不得把它当作 N5 `/goal` 条件。/goal 条件必须在 N5 前从 N4 Done 标准提炼；若本轮没有 N4，才使用 N1 同步后的 goal_condition。
- **必须输出以下【编排报告】模板，缺字段不得开闸：**

```
═══ /spec 编排报告（Gate 1）═══
🎯 需求：<一句话>
🏁 目标条件（goal_condition）：<N7 最终验收准则；Step 0 初值/续跑当前值>
   状态：<ready 非空可验证 ｜ pending:N1_anchor 空且 N1 待跑（N1 出口门锚定）｜ blocked:goal_condition_required 空且 N1 不在待跑集（须 Gate 1 补填或豁免）｜ waived 已显式豁免（附 goal_condition_waiver_reason）>
🌐 Scope（NS 跨仓发现）：<涉及服务/仓清单，或 N/A>
📊 四维评分：规模=? 风险=? 项目=新/老 领域清晰度=?
🧩 节点集：N? → N? → ...（共 N 个）
🔗 每节点绑定：
   - N1 需求拷问 | 框架: grill-with-docs | 模式: 待选 | 状态: ✅bound
   - N3 规格     | 框架: openspec        | 模式: 待选 | 状态: ❌blocked(install_required)
   - ...
⚠️ 缺失依赖：<列出 ❌ 项 + 安装/改编排/暂停选项>
🤖 模型分层：advisor = {tier_high模型}（NS/N1/N2/N3/N6/N7）| N4 = {tier_high模型}（规格清晰时可在 Gate 1 降为 {tier_mid模型}）| executor = {tier_mid模型}（N5）
   ⚠️ 风险H时 N5 executor 自动升为 {tier_high模型}（矩阵规则触发，无需再选）
   ⚠️ 模型注入只对「以 subagent 派发」的节点生效；选 current-agent 的节点在主 agent（advisor 档）执行，无独立注入
```

（`{tier_high模型}` / `{tier_mid模型}` 在运行时按 `registry.yaml` 的 `executor_model_map[当前执行器]` 解析为具体模型名）

- 然后用 **AskUserQuestion 开编排闸**，亮出：四维判分（可改）、节点清单+风味、依赖体检（✅/❌）、支持 subagent 的节点逐项给 `①subagent｜②当前 agent`、每个 ❌ 给安装选项（装什么/来源/卸载/前置；选装即授权，按 `references/install.md` 自动核实安装验证）。
- 若用户不安装：只能改编排去掉该节点、改选另一已可用风味、选该节点显式允许的 native 模式、或暂停；**不得用内嵌方法替代**。
- **大流程呈现协议（节点多时必读）**：AskUserQuestion 上限 4 问、每问 2-4 选，装不下 9 节点全量闸。按此渲染：①先用**文本**完整呈现上面【编排报告】；②再用 AskUserQuestion 只问**需用户拍板的少数决策**（≤4 问），其余应用默认（四维判分默认接受、支持 subagent 的节点默认 current-agent、缺件默认"改编排去掉该节点"）；③决策多于 4 项时分批问，或合并为一问"是否接受这套编排(含默认)？否则逐项调整"。
- **用户确认/微调后才进 Step 4。** （铁律 2/4）

### Step 4 · 顺序执行节点（每个节点都委派框架）
对节点集按序执行，每个节点：

**【内层纪律 · 每节点通用，FableCodex 原则】**
- **cheapest useful check first**：先跑最便宜的验证（grep、单测、`git diff --name-only`），确认有必要才做昂贵操作（跨服务扫描、全量测试套件、派子代理）。昂贵操作前须说明为何便宜检查不够。
- **conclusion-first 输出**：节点向 spec.md 写内容时，先结论，再证据，再细节。禁止裸断言（「实现完成」「测试通过」），必须附命令输出截取或文件引用（`文件:行号`）。
- **clue-first（调试/审查时）**：先定位具体线索（报错行、失败测试名、相关文件），再下结论；禁止无依据的「可能是X导致」；每个 finding 必须先有定位证据才能提出。

0. **先打印声明行**（铁律 5）：`▶ {节点} | 框架: {name} | 模式: {mode} | 状态: {bound|blocked}`。
1. **取实现方式**（来自 Step 3 绑定结果）：
   - `① skill`：用 Skill 工具调用该技能，把 `spec.md` 当共享上下文传入。
   - `② tool`：仅当用户在编排闸同意绑定且已装时，调外部工具。
   - `③ agent`：用 Task 工具派该 agent（如 NS 的 Explore/codebase-analyzer），声明输入/输出/写入范围。
   - `④ 执行模式`：用户在 Gate 选 `subagent` 时派子任务（声明输入、输出、写入范围、不得回退用户改动）；选 `current-agent` 时由当前 agent 调用**已绑定框架**执行（仍不得自由发挥替代框架，除非节点显式 `native_*_allowed`）。
   - `⑤ 模型注入（所有 subagent 派发节点通用）`：**仅当节点以 subagent 派发时**，从 `registry.yaml` 的 `executor_model_map[当前执行器]` 取模型名注入 Agent 工具的 `model` 参数——advisor 节点（NS/N1/N2/N3/N6）用 `tier_high`；N4 默认 `tier_high`、规格清晰且 Gate 1 已降档时用 `tier_mid`（读 `N4_tasks.executor_model`）；N5 用 `tier_mid`、风险 H 升 `tier_high`。选 `current-agent` 的节点在主 agent（advisor 档）执行，无独立模型注入。**N5 以 subagent 派发时，advisor（当前 agent）不亲自写实现**，只在 N6 读取 executor 产出的 diff 审查；N5 选 `current-agent` 时由当前 agent 调用已绑定 TDD 框架实现（此时无 executor/advisor 分层）。
2. **写章节**：把框架产物写进 `spec.md` 该节点负责的章节（见 `spec-template.md`）。
3. **过出口门**：校验该节点出口门（N1 意图被逼出、N7 DoD 全绿……）；不过则不进下一节点。N1 未过**禁止**进 N3/N5（铁律 6）。
   > **N1 出口门补充（mandatory）：** N1 不只产出「真实意图」，还必须做 Goal Sync：把 N1 逼出的真实意图与 front-matter `goal_condition` 对齐。若真实意图改变，必须在进入 N3 或 N5 前更新 goal_condition，并在「问题与非目标」章节记录旧值、新值、更新原因。若 goal_condition 为空且未被显式豁免，必须 AskUserQuestion 让用户补填可验证条件或明确豁免；否则不得进入 N3/N5。
   > **N4 出口门校验（mandatory）：** 逐条检查每个任务条目是否包含 5 项：① 文件路径+代码摘录 ② scope 边界（in/out-of-scope）③ 验证命令+期望输出 ④ Done 标准（可机器执行 + **transcript-verifiable**：命令将在 N5 执行中被打印，供 /goal 评估器读取；不可写语义判断类条件）⑤ 逃生口。缺任意一项则要求框架补充，**不得进入 N5**。格式参照 `spec-template.md` 的「任务拆解」章节。
4. 更新 `spec.md` front-matter 的 `status`。

> **N5（实现）前必须**：AskUserQuestion 问 `subagent | 当前 agent`（铁律 7）；随后做 Goal Source Sync：若本轮运行了 N4，从 N4 Done 标准提炼 `/goal` 条件；若本轮未运行 N4，使用 N1 同步后的 `goal_condition`。按下面顺序处置条件来源（**不得跳序**，避免空值被静默跳过）：
> 1. 条件来源为空且未被显式豁免 → 先 AskUserQuestion 让用户补填或明确豁免，**不得静默跳过**；补填后条件来源转为非空，选择豁免则写入 `goal_condition_waiver_reason`。
> 2. 处置后条件来源仍为空（即已显式豁免）→ 记录原因并跳过 `/goal` 启用询问，不执行 `/goal`。
> 3. 条件来源非空 → 才询问是否启用 `/goal`（① 启用 ② 不启用）。
>
> 再按所选模式委派 TDD 框架执行。

> **N5 /goal 集成（可选，N5 前 AskUserQuestion 询问是否启用）：**
> 1. 条件来源：
>    - N4 已运行：从 N4 每个任务的 Done 标准提炼出 /goal 条件字符串（Done 标准必须已满足 transcript-verifiable）。
>    - N4 未运行：使用 N1 同步后的 front-matter `goal_condition`。
>    - 条件来源为空且未豁免：按上面「N5 前必须」的处置顺序先 AskUserQuestion 补填或豁免，**不得在此静默跳过**。
>    - 条件来源已显式豁免（或用户在上一步选择豁免后仍为空）：记录原因后跳过 `/goal` 启用询问，继续 N5。
> 2. N5 开始时执行：`/goal <条件字符串>`（最长 4000 字符，多任务可串联 `and`；超长时拆分或回 AskUserQuestion 选择缩减）
> 3. 执行者专注写代码；评估器每轮判断条件是否满足：
>    - **Claude Code**：独立 Haiku 模型读 transcript 判断（执行者与裁判分离，质量保证更强）；可通过 Stop hook 自定义替换 Haiku
>    - **Codex**：自我评估（同一模型判断完成，无独立裁判；条件设计须更加明确可量化）
> 4. 条件满足 → N5 自动退出；条件未满足 → 继续循环，Haiku 否定理由作为下轮指导
> 5. ⚠️ N5 中必须将验证命令及其输出**打印到对话里**评估器才能读到；N5 若以 subagent 派发，`/goal` 在该子代理内运行、评估器读的是**子代理自身的 transcript**，故验证命令须打印在实际执行 N5 的那个 agent 的上下文里
> 6. N7 接管时 /goal 已确认条件绿，但 N7 仍独立验证（cheapest-first：先跑单测）

> **N7 coverage accounting（mandatory）：**
> 1. **cheapest-first 顺序**：先单测（最快反馈）→ lint → typecheck → build → goal_condition 验收
> 2. **意图覆盖率检查**：逐条核对 N1 逼出的每条真实意图 → 对应 spec 章节存在？→ 对应 N7 验证命令存在？填写 spec.md「意图覆盖率追踪」表
> 3. **goal_condition 最终验收**：若 goal_condition 为空且未被显式豁免，先 AskUserQuestion 补填或显式豁免，不得静默跳过；若已豁免，记录 `goal_condition_waiver_reason` 后跳过；否则运行 front-matter `goal_condition` 指定的命令，输出与期望吻合则 N7 通过。
> 4. **失败分流**：若实现未达标但 spec/N4 仍有效，AskUserQuestion 提示「goal_condition 未满足，需重跑 N5」；重跑 N5 后须重走 N6 审查（若 N6 在本轮编排中，Gate 2 不可绕过），再回 N7。若失败说明 spec 或 N4 任务需要变化，必须回退到 N3/N4：更新 spec/任务，重新过 N3 定稿 Gate 2，重新写入 spec_commit，再按 N4→N5→N6→N7 继续。

### Gate 2 · 关键节点闸（硬 STOP）
在以下节点完成时**停下，用 AskUserQuestion 请用户拍板**，不要连跑：
- **N3 规格定稿**（spec 是后续一切的判据）
- **N6 审查**（防偏航/过度设计/安全）
  > **N6 clue-first 纪律**（Step 4 通用纪律的 N6 专属扩展）：线索不足的 finding 标记为「待核实」而非直接列入审查记录；待核实条目须在 AskUserQuestion 展示给用户前补充定位证据，否则不得计入 finding 总数。
  >
  > **N6 Vet 规则（mandatory）：** reviewer 在呈现任何 finding 前，必须亲自重读被引用的文件位置（不得只看子代理报告）。过滤三类噪音：① by-design 行为（已有 ADR/spec 依据，对照 NS-A 读取的意图文档核查）② 误归因（正确 finding，错误文件/行）③ 重复 finding。过滤后的 finding 标注「已核实」方可写入审查记录；被过滤条目写入「considered and rejected」附注并附原因。
- **合并前**（尤其风险 H：要 Human Approval）

### Step 5 · 归档（N8）
把"为何这么设计、哪些方案被否、新增领域词、改了哪些边界、遗留 TODO"沉淀进 `spec.md` 的归档章节 / ADR / CONTEXT。N8 只能用 `registry.yaml` 登记的方式执行。

---

## 节点候选库（全集，矩阵从中选）

| 节点 | 阶段 | 出口门 |
|---|---|---|
| N0 | 项目底座（标准/命令注入） | 标准齐 |
| NS | 跨服务/跨仓范围发现（老项目强制，派子代理） | 跨栈范围界定并经用户确认 |
| N1 | 需求拷问 | 真实意图被逼出（未过禁进 N3/N5） |
| N2 | 领域建模 | 词汇人机一致 |
| N3 | 规格 | **关键闸·定稿** |
| N4 | 任务拆解 | 任务可单测单审 |
| N5 | 实现（TDD+worktree） | 红绿重构走完 |
| N6 | 审查 | **关键闸·审查** |
| N7 | 验证 | **DoD 全绿** |
| N8 | 归档 | 留痕完成 |

> 每节点的"最优风味"与"消费/产出哪些 spec 章节"见 `matrix.md` 与 `registry.yaml`。

---

## 跨执行器与安装（务必遵守）

- **命令名差异不写在本文里**，一律去 `registry.yaml` 查当前环境的调用名；人读版见 `references/registry.md`。
- **不再有内嵌方法兜底**。缺推荐依赖时必须进入安装或改编排；不能自行发明轻量版，也不能退化成当前 agent 自己做。
- **安装必须人控但不中断执行链**：Gate 1 亮出安装选项；用户选择安装后，按 `references/install.md` 自动核实、安装、验证，然后继续。
- **subagent 是显式选择**：支持 subagent 的节点不得默认派发，也不得默认留在当前 agent；必须让用户选择。

---

## 文件指引

| 文件 | 何时读 |
|---|---|
| `matrix.md` | Step 1/2：四维 rubric + 编排矩阵 + 示例流程 |
| `registry.yaml` | Step 3：节点→各执行器调用名、安装需求、subagent 支持 |
| `references/registry.md` | 需要人读版的登记表解释时 |
| `spec-template.md` | Step 0：spec.md 骨架与章节归属 |
| `references/install.md` | 编排闸出现 ❌ 缺失、用户选"安装"时 |
