# 登记表机制（人读版 · references/registry.md）

`registry.yaml` 是这套框架吸收"跨执行器命令名差异"的地方。**SKILL.md 正文不写死任何命令名**，一律来这里查。

## 为什么这样设计
同一个 Spec 操作，在 Claude Code 和 Codex 里的技能名不同（例如拆解：CC 是 `superpowers:writing-plans`，Codex 侧首选 `planning-with-files`、备选 `writing-plans`）。若把命令名写进正文，就无法跨执行器共享同一份逻辑。**把差异关进数据层（registry），正文保持执行器无关。**

## 运行时怎么解析
1. **认环境**：读环境变量 `CLAUDECODE`——存在 → `claude-code`；否则 → `codex`。
2. **取候选**：对每个节点，从 `registry.yaml` 的 `invocations` 里按优先级取"当前环境"的候选。
3. **探在不在**：逐一检查候选 `skill` / `tool` 是否实际可调用（✅/❌）。第一个可用就绑定；都不可用且没有被用户选择的 native agent 模式 → 标记 `blocked: install_required`。
4. **亮给用户**：体检结果在编排闸展示，缺失项给安装/改编排/暂停选项；支持 subagent 的节点给 subagent/当前 agent 选择。

### 容错关键
即便第 1 步认错环境，第 3 步"探在不在"也会兜底——另一执行器的技能在当前环境根本调不动，自然滑到下一候选。**所以认环境只是加速，不是单点故障。**

没有可用推荐候选时，不得降级为内嵌方法；必须安装、改编排、暂停，或选择该节点显式允许的 native agent 模式。

## 维护
- 技能名、可选工具的存在性应在 Gate 1 现场体检；若要持久记录核实状态，在 `registry.yaml` 增加显式字段后再写文档承诺。
- 新增节点风味时：在 `registry.yaml` 加一条 `invocations` 候选即可，**不动 SKILL.md 正文**。

## 字段速查
- `env`: `claude-code` | `codex` | `any`
- `kind`: `skill`（调技能）| `tool`（外部工具）| `agent`（派子代理，如 NS 的 `Explore`/`codebase-analyzer`）
- `name`: 调用名或工具名
- `flavor_rule`: 该节点按维度选风味的规则（与 `matrix.md` §3 一致）
- `install`: 缺失时对应的安装项；具体核实和安装步骤见 `references/install.md`
- `subagent`: 该节点是否支持 subagent、推荐角色、用户选择要求，以及是否允许 native current-agent / native subagent
- `goal_condition_sync_required`: 节点出口门是否必须同步 front-matter `goal_condition`
- `goal_integration.ask_timing`: `/goal` opt-in 的询问节点；当前只允许 N5 前、N4 后
- `invalidates_on_rerun`: 节点重跑后必须作废并重跑的后续节点
- `requires_after_last_run`: 当前节点通过前，指定节点必须晚于最近一次实现运行
