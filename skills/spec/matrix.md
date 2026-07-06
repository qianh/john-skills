# 五维评分 + 编排矩阵

## 0. branch 模式覆写规则

触发 `/spec branch` 时，以下规则**覆盖**标准矩阵（第1-5节），优先级最高：

| 规则 | 值 |
|---|---|
| 规模上限 | 锁定 M（增量分析，即使 diff 很大也不升 H） |
| 任务类型 | 仍判定并写入 front-matter（供 N8 finding 标注参考），但**不应用 §2b 覆写**——branch 流程固定 |
| NS 替换 | diff-scan（`git diff main --name-only` + 涉及文件快速读），跳过跨服务发现和 NS-A Recon |
| N1 风味 | 固定 grill-with-docs（无论新老项目） |
| N8 | 必选（所有 finding 标注 `introduced` 本分支引入 / `pre-existing` 原有问题） |
| N4/N5 | 跳过（branch 针对已存在 diff，不做任务拆解与实现；改由 N3 记录改动、N6 审查、N7 验证现有 diff） |
| 其余节点 | 按标准矩阵升级规则，但规模上限 M 生效 |

---

本文是引擎的"大脑"：先给请求五维打分，再用矩阵推出节点集与风味。**智能在评分、确定在组装**——同一张矩阵对不同项目吐出不同流程，这就是"动态而非写死"。

## 1. 五维评分 rubric

自动从需求文本推断初值；**老项目额外扫码库**；编排闸亮判分给用户一键改。

### 1a. 任务类型（第一判定维度，决定流程形态）

本节只负责判型；对编排的影响统一由 §2b 覆写表定义（风味细则见 §3）。

| 类型 | 文本信号（示例） |
|---|---|
| **feature**（默认） | 新增 / 支持 / 实现某功能 |
| **bugfix** | 修复 / 报错 / 异常 / 崩溃 / 不生效 / 回归了 |
| **refactor** | 重构 / 整理 / 拆分 / 去重 / 迁移结构（行为不变） |
| **perf** | 性能 / 慢 / 卡顿 / 内存 / 耗时 / 优化速度 |
| **security** | 安全 / 漏洞 / 越权 / 注入 / 密钥泄露 |
| **spike** | 调研 / 可行性 / 方案对比 / 试验一下 |

> 判不准时默认 feature，并在编排闸让用户校准——任务类型放在 Gate 1 判分的首位亮出。

### 1b. 四个刻度维度

| 维度 | L / 清晰 / 新 | M | H / 模糊 / 老 |
|---|---|---|---|
| **规模/复杂度** | 单点改动、<2 文件、无新数据模型 | 单模块、新 API 或页面、有限新模型 | 跨多模块、新子系统、复杂数据模型 |
| **风险** | 纯展示、内部工具、可逆 | 一般业务、有数据写入 | 碰钱/支付/权限/账户/迁移/生产变更/不可逆 |
| **新老项目** | 新（greenfield，无既有码库） | — | 老（brownfield，需注入既有上下文） |
| **领域清晰度** | 词汇与边界明确、你熟 | — | 领域新、词汇未统一、边界不清 |

> 风险与领域清晰度最难从文本推准——**初值给保守一档**，靠编排闸校准。

## 2. 编排矩阵

**always-on 核心（最简 3 节点）**：`N1(轻拷问) → N5 → N7`。**老项目额外 always-on `NS`（跨服务发现，派子代理）——故老项目最简为 4 节点 `NS → N1 → N5 → N7`。**（任务类型覆写见 §2b。）

### 2a. 升级规则（逐条叠加）

| 触发条件 | 加挂 |
|---|---|
| 规模 ≥ M | +N3 +N4 +N6（→ 经典 6 节点） |
| 规模 H 或 新项目 | +N0 +N3 重档(Codex=sdd-development / CC=OpenSpec 承全规模含 H) + spec 裂变附件 + N8 归档 |
| 领域清晰度 = 模糊 | +N2 |
| 老项目 | **+NS（跨服务/跨仓发现，强制，派 subagent：CC=Explore / Codex=codebase-analyzer）** + N1=grill-with-docs + 扫码库；新项目 N1=grill-me（无既有服务则 NS=N/A） |
| 风险 H | N3/N6 进入对抗审查模式 + N5 选 TDD Guard + N8 强制 + 追溯矩阵 + 合并前 Human Approval |
| 风险 H | N5 executor_model 从 tier_mid 升为 tier_high（廉价 executor 升格与 advisor 同级） |

### 2b. 任务类型覆写（在 §2a 叠加之后应用；冲突时覆写优先）

| 类型 | 覆写 |
|---|---|
| **bugfix** | N1 风味＝诊断流（复现→根因，见 §3）；N5 回归测试先行（红＝先写复现该 bug 的失败测试）；N3/N4 默认不加挂（仅当根因揭示规格/设计问题时按 §2a 升级）；goal_condition 模板＝「复现测试转绿 且 全量回归通过」 |
| **refactor** | +N6（必选；加挂风味见 §3）；goal_condition 模板＝「行为不变：既有测试全绿 + lint/typecheck 通过 + 无未获准的公共 API 变化」 |
| **perf** | goal_condition 必须含基准命令＋数值阈值（如「基准脚本 p95 < 200ms」）；N7 验证须含改前/改后基准对比 |
| **security** | 风险维度强制置 H（连带触发 §2a 全部风险 H 规则：对抗审查 / TDD Guard / 追溯矩阵 / 合并前人批；N6 加挂风味见 §3） |
| **spike** | 流程缩为 `NS → N1 → N8`：无 N3/N4/N5/N6/N7（不写生产代码，不做实现验证）；N8 归档结论、被否方案与后续建议；spike 结论要转正式需求时另起一轮 /spec |
| **feature** | 无覆写 |

## 3. 风味选择规则（dim → flavor）

| 节点 | 规则 |
|---|---|
| NS Scope | 老项目强制；派 subagent：CC=`Explore` / Codex=`codebase-analyzer`；扫关联前后端/服务/API/配置/DB/Apollo/回调链，结果写 spec.md；无关联服务则 N/A |
| N1 拷问/诊断 | **任务类型=bugfix→诊断流**：CC=`superpowers:systematic-debugging`（默认只跑它；仅需全环插桩「复现→最小化→插桩→回归」时改用 `diagnose`，二选一不并跑）、Codex=`systematic-debugging`；否则：有码库→`grill-with-docs`；无码库→`grill-me` |
| N3 规格 | CC 装有 OpenSpec skill 时优先 `openspec-propose`；规模 L/M→OpenSpec 工具；规模 H/新项目→`sdd-development`(**仅 Codex**)；**Claude Code 无 sdd 时，OpenSpec 作 env:any 主绑定承接全规模含 H**；风险 H→对抗审查，支持 subagent/当前 agent 选择；验收标准推荐 EARS 格式（见 spec-template） |
| N4 拆解 | 默认→Superpowers plan / `writing-plans`；仅当用户明确要求时→Taskmaster；支持 subagent/当前 agent 选择 |
| N5 实现 | 默认 Superpowers TDD + worktree；风险 H→TDD Guard；N3 用 OpenSpec 产出 change 时可辅以 `openspec-apply-change`；多独立任务时支持 subagent/当前 agent 选择 |
| N6 审查 | 默认 code-review / `requesting-code-review`；风险 H 或任务类型=security→加挂 `security-review`；任务类型=refactor→加挂 `simplify`；风险 H→对抗审查；支持 subagent/当前 agent 选择 |
| N8 归档 | N3 用了 OpenSpec→`openspec-archive-change`（/spec iterate 的 delta 回写主 spec 用 `openspec-sync-specs`）；否则 native current-agent 写 ADR/CONTEXT |

## 4. 缺件规则

- 任何节点没有可用的推荐 `skill` / `tool` / `agent` 绑定时，节点状态为 blocked，不得使用框架内置方法兜底。
- 可安装缺件必须在 Gate 1 亮出安装选项。用户选择安装后，自动按 `references/install.md` 核实、安装、验证，再继续。
- 不可自动安装的缺件必须提示用户改编排、切换执行器或先提供对应能力。

## 5. 具象编排示例（验证"新项目 3↔9+、老项目 4↔10+ 同源"）

| 场景（五维） | 编排出的流程 | 节点数 |
|---|---|---|
| 小 bug（bugfix/规模L/风险L/老/清晰） | NS → N1(systematic-debugging 复现+根因) → N5(回归先行 TDD) → N7 | 4 |
| 技术调研（spike/老） | NS → N1 → N8（结论与被否方案归档） | 3 |
| 中功能（规模M/风险M/老/清晰） | NS → N1 → N3(OpenSpec) → N4 → N5 → N6 → N7 | 7 |
| 新产品（规模H/风险M/新/模糊） | N0 → N1(grill-me) → N2 → N3(OpenSpec/sdd) → N4(writing-plans) → N5 → N6 → N7 → N8 | 9 |
| 高风险（规模H/风险H/老/模糊） | NS + 全节点(N0…N8 含 N2) + 对抗审查 + TDD Guard + subagent 选择闸 + 追溯矩阵 + 合并前人批 | 10 |
