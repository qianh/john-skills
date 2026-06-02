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
flavors: { N1: grill-with-docs, N3: openspec|sdd-development, N7: code-review }
execution_modes: { N3: subagent, N7: current-agent }
deps_check: { grill-with-docs: ok, taskmaster: "missing→install_required" }
status: drafting        # drafting → spec-locked → implementing → reviewing → done
created: <YYYY-MM-DD>
---

# <feature> · Spec

## 涉及服务 / 跨仓范围        <!-- NS，老项目强制；greenfield 标 N/A -->
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
- [ ] T-001 …

## 实现与测试记录          <!-- N5 -->

## 验证记录（DoD）         <!-- N6 -->
- [ ] 所有测试通过  [ ] lint  [ ] typecheck  [ ] build
- [ ] 新增逻辑有测试  [ ] 修改行为有回归  [ ] 无无关 diff  [ ] 无绕过测试

## 需求追溯矩阵            <!-- 仅风险 H；→ 裂变 traceability.md -->
| Requirement | Spec | Task | Test | Status |
|---|---|---|---|---|

## 审查记录                <!-- N7 -->

## 决策与归档（ADR）       <!-- N8 -->
- 为何这么设计 / 哪些方案被否 / 新增领域词 / 改了哪些边界 / 遗留 TODO：
```
