# spec.md 模板（Spec 主轴骨架）

> 这是单一事实源。每个节点往里追加/精炼**自己负责的章节**；没跑的节点章节标 `N/A`。
> 规模 H 时，标注「→ 裂变」的章节可移到附件（design.md / tasks.md / traceability.md），spec.md 留索引。

---

```markdown
---
# 引擎决策记录（自动写入；编排闸校准后定稿）
feature: <slug>
executor: claude-code | codex
scores:  { 规模: M, 风险: H, 项目: 老, 领域清晰度: 清晰 }
nodes:   [N1, N3, N4, N5, N6, N7]
flavors: { N1: grill-with-docs, N3: openspec|sdd-development, N6: requesting-code-review|code-review, N7: verification-before-completion }
execution_modes: { N3: subagent, N6: current-agent, N7: current-agent }
deps_check: { grill-with-docs: ok, taskmaster: "missing→install_required" }
status: drafting        # drafting → spec-locked → implementing → reviewing → done（done 条件见 SKILL.md Step 6）
spec_commit: ""         # N3 定稿时写入（git rev-parse --short HEAD），用于续跑漂移检测
goal_condition: ""      # Step 0 提炼：「当[可验证命令输出]为真时本次工作完成」；必须 transcript-verifiable；N7 最终验收准则
goal_condition_waived: false  # 仅用户明确选择无法提供可验证目标时改 true；N5/N7 必须记录原因
goal_condition_waiver_reason: ""
created: <YYYY-MM-DD>
---

# <feature> · Spec

## 项目意图与约束         <!-- NS-A Recon，老项目强制；greenfield 标 N/A -->
- 已决策 ADR（不再讨论的方向）：
- 活跃演进方向（git log 近 30 条推断）：
- 不可违背的约束（build/test/lint 命令 + 已知技术债）：
- Recon 读取的意图文档：

## 涉及服务 / 跨仓范围        <!-- NS-B Scope，老项目强制；greenfield 标 N/A -->
- 当前项目：<前端 / 后端 / 服务 / 库 + 路径>
- 关联服务 / 仓（角色 + 本功能改动面）：
  - <服务A>：
  - <服务B>：
- 关联 API / 配置 / DB / Apollo / 回调与 webhook 链路：
- 完整功能边界（确认覆盖全栈、非半边）：

## 问题与非目标            <!-- N1 -->
- 要解决什么痛点 / 用户是谁：
- 非目标（明确不做）：
- 失败路径：

## 领域词表                <!-- N2，未跑则 N/A -->

## 需求                    <!-- N3 -->
- 功能需求 FR-001 …
- 非功能需求 NFR-001 …

## 数据模型 / API / UI / 兼容 / 权限   <!-- N3，→ 裂变 design.md -->

## 验收标准                <!-- N3 -->
- AC-001 …

## 测试策略                <!-- N3 -->
- 单元 / 集成 / E2E / 手工验收：

## 任务拆解                <!-- N4，大任务 → 裂变 tasks.md -->

<!-- 每个任务必须包含以下 5 项，缺任意一项不得进入 N5 -->
### T-001 · <任务标题>
**为何做：** <影响和上下文，≤2句>
**文件路径：** `src/xxx.ts:42-67`（附当前代码摘录，≤15行）
**scope 边界：** in-scope: [文件A, 文件B] | out-of-scope: [不能碰的文件]
**有序步骤：**
  1. 做 X → 验证命令: `<命令>` → 期望输出: `<期望>`
  2. 做 Y → ...
**Done 标准（可机器执行 + transcript-verifiable）：** `<验证命令>` → 期望输出: `<期望文本>`
<!-- transcript-verifiable：命令须在 N5 执行中被打印；/goal 评估器（Haiku）只读 transcript，不能独立调工具 -->
**测试计划：** 新测试放 `tests/xxx.spec.ts`，参照 `tests/bar.spec.ts` 的写法
**逃生口：** 若遇到 <X 情况>，STOP 并上报，不得自行发挥

## 实现与测试记录          <!-- N5 -->

## 审查记录                <!-- N6 -->

## 验证记录（DoD）         <!-- N7 -->

<!-- cheapest-first 顺序；三态标记规则见 SKILL.md N7 coverage accounting -->
- [状态] 所有测试通过  [状态] lint  [状态] typecheck  [状态] build
- [状态] 新增逻辑有测试  [状态] 修改行为有回归  [状态] 无无关 diff  [状态] 无绕过测试
- [状态] goal_condition 成立（最终验收，见 front-matter）

### 意图覆盖率追踪        <!-- N7 coverage accounting -->
| 意图（N1 逼出） | spec 章节 | 实现任务 | N7 验证命令 + 期望输出 | 状态 |
|---|---|---|---|---|
| <意图1> | <章节> | <T-00x> | `<命令>` → `<期望>` | ⬜/✅ |

## Gate 审计记录           <!-- 每次 Gate 硬停通过后立即写入；缺记录不得标 done -->
| Gate | 时间 | 决策摘要 | 确认方式 |
|------|------|---------|---------|
| <Gate 名> | <ISO timestamp / N/A> | <决策摘要> | AskUserQuestion |
<!-- 按本轮编排涉及的 Gate 逐行添加；不涉及的标 N/A -->

## 节点执行追踪             <!-- 每节点完成时写入；调用证明 = 实际用的 tool call 类型 -->
| 节点 | 框架绑定 | 执行模式(Gate 1 选定) | 调用证明 | 状态 |
|------|---------|---------------------|---------|------|
| <N1> | <grill-with-docs> | <current-agent> | <Skill("grill-with-docs")> | ✅/❌ |

## 需求追溯矩阵            <!-- 仅风险 H；→ 裂变 traceability.md -->
| Requirement | Spec | Task | Test | Status |
|---|---|---|---|---|

## 决策与归档（ADR）       <!-- N8 -->
- 为何这么设计 / 哪些方案被否 / 新增领域词 / 改了哪些边界 / 遗留 TODO：
```
