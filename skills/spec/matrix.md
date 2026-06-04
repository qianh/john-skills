# 四维评分 + 编排矩阵

本文是引擎的"大脑"：先给请求四维打分，再用矩阵推出节点集与风味。**智能在评分、确定在组装**——同一张矩阵对不同项目吐出不同流程，这就是"动态而非写死"。

## 1. 四维评分 rubric

自动从需求文本推断初值；**老项目额外扫码库**；编排闸亮判分给用户一键改。

| 维度 | L / 清晰 / 新 | M | H / 模糊 / 老 |
|---|---|---|---|
| **规模/复杂度** | 单点改动、<2 文件、无新数据模型 | 单模块、新 API 或页面、有限新模型 | 跨多模块、新子系统、复杂数据模型 |
| **风险** | 纯展示、内部工具、可逆 | 一般业务、有数据写入 | 碰钱/支付/权限/账户/迁移/生产变更/不可逆 |
| **新老项目** | 新（greenfield，无既有码库） | — | 老（brownfield，需注入既有上下文） |
| **领域清晰度** | 词汇与边界明确、你熟 | — | 领域新、词汇未统一、边界不清 |

> 风险与领域清晰度最难从文本推准——**初值给保守一档**，靠编排闸校准。

## 2. 编排矩阵

**always-on 核心（最简 3 节点）**：`N1(轻拷问) → N5 → N6`。**老项目额外 always-on `NS`（跨服务发现，派子代理）——故老项目最简为 4 节点 `NS → N1 → N5 → N6`。**

**升级规则（逐条叠加）**：

| 触发条件 | 加挂 |
|---|---|
| 规模 ≥ M | +N3 +N4 +N7（→ 经典 6 节点） |
| 规模 H 或 新项目 | +N0 +N3 重档(Spec Kit) + spec 裂变附件 |
| 领域清晰度 = 模糊 | +N2 |
| 老项目 | **+NS（跨服务/跨仓发现，强制，派 subagent：CC=Explore / Codex=codebase-analyzer）** + N1=grill-with-docs + 扫码库；新项目 N1=grill-me（无既有服务则 NS=N/A） |
| 风险 H | N3/N7 进入对抗审查模式 + N5 选 TDD Guard + N8 强制 + 追溯矩阵 + 合并前 Human Approval |

## 3. 风味选择规则（dim → flavor）

| 节点 | 规则 |
|---|---|
| NS Scope | 老项目强制；派 subagent：CC=`Explore` / Codex=`codebase-analyzer`；扫关联前后端/服务/API/配置/DB/Apollo/回调链，结果写 spec.md；无关联服务则 N/A |
| N1 拷问 | 有码库→`grill-with-docs`；无码库→`grill-me` |
| N3 规格 | 规模 L/M→OpenSpec 工具；规模 H/新项目→Spec Kit / `sdd-development`（**`sdd-development` 仅 Codex；在 Claude Code 无 sdd 时，OpenSpec 作 env:any 主绑定承接全规模含 H**）；风险 H→对抗审查，支持 subagent/当前 agent 选择 |
| N4 拆解 | 默认→Superpowers plan / `writing-plans`；仅当用户明确要求时→Taskmaster；支持 subagent/当前 agent 选择 |
| N5 实现 | 默认 Superpowers TDD + worktree；风险 H→TDD Guard；多独立任务时支持 subagent/当前 agent 选择 |
| N7 审查 | 默认 code-review / `requesting-code-review`；风险 H→对抗审查；支持 subagent/当前 agent 选择 |

## 4. 缺件规则

- 任何节点没有可用的推荐 `skill` / `tool` / `agent` 绑定时，节点状态为 blocked，不得使用框架内置方法兜底。
- 可安装缺件必须在 Gate 1 亮出安装选项。用户选择安装后，自动按 `references/install.md` 核实、安装、验证，再继续。
- 不可自动安装的缺件必须提示用户改编排、切换执行器或先提供对应能力。

## 5. 具象编排示例（验证"新项目 3↔9+、老项目 4↔10+ 同源"）

| 场景（四维） | 编排出的流程 | 节点数 |
|---|---|---|
| 小 bug（规模L/风险L/老/清晰） | NS → N1轻 → N5 → N6 | 4 |
| 中功能（规模M/风险M/老/清晰） | NS → N1 → N3(OpenSpec) → N4 → N5 → N6 → N7 | 7 |
| 新产品（规模H/风险M/新/模糊） | N0 → N1(grill-me) → N2 → N3(Spec Kit) → N4(writing-plans) → N5 → N6 → N7 → N8 | 9 |
| 高风险（规模M-H/风险H/老/清晰） | NS + 全节点 + 对抗审查 + TDD Guard + subagent 选择闸 + 追溯矩阵 + 合并前人批 | 10+ |
