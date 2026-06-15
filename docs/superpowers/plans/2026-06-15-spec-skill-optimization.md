# Spec Skill Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 shadcn/improve 的核心设计理念（Advisor/Executor 分层、Recon 侦察、自包含计划格式、Vet 步骤、漂移检测）整合进 john:spec skill。

**Architecture:** 四条主线按优先级落地：B（NS Recon+Scope 拆分）→ A（model_tier 分层）→ C（N4 自包含格式 + N7 Vet）→ D（漂移检测 + branch 变体）。改动分散在 4 个文件，每个 Task 对应一个文件的完整变更，Task 间无依赖冲突可并行。

**Tech Stack:** YAML（registry.yaml）、Markdown（SKILL.md、matrix.md、spec-template.md）

---

## File Map

| File | 改动内容 |
|---|---|
| `skills/spec/registry.yaml` | 新增 model_tiers/executor_model_map、NS sub_steps、各节点 model_tier 字段、更新 exit_gate |
| `skills/spec/SKILL.md` | NS 拆 NS-A+NS-B、Gate 1 报告加模型列、N5 模型注入规则、N4 出口门校验、N7 Vet 规则、Step 0 漂移检测、/spec branch 变体 |
| `skills/spec/matrix.md` | branch 模式覆写规则、风险 H 模型升格规则 |
| `skills/spec/spec-template.md` | front-matter 加 spec_commit、新增项目意图与约束章节、更新任务拆解模板 |

---

## Task 1: registry.yaml — 模型分层 + NS 子步骤 + 出口门更新

**Files:**
- Modify: `skills/spec/registry.yaml`

- [ ] **Step 1: 在 `execution_modes` 块之后插入模型分层配置**

在 `execution_modes:` 块（第 15-17 行）之后、`installables:` 之前插入：

```yaml
# ── 模型分层（Advisor/Executor 角色固定，执行器映射在 executor_model_map）──
model_tiers:
  advisor:        tier_high   # 分析/规格/审查节点
  executor:       tier_mid    # 实现节点
  executor_risk_H: tier_high  # 风险H时 executor 升格与 advisor 同级

executor_model_map:
  claude-code:
    tier_high: opus
    tier_mid:  sonnet
  codex:
    tier_high: o3
    tier_mid:  gpt-4o-mini
  # 新执行器：在此追加一个 block，SKILL.md 逻辑无需改动

```

- [ ] **Step 2: 给 NS_scope_discovery 加 sub_steps**

在 `NS_scope_discovery:` 的 `stage:` 行之后插入：

```yaml
    sub_steps:
      NS_A_recon:
        label: 意图侦察（Recon）
        model_tier: advisor
        reads: [README, "CLAUDE.md/AGENTS.md", CONTEXT.md, DESIGN.md, PRODUCT.md, "ADR/", git-log-30]
        produces: [项目意图与约束章节]
        executor: current-agent   # advisor 自读，不派子代理
      NS_B_scope:
        label: 跨服务范围发现（Scope）
        model_tier: advisor
        produces: [涉及服务/仓清单]
        executor: subagent        # 原逻辑：派 Explore agent
```

- [ ] **Step 3: 给 N4_tasks 加 model_tier + executor_model + 更新 exit_gate**

在 `N4_tasks:` 的 `stage:` 行之后插入：

```yaml
    model_tier: flexible
    executor_model:
      default: tier_high        # 跟随 advisor；规格清晰时可在 Gate 1 降
      when_spec_clear: tier_mid
```

将 N4_tasks 的 `exit_gate:` 改为：

```yaml
    exit_gate: 每个任务含文件路径+摘录/scope边界/验证命令+期望输出/Done标准/逃生口
```

- [ ] **Step 4: 给 N5_implement 加 model_tier + executor_model**

在 `N5_implement:` 的 `stage:` 行之后插入：

```yaml
    model_tier: executor
    executor_model:
      default: tier_mid         # 默认廉价模型执行实现
      risk_H: tier_high         # 风险H时升格，防止实现偷懒
```

- [ ] **Step 5: 更新 N7_review 的 exit_gate**

将 N7_review 的 `exit_gate:` 改为：

```yaml
    exit_gate: 关键闸·审查（每条finding已vet，by-design/误归因/重复已过滤，附核实证据）
```

- [ ] **Step 6: 验证 YAML 语法**

```bash
python3 -c "import yaml; yaml.safe_load(open('skills/spec/registry.yaml'))" && echo "YAML OK"
```

Expected: `YAML OK`

---

## Task 2: spec-template.md — spec_commit + 项目意图章节 + 任务拆解模板

**Files:**
- Modify: `skills/spec/spec-template.md`

- [ ] **Step 1: 在 front-matter 加 spec_commit 字段**

在 `status: drafting` 行之后、`created:` 之前插入：

```yaml
spec_commit: ""              # N3 定稿时写入（git rev-parse --short HEAD），用于续跑漂移检测
```

- [ ] **Step 2: 在「涉及服务 / 跨仓范围」章节之前插入「项目意图与约束」章节**

```markdown
## 项目意图与约束         <!-- NS-A Recon，老项目强制；greenfield 标 N/A -->
- 已决策 ADR（不再讨论的方向）：
- 活跃演进方向（git log 近 30 条推断）：
- 不可违背的约束（build/test/lint 命令 + 已知技术债）：
- Recon 读取的意图文档：

```

- [ ] **Step 3: 更新「任务拆解」章节模板**

将原 `- [ ] T-001 …` 替换为完整的自包含任务格式：

```markdown
### T-001 · <任务标题>
**为何做：** <影响和上下文，≤2句>
**文件路径：** `src/xxx.ts:42-67`（附当前代码摘录，≤15行）
**scope 边界：** in-scope: [文件A, 文件B] | out-of-scope: [不能碰的文件]
**有序步骤：**
  1. 做 X → 验证命令: `<命令>` → 期望输出: `<期望>`
  2. 做 Y → ...
**Done 标准（可机器执行）：** `<验证命令>`
**测试计划：** 新测试放 `tests/xxx.spec.ts`，参照 `tests/bar.spec.ts` 的写法
**逃生口：** 若遇到 <X 情况>，STOP 并上报，不得自行发挥
```

---

## Task 3: matrix.md — branch 模式覆写规则 + 风险H模型升格

**Files:**
- Modify: `skills/spec/matrix.md`

- [ ] **Step 1: 在文件最开头（标题行之后）插入 branch 模式覆写规则**

在 `# 四维评分 + 编排矩阵` 标题之后、`本文是引擎的"大脑"` 段落之前插入：

```markdown
## 0. branch 模式覆写规则

触发 `/spec branch` 时，以下规则**覆盖**标准矩阵（第1-5节），优先级最高：

| 规则 | 值 |
|---|---|
| 规模上限 | 锁定 M（增量分析，即使 diff 很大也不升 H） |
| NS 替换 | diff-scan（`git diff main --name-only` + 涉及文件快速读），跳过跨服务发现 |
| N1 风味 | 固定 grill-with-docs（无论新老项目） |
| N8 | 必选（所有 finding 标注 `introduced` 本分支引入 / `pre-existing` 原有问题） |
| 其余节点 | 按标准矩阵升级规则，但规模上限 M 生效 |

---

```

- [ ] **Step 2: 在「升级规则」表格末尾追加模型升格行**

在升级规则表格（`| 风险 H | ...`行）之后追加：

```markdown
| 风险 H | N5 executor_model 从 tier_mid 升为 tier_high（廉价模型升格与 advisor 同级） |
```

---

## Task 4: SKILL.md — 七处逻辑更新

**Files:**
- Modify: `skills/spec/SKILL.md`

> 注意：SKILL.md 改动最多，按顺序逐步处理，每步独立可验证。

- [ ] **Step 1: 在「执行流程」标题之前插入 `/spec branch` 变体触发说明**

在 `## 执行流程` 之前插入：

```markdown
## 变体触发

| 变体 | 触发方式 | 行为差异 |
|---|---|---|
| 标准模式 | `/spec` 或描述功能需求 | 走完整执行流程 |
| **branch 模式** | `/spec branch` | 仅针对当前分支 diff；按 matrix.md §0 覆写规则缩减流程 |

**branch 模式执行差异（详见 matrix.md §0）：**
- NS 替换为：`git diff main --name-only` + 涉及文件快速读（不派 Explore agent）
- 四维评分规模上限锁定 M；N8 必选并标注 introduced/pre-existing
- 适用场景：PR review 前快速生成改动范围的 spec

---

```

- [ ] **Step 2: 将 NS 节拆为 NS-A（意图侦察）+ NS-B（跨服务发现）**

将 `### NS · 跨服务/跨仓范围发现（老项目强制，派子代理执行）` 整个节（包含目的、谁执行、产出、出口门共4段）替换为：

```markdown
### NS · 跨服务/跨仓范围发现（老项目强制）

NS 拆为两个子步，顺序执行；greenfield 项目 NS-B 标 N/A，NS-A 仍执行。

#### NS-A · 意图侦察（Recon）——advisor 自读，不派子代理

- **目的**：在跨服务发现前，先读懂项目的意图与约束，防止 N1 拷问时问出已由 ADR 决定的废问题。
- **谁执行**：当前 agent（advisor）直接读，无需派子代理。
- **必读清单**：`README`、`CLAUDE.md`/`AGENTS.md`、`CONTEXT.md`、`DESIGN.md`、`PRODUCT.md`、`ADR/` 目录、`git log --oneline -30`（判断活跃演进方向）、根 config 文件（识别 build/test/lint 命令）。
- **产出**：写入 `spec.md` 的「项目意图与约束」章节（已决策 ADR / 活跃演进方向 / 不可违背约束）。
- **出口**：意图文档已读完，约束已写入 spec.md。

#### NS-B · 跨服务范围发现（Scope）——派子代理执行

- **目的**：当前路径可能只是某功能的一部分。必须先界定这个功能**真正触及的全部服务/仓**，否则后续 spec 只覆盖半边。
- **谁执行**：**不是编排器自己扫**。按 `registry.yaml` 的 `NS_scope_discovery.sub_steps.NS_B_scope` 绑定，**派子代理**（CC: `Explore` agent；Codex: `codebase-analyzer`）去发现：关联前后端、相关微服务、第三方/内部 API、配置文件里的服务地址、数据库、消息/GraphQL/Apollo 端点、回调与 webhook 链路、父目录/兄弟仓/monorepo 包中相关代码。
- **产出**：写进 `spec.md` 的「涉及服务 / 跨仓范围」章节。
- **出口门**：跨栈范围已界定，并在 Gate 1 经用户确认完整（用户可补充遗漏的服务）。greenfield 无既有服务时标 `N/A`。

```

- [ ] **Step 3: 更新 Gate 1 编排报告模板（加模型列 + 模型分层声明行）**

在 Gate 1 编排报告模板（以 `═══ /spec 编排报告（Gate 1）═══` 开头的代码块）中：

**① 在 `🔗 每节点绑定：` 的示例行中加 `模型:` 列：**

```
   - N1 需求拷问 | 框架: grill-with-docs | 模式: 待选 | 模型: opus(advisor) | 状态: ✅bound
   - N5 实现     | 框架: TDD+worktree    | 模式: 待选 | 模型: sonnet(executor) | 状态: ✅bound
   - N7 审查     | 框架: code-review     | 模式: 待选 | 模型: opus(advisor) | 状态: ✅bound
```

**② 在 `⚠️ 缺失依赖：` 行之后加模型分层声明行：**

```
🤖 模型分层：advisor = {tier_high模型}（NS/N1/N2/N3/N6/N7）| executor = {tier_mid模型}（N5）
   ⚠️ 风险H时 N5 executor 自动升为 {tier_high模型}（由矩阵规则触发，无需再选）
```

（`{tier_high模型}` 在运行时按 `registry.yaml` 的 `executor_model_map` 解析为当前执行器的具体模型名）

- [ ] **Step 4: 在 Step 4 节点执行逻辑中加 N5 模型注入规则**

在 Step 4 的 `③ agent` 派发说明之后插入：

```markdown
   - `⑤ 模型注入（N5 专属）`：派发 N5 子代理时，从 `registry.yaml` 的 `executor_model_map[当前执行器]` 取模型名：风险 L/M 用 `tier_mid`，风险 H 用 `tier_high`。注入 Agent 工具的 `model` 参数。**advisor（当前 agent）不执行 N5 实现**，只在 N7 读取 executor 产出的 diff 进行审查。
```

- [ ] **Step 5: 在 Step 4 的 N4 执行说明后加出口门校验规则**

在 Step 4 的 `3. **过出口门**` 说明之后（或在 N5 前必须的说明块之后）插入：

```markdown
> **N4 出口门校验（mandatory）：** 逐条检查每个任务条目是否包含以下 5 项：① 文件路径+代码摘录 ② scope 边界（in/out-of-scope）③ 验证命令+期望输出 ④ Done 标准（可机器执行）⑤ 逃生口。缺任意一项则要求框架补充，**不得进入 N5**。格式参照 `spec-template.md` 的「任务拆解」章节。
```

- [ ] **Step 6: 在 Gate 2 的 N7 说明中加 Vet 规则**

在 `Gate 2 · 关键节点闸` 的 `**N7 审查**` 条目之后插入：

```markdown
  **N7 Vet 规则（mandatory）：** reviewer 在呈现任何 finding 前，必须亲自重读被引用的文件位置（不得只看子代理报告）。过滤三类噪音：① by-design 行为（已有 ADR/spec 依据，对照 NS-A 读取的意图文档核查）② 误归因（正确 finding，错误文件/行）③ 重复 finding。过滤后的 finding 标注「已核实」方可写入审查记录；被过滤条目写入「considered and rejected」附注并附原因。
```

- [ ] **Step 7: 在 Step 0「续跑」逻辑之后插入漂移检测**

在 Step 0 的续跑段落（`若目标 spec.md 已存在，读 front-matter status…`）之后插入：

```markdown
- **漂移检测（续跑时）**：读 front-matter 的 `spec_commit` 字段（N3 定稿时写入的 commit hash）。若字段非空，运行：
  ```bash
  git log --oneline {spec_commit}..HEAD -- <spec 覆盖的文件路径列表>
  ```
  若有改动，用 AskUserQuestion 提示：「spec 锁定后代码已有 N 次变更，涉及 [文件列表]，spec 可能已漂移。① 先 review 再继续（推荐）② 直接续跑（忽略漂移）」。N3 定稿时在 spec.md front-matter 写入 `spec_commit: $(git rev-parse --short HEAD)`。
```

- [ ] **Step 8: 验证 SKILL.md 结构完整性（人工检查）**

打开文件确认以下 7 处变更均已落地：
1. `## 变体触发` 节存在（branch 变体）
2. `### NS-A · 意图侦察` 和 `### NS-B · 跨服务范围发现` 均存在
3. Gate 1 编排报告有 `模型:` 列和 `🤖 模型分层：` 行
4. Step 4 有 `⑤ 模型注入（N5 专属）` 说明
5. Step 4 有 `N4 出口门校验（mandatory）` 说明
6. Gate 2 有 `N7 Vet 规则（mandatory）` 说明
7. Step 0 有 `漂移检测（续跑时）` 说明

```bash
grep -n "变体触发\|NS-A\|NS-B\|模型分层\|模型注入\|N4 出口门校验\|N7 Vet 规则\|漂移检测" skills/spec/SKILL.md
```

Expected: 每个关键词各出现至少 1 次。
