# 缺件安装策略（references/install.md）

## 铁律
- **绝不静默安装。** Gate 1 必须先把"装什么、来源、怎么卸载、前置条件"讲清楚。
- **用户在 Gate 1 选择安装后，即视为授权安装该缺件。** 后续自动执行核实、安装、验证，不再二次询问。
- **不允许回退到框架内置方法。** 缺推荐依赖时，要么安装，要么调整编排/切换执行器/用户先提供能力。

## 编排闸缺件选项
缺相关 spec 框架时**必须主动引导安装为首选**（不得默默跳过、不得退化成当前 agent 自做）。对每个 ❌ 缺失项，先完整呈现【装什么 + 已核实命令 + 来源 + 卸载方式 + 前置条件】，再向用户给出：
1. **安装并继续（推荐 · 首选）**：呈现下表已核实命令 → 用户确认即授权 → 自动执行安装 → 验证成功 → 回到 Step 3 重新体检。
2. **改编排**：移除该节点或改选另一个已可用的推荐风味（仅在用户明确选择不安装时）。
3. **暂停**：用户自行准备依赖后再继续。

## 安装命令（外部工具已于 2026-06-02 核实官方源；缺失 Skill 仍需现场核实）
下表三个外部工具的包名/命令已核实官方仓库与 npm；安装前仍应 `--version` 验证版本与前置依赖。缺失推荐 Skill 一栏需现场核实来源。

| 工具 | 价值 | 官方来源（已核实 2026-06-02） | 命令 |
|---|---|---|---|
| **OpenSpec** | 轻量 spec-driven 原生工具链 | github.com/Fission-AI/OpenSpec · npm `@fission-ai/openspec` | `npm install -g @fission-ai/openspec@latest`（Node ≥20.19.0；验 `openspec --version`；初始化 `openspec init`；卸载 `npm uninstall -g @fission-ai/openspec`） |
| **Taskmaster** | 任务依赖图、复杂度评分、多 worktree 调度 | github.com/eyaltoledano/claude-task-master · npm `task-master-ai` | `npm install -g task-master-ai`（验 `task-master --version`；卸载 `npm uninstall -g task-master-ai`；CC 集成有 core 模式约省 70% token） |
| **TDD Guard** | 阻断式 Red-Green-Refactor 硬约束 | github.com/nizos/tdd-guard · npm `tdd-guard` | `npm install -g tdd-guard`（或 `brew install tdd-guard`；**它是 Claude Code hook，靠 Write\|Edit\|MultiEdit 拦截；Codex 侧 hook 机制不同，必须先验证阻断真生效，否则不得声称 TDD Guard 已覆盖 N5**；卸载 `npm uninstall -g tdd-guard` 并移除 hook 配置） |
| **缺失的推荐 Skill** | 节点推荐技能，例如 `grill-with-docs`、`sdd-development`、`writing-plans` | 优先使用本机 skill-installer；否则搜索官方/仓库来源 | `<按技能来源现场核实>` |

### 核实流程
1. WebFetch / WebSearch 该工具**官方仓库或文档**，确认：准确包名、安装命令、版本、前置依赖（Node/Python 版本等）。
2. 把"将安装什么、如何卸载、前置条件"写给用户，作为 Gate 1 安装选项。
3. 用户在 Gate 1 选择安装后立即执行；执行后**验证安装成功**（命令可用 / 版本正确 / skill 可被发现）再继续。
4. 把核实到的命令回填本表，供下次复用。

> 跨执行器提醒：TDD Guard 依赖 hook，Codex 侧必须验证阻断是否真实生效；若不生效，不能声称 TDD Guard 已覆盖 N5。

## OpenSpec

已核实(2026-06-02)：repo github.com/Fission-AI/OpenSpec，npm `@fission-ai/openspec`，CLI `openspec`，需 Node ≥20.19.0。安装 `npm install -g @fission-ai/openspec@latest`，卸载 `npm uninstall -g @fission-ai/openspec`。安装后至少验证：
- `openspec --version` 可执行；
- `openspec init` 能初始化或校验一个最小 change proposal；
- 当前项目中不会覆盖已有 spec 文件。

## Taskmaster

已核实(2026-06-02)：repo github.com/eyaltoledano/claude-task-master，npm `task-master-ai`（独立 CLI，亦可作 MCP；AI 功能需模型 API key）。安装 `npm install -g task-master-ai`，卸载 `npm uninstall -g task-master-ai`。安装后至少验证：
- `task-master --version` / 任务拆解命令可执行；
- 能读取当前 spec 或计划文件（如 parse_prd）；
- 输出不会自动改写非目标文件。

## TDD Guard

已核实(2026-06-02)：repo github.com/nizos/tdd-guard，npm `tdd-guard`（亦有 Homebrew/PyPI）。安装 `npm install -g tdd-guard`，卸载 `npm uninstall -g tdd-guard` 并移除 hook 配置。**它是 Claude Code hook**，拦截 Write|Edit|MultiEdit；Codex 侧 hook 机制不同，安装前必须核实阻断在当前执行器是否真生效。安装后至少验证：
- 失败测试能阻断进入实现；
- 通过测试后允许继续；
- 阻断日志可被记录进 spec 的 N5/N7 章节。

## Missing Skill

缺失推荐 skill 时，优先使用本机已有 `skill-installer` 能力安装。若没有可用 installer：
- 只从官方或用户指定仓库安装；
- 安装到当前执行器对应的 skill 目录；
- 安装后重新列出技能并确认目标 skill 可被发现。
