# Spec × FableCodex Fusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 FableCodex 的三条执行纪律（cheapest-check-first / clue-first / conclusion-first）和 /goal 自主执行集成融入 spec skill，不破坏跨执行器结构。

**Architecture:** 纯文本改动，4 个文件，无新增文件。spec-template.md 新增 `goal_condition` 字段和覆盖率追踪表；SKILL.md 在 Step 0 加目标锚定、Step 4 加节点内层纪律、N5 加 /goal 集成、N4/N6 出口门加强；registry.yaml 在 N4/N5/N6 节点加元数据。

**Tech Stack:** Markdown, YAML（纯编辑，无构建步骤）

---

## 文件改动地图

| 文件 | 改动 |
|---|---|
| `skills/spec/spec-template.md` | 新增 `goal_condition` front-matter 字段；N4 Done 标准加 transcript-verifiable 注释；N6 新增意图覆盖率追踪表和 goal_condition 校验项 |
| `skills/spec/SKILL.md` | Step 0 加目标锚定步骤；Step 4 开头加三条内层纪律；N4 出口门④加 transcript-verifiable 要求；N5 加 /goal 集成说明；N6 coverage accounting；N7 Vet 加 clue-first 纪律 |
| `skills/spec/registry.yaml` | N4_tasks 加 `done_criteria_requirement`；N5_implement 加 `goal_integration` 块；N6_verify 加 `coverage_accounting` 块 |

---

## Task 1：spec-template.md — front-matter + N4 + N6

**Files:**
- Modify: `skills/spec/spec-template.md`

- [ ] **Step 1：在 front-matter 的 `spec_commit` 字段后面加 `goal_condition` 字段**

找到这行：
```
spec_commit: ""         # N3 定稿时写入（git rev-parse --short HEAD），用于续跑漂移检测
```
在其后插入：
```yaml
goal_condition: ""      # Step 0 提炼：「当[可验证命令输出]为真时本次工作完成」；必须 transcript-verifiable；N6 最终验收准则
```

- [ ] **Step 2：更新 N4 任务模板的 Done 标准行**

找到：
```
**Done 标准（可机器执行）：** `<验证命令>`
```
替换为：
```
**Done 标准（可机器执行 + transcript-verifiable）：** `<验证命令>` → 期望输出: `<期望文本>`
<!-- transcript-verifiable：命令须在 N5 执行中被打印；/goal 评估器（Haiku）只读 transcript，不能独立调工具 -->
```

- [ ] **Step 3：扩展 N6 验证记录章节，加覆盖率追踪**

找到：
```
## 验证记录（DoD）         <!-- N6 -->
- [ ] 所有测试通过  [ ] lint  [ ] typecheck  [ ] build
- [ ] 新增逻辑有测试  [ ] 修改行为有回归  [ ] 无无关 diff  [ ] 无绕过测试
```
替换为：
```
## 验证记录（DoD）         <!-- N6 -->

<!-- cheapest-first 顺序：单测 → lint → typecheck → build → goal_condition -->
- [ ] 所有测试通过  [ ] lint  [ ] typecheck  [ ] build
- [ ] 新增逻辑有测试  [ ] 修改行为有回归  [ ] 无无关 diff  [ ] 无绕过测试
- [ ] goal_condition 成立（最终验收，见 front-matter）

### 意图覆盖率追踪        <!-- N6 coverage accounting -->
| 意图（N1 逼出） | spec 章节 | 实现任务 | N6 验证命令 + 期望输出 | 状态 |
|---|---|---|---|---|
| <意图1> | <章节> | <T-00x> | `<命令>` → `<期望>` | ⬜/✅ |
```

- [ ] **Step 4：读文件，确认三处改动都已写入，格式无误**

```bash
grep -n "goal_condition\|transcript-verifiable\|意图覆盖率" skills/spec/spec-template.md
```
期望输出：出现 3 处匹配，行号不同。

- [ ] **Step 5：Commit**

```bash
git add skills/spec/spec-template.md
git commit -m "feat(spec): add goal_condition front-matter + transcript-verifiable Done 标准 + N6 覆盖率追踪表"
```

---

## Task 2：SKILL.md — Step 0 目标锚定

**Files:**
- Modify: `skills/spec/SKILL.md`（Step 0 节，约第 54-59 行）

- [ ] **Step 1：在 Step 0 末尾（"读 spec-template.md 作为骨架"一行后）追加目标锚定步骤**

找到：
```
- 读 `spec-template.md` 作为骨架。
```
在其后插入（同缩进级别）：
```
- **目标锚定（Goal Condition）**：将用户需求提炼为一条 `goal_condition` 字符串，格式：
  `「当 [可验证命令退出码/输出] 为真时，本次工作完成」`
  示例：`「pytest auth/ 输出 N passed 0 failed 且 ruff check 输出为空」`
  写入 spec.md front-matter 的 `goal_condition` 字段。
  - 这是 N1 拷问的参照真北：所有拷问围绕"让这个条件成立需要做什么"展开。
  - 这是 N6 最终验收准则：N6 必须验证 goal_condition 成立。
  - 这是 N5 /goal 的条件来源（见 Step 4 N5）。
  - ⚠️ 条件必须 **transcript-verifiable**：命令须在 N5 中被执行并打印，/goal 评估器（Haiku）只读 transcript，不能独立调工具。不可写"实现符合设计原则"此类语义判断条件。
```

- [ ] **Step 2：读文件确认插入位置正确**

```bash
grep -n "目标锚定\|goal_condition\|transcript-verifiable" skills/spec/SKILL.md | head -10
```
期望：出现 Step 0 节的匹配行（行号在原第 59 行附近）。

- [ ] **Step 3：Commit**

```bash
git add skills/spec/SKILL.md
git commit -m "feat(spec): Step 0 增加目标锚定（goal_condition 提炼 + transcript-verifiable 约束）"
```

---

## Task 3：SKILL.md — Step 4 三条内层纪律

**Files:**
- Modify: `skills/spec/SKILL.md`（Step 4 节，约第 126-128 行）

- [ ] **Step 1：在 Step 4 "对节点集按序执行" 一行之后、"0. 先打印声明行" 之前插入内层纪律块**

找到：
```
对节点集按序执行，每个节点：
0. **先打印声明行**
```
在"对节点集按序执行，每个节点："之后、"0. **先打印声明行**"之前插入：

```
**【内层纪律 · 每节点通用，FableCodex 原则】**
- **cheapest useful check first**：先跑最便宜的验证（grep、单测、`git diff --name-only`），确认有必要才做昂贵操作（跨服务扫描、全量测试套件、派子代理）。昂贵操作前须说明为何便宜检查不够。
- **conclusion-first 输出**：节点向 spec.md 写内容时，先结论，再证据，再细节。禁止裸断言（「实现完成」「测试通过」），必须附命令输出截取或文件引用（`文件:行号`）。
- **clue-first（调试/审查时）**：先定位具体线索（报错行、失败测试名、相关文件），再下结论；禁止无依据的"可能是X导致"；每个 finding 必须先有定位证据才能提出。

```

- [ ] **Step 2：确认插入位置正确（内层纪律在 0. 之前）**

```bash
grep -n "内层纪律\|cheapest useful\|conclusion-first\|clue-first" skills/spec/SKILL.md
```
期望：4 行匹配，行号连续，在 Step 4 区块内。

- [ ] **Step 3：Commit**

```bash
git add skills/spec/SKILL.md
git commit -m "feat(spec): Step 4 增加三条内层纪律（cheapest-check-first/conclusion-first/clue-first）"
```

---

## Task 4：SKILL.md — N4 出口门 + N5 /goal 集成 + N6 coverage + N7 clue-first

**Files:**
- Modify: `skills/spec/SKILL.md`（N4 出口门约第 137 行；N5 约第 140 行；N7 Vet 约第 146 行）

- [ ] **Step 1：强化 N4 出口门的 ④ Done 标准，加 transcript-verifiable 要求**

找到：
```
④ Done 标准（可机器执行）⑤ 逃生口。
```
替换为：
```
④ Done 标准（可机器执行 + **transcript-verifiable**：命令将在 N5 执行中被打印，供 /goal 评估器读取；不可写语义判断类条件）⑤ 逃生口。
```

- [ ] **Step 2：在 N5 强制提示后追加 /goal 集成说明**

找到：
```
> **N5（实现）前必须**：AskUserQuestion 问 `subagent | 当前 agent`（铁律 7），再按所选模式委派 TDD 框架执行。
```
在其后插入：

```
> **N5 /goal 集成（可选，Gate 1 询问是否启用）：**
> 1. 从 N4 每个任务的 Done 标准提炼出 /goal 条件字符串（需已满足 transcript-verifiable）
> 2. N5 开始时执行：`/goal <条件字符串>`（最长 4000 字符，多任务可串联 `and`）
> 3. 执行者专注写代码；评估器每轮判断条件是否满足：
>    - **Claude Code**：独立 Haiku 模型读 transcript 判断（执行者与裁判分离，质量保证更强）；可通过 Stop hook 自定义替换 Haiku
>    - **Codex**：自我评估（同一模型判断完成，无独立裁判；条件设计须更加明确可量化）
> 4. 条件满足 → N5 自动退出；条件未满足 → 继续循环，Haiku 的否定理由作为下轮指导
> 5. ⚠️ N5 中必须将验证命令及其输出**打印到对话里**，评估器才能读到
> 6. N6 接管时 /goal 已确认条件绿，但 N6 仍独立验证（cheapest-first：先跑单测）
```

- [ ] **Step 3：在 N6 部分（Step 5 · 归档前）加 coverage accounting 说明**

找到 Gate 2 节（N7 审查一段）之前，找到 Step 4 结尾处（`### Gate 2 · 关键节点闸`之前），在 Step 4 末尾追加：

```
> **N6 coverage accounting（mandatory）：**
> 1. **cheapest-first 顺序**：先单测（最快反馈）→ lint → typecheck → build → goal_condition 验收
> 2. **意图覆盖率检查**：逐条核对 N1 逼出的每条真实意图 → 对应 spec 章节存在？→ 对应 N6 验证命令存在？填写 spec.md「意图覆盖率追踪」表
> 3. **goal_condition 最终验收**：运行 front-matter `goal_condition` 指定的命令，输出与期望吻合则 N6 通过；否则重回 N5
```

- [ ] **Step 4：强化 N7 Vet 规则，加 clue-first 纪律**

找到：
```
> **N7 Vet 规则（mandatory）：** reviewer 在呈现任何 finding 前，必须亲自重读被引用的文件位置（不得只看子代理报告）。过滤三类噪音：
```
在该段落前插入一行：
```
> **N7 clue-first 纪律**：每个 finding 必须先有定位证据（`文件:行号` + 相关代码摘录或测试输出），才能提出诊断。禁止"可能是X导致"类无定位猜测。先找线索，再下结论；线索不足则标记为「待核实」而非直接列入 finding。
>
```

- [ ] **Step 5：批量确认 4 处改动都在**

```bash
grep -n "transcript-verifiable\|\/goal 集成\|coverage accounting\|clue-first 纪律" skills/spec/SKILL.md
```
期望：4 处匹配，行号分布在 Step 4 不同子节。

- [ ] **Step 6：Commit**

```bash
git add skills/spec/SKILL.md
git commit -m "feat(spec): N4 transcript-verifiable + N5 /goal 集成 + N6 coverage accounting + N7 clue-first 纪律"
```

---

## Task 5：registry.yaml — N4/N5/N6 元数据

**Files:**
- Modify: `skills/spec/registry.yaml`

- [ ] **Step 1：在 N4_tasks 节点下追加 done_criteria_requirement**

找到：
```
  N4_tasks:
    stage: 任务拆解
```
在 `stage: 任务拆解` 之后（与其他字段同级）插入：
```yaml
    done_criteria_requirement: transcript_verifiable
    # Done 标准必须 transcript-verifiable：验证命令将在 N5 中被执行并打印到对话；
    # Claude Code /goal 评估器（Haiku）只读 transcript，不能独立调工具。
    # 不可写语义判断类条件（"实现符合设计原则"）。
```

- [ ] **Step 2：在 N5_implement 节点下追加 goal_integration 块**

找到：
```
  N5_implement:
    stage: 实现
```
在 `stage: 实现` 之后插入：
```yaml
    goal_integration:
      opt_in: true            # Gate 1 询问用户是否启用 /goal；不强制
      condition_source: N4_tasks.done_criteria   # 从 N4 Done 标准提炼
      evaluator:
        claude-code:
          type: external      # 独立评估器，执行者与裁判分离，质量保证更强
          model: haiku        # 默认；可通过 Stop hook 替换为 sonnet/opus 或脚本
          reads: transcript_only  # 不调工具，只读对话记录
          customizable: true
        codex:
          type: self_evaluating   # Codex 自身判断完成，无独立裁判
          note: "自我评估偏乐观；条件须更加明确可量化"
```

- [ ] **Step 3：在 N6_verify 节点下追加 coverage_accounting 块**

找到：
```
  N6_verify:
    stage: 验证
```
在 `stage: 验证` 之后插入：
```yaml
    coverage_accounting:
      required: true
      cheapest_first_order: [unit_tests, lint, typecheck, build, goal_condition]
      checks:
        - intent_to_spec:  "N1 逼出意图 → spec 章节存在"
        - spec_to_test:    "spec 验收标准 → N6 验证命令存在"
        - goal_condition:  "front-matter goal_condition 最终验收"
```

- [ ] **Step 4：验证 YAML 结构合法（缩进无误）**

```bash
python3 -c "import yaml; yaml.safe_load(open('skills/spec/registry.yaml'))" && echo "YAML OK"
```
期望：`YAML OK`（无报错）。

- [ ] **Step 5：Commit**

```bash
git add skills/spec/registry.yaml
git commit -m "feat(spec): registry.yaml 增加 N4 transcript-verifiable 约束 + N5 /goal 集成元数据 + N6 coverage_accounting"
```

---

## 自检清单

计划写完后，逐项确认：

- [ ] spec-template.md 的 `goal_condition` 字段是否在 front-matter 里？
- [ ] N4 Done 标准是否同时要求"可机器执行"和"transcript-verifiable"？
- [ ] N6 覆盖率追踪表是否有"意图→spec→验证"三列？
- [ ] SKILL.md Step 0 是否有目标锚定步骤，且包含 transcript-verifiable 警告？
- [ ] SKILL.md Step 4 开头是否有三条内层纪律（cheapest/conclusion/clue）？
- [ ] SKILL.md N5 /goal 集成是否区分了 Claude Code（独立 Haiku 评估器）和 Codex（自我评估）？
- [ ] SKILL.md N7 是否有 clue-first 纪律段落？
- [ ] registry.yaml 的 N5 `goal_integration.opt_in: true`？（不强制启用）
- [ ] registry.yaml YAML 合法？

---

## 执行交接

计划已保存至 `Plans/2026-06-18-spec-fablecodex-fusion.md`。

**两种执行方式：**

**1. Subagent-Driven（推荐）** — 每个 Task 派一个新子代理执行，完成后本 agent 审查，快速迭代

**2. Inline Execution** — 在本 session 直接执行，按 Task 分批推进，每批结束后检查点
