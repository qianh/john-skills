---
name: orchestrate
description: 多模型调度。默认使用简单模式（主控模型一路完成），显式开启后才使用动态路由模式（探索、方案、执行、验收、审查和修复）；小活由主控自己做。支持只出方案、只读审查、检查点恢复和诚实记账。当用户输入 /orchestrate、说“调度/编排多个模型”“让不同模型分工”“用 orch 跑这个任务”时触发。
---

# Orchestrate

先选择本次任务的运行模式，再执行对应流程。只有证据完整才报告完成；缺模型、授权、预算或人工证据时给出唯一交接步骤。

## 模式切换

两种模式是**任务级互斥开关**，一次任务开始后不在中途切换：

- **简单模式（`simple`）**：不开启动态路由，不调用 `orch.ts`，不启动外部 worker，也不读取路由配置。主控模型从理解、方案、实现、验收、复核到汇报一路完成；仍遵守项目规则、权限确认、敏感信息和不擅自 commit/push 等红线。简单模式没有独立 reviewer，主控必须把自审和测试结果明确标为主控证据。
- **动态路由模式（`dynamic`）**：使用本页下面的 `orch.ts` 流程，由配置决定各阶段模型、外壳、思考档位、预算和恢复策略。

选择优先级：用户本次明确指定（“简单模式”/“simple”、或“动态路由”/“dynamic”/“让不同模型分工”） > `ORCHESTRATE_MODE` 环境变量 > 默认 `simple`。环境变量只能取 `simple` 或 `dynamic`；出现其他值时先报配置错误，不要猜测。用户只说 `/orchestrate` 时走原有主控模型路径，默认使用 `simple`；只有明确要求动态路由、多模型分工，或显式设置 `ORCHESTRATE_MODE=dynamic` 才启动多模型流程。

模式选择要在任何模型调用或代码修改前亮明，例如：`运行模式：simple（主控模型一路完成，不启动动态路由）`。若选择简单模式，直接留在当前主控会话执行，不要运行下面的动态路由命令；若选择动态模式，才启动脚本。

用户可以直接在任务前加模式词切换：`用简单模式完成：<目标>`，或 `开启动态路由完成：<目标>`。这两个模式词只作用于当前任务，不写入全局配置；需要固定默认值时设置 `ORCHESTRATE_MODE`。

## 分流

- 简单模式：无论任务大小，都由主控模型自己完成，不外派、不启动脚本；仍然要跑适用的验收并做一次主控自审。
- 动态模式下的小活：两文件以内、方案明确、容易验证，或只是问答/小范围排查，由主控自己做，不外派。
- 动态模式下的大活：跨多个模块、新功能、设计取舍、需要独立审查，运行脚本。
- 用户只要审查时用 `review`，不要启动改代码的链路；只要方案用 `--plan-only`。
- 主控模型的能力影响分流，不设写死的 Sonnet/Opus 门槛，也不为了让每个模型都有活硬塞阶段。

## 运行

```bash
rtk proxy ~/.bun/bin/bun "${CLAUDE_SKILL_DIR}/scripts/orch.ts" run --mode dynamic --cwd "$PWD" "<目标>"
```

- Claude Code：使用 Bash 的 `run_in_background: true`，等完成通知后读取短汇总；不要用普通前台工具的十分钟默认上限跑完整任务。
- 其他宿主：给足前台等待时长，或使用宿主支持的后台任务；用 `status --run <目录>` 查看进度，不重复启动任务。
- stderr 是进度，stdout 是不超过 30 行的汇总。运行记录在实际 git-dir 的 `orchestrate/<run>/`（兼容 worktree）。运行期间不要手动改工作区；外部改动会计入作者并使旧证据失效。
- 会改代码的运行必须在 Git 仓库；拒绝冲突、稀疏检出、skip-worktree 和 submodule，不为支持它们偷偷改 index。

可选参数：

```bash
# 用户点名执行能力；未知名字立即报错
.../orch.ts run --mode dynamic --exec sonnet-5.5 "<目标>"
# 出完方案先停下
.../orch.ts run --mode dynamic --plan-only "<目标>"
# 已知金额上限；未知报价还需调用次数/总时长上限
.../orch.ts run --mode dynamic --budget 1.5 --max-calls 12 --max-minutes 60 "<目标>"
# 默认单份只读审查；--dual 才要求两个不同家族
.../orch.ts review --mode dynamic --author sonnet-5.5 --paths 'src/**' "<审查目标>"
.../orch.ts review --mode dynamic --base HEAD~1 --dual "<审查目标>"
```

只读审查默认看“安全 HEAD → 当前快照”，不执行验收、不自动修复；没给 `--author` 时不能声称审查独立于作者。非 Git 只读记录位于 `${XDG_STATE_HOME:-~/.local/state}/orchestrate/`，大文件/二进制等证据缺口如实标注。

## 正常流程

预检/锁/基线 → 一次廉价探索 → JSON 方案 → 授权闸门 → 执行 → 脚本验收 → 独立审查 → 人工核验（如有）→ 最终快照判定。

- 验收只来自 `plan.json` 的 command 标准，不从 Markdown、禁止项或全文猜命令。`rtk bun test`、`npx`、项目脚本都可作为单行命令。
- 验收失败先修，再审查；与审查 P1 共用默认两轮修复额度。仅成功建立的会话才续接；换人/安全配置变化新开会话，带完整接手上下文。
- 每次审查优先排除所有代码作者家族；找不到独立候选就交主控接管，不因内部 reviewer 缺失让整体任务卡死。
- review 格式无效只纠正一次。P1/P2、check 标准、越界路径、快照 id 都必须校验；格式不认识不等于无问题。
- “完成”需要最终验收、审查、当前快照一致，check 标准有人工证据，且无阻断性安全标记。独立 reviewer 是质量增强项，不是主控完成任务的硬前置；模型自报通过不是验收证据。

## 交接与恢复

汇总给出类型、原因、目标文件、JSON schema 路径和唯一下一步。主控只做指定阶段，不顺手做后续阶段。

| 类型 | 主控行动 |
|---|---|
| plan | 按 schema 写 `plan.json`，不是只写 Markdown |
| exec / fix | 按方案/失败证据/P1 改代码，不 commit |
| review | 只读审查，写指定的 `review-N.json` |
| check | 核验全部 check 标准，写 `checks.json`，包含 `checked_tree` 和逐条 evidence |
| permission | 向用户说明所需权限，明确同意后带对应 `--allow` 继续 |
| budget | 告知已知金额、未报价次数、耗时，用户同意追加后带新上限继续 |

```bash
rtk proxy ~/.bun/bin/bun "${CLAUDE_SKILL_DIR}/scripts/orch.ts" continue --mode dynamic --run "<目录>" --by "<主控实际能力名>"
rtk proxy ~/.bun/bin/bun "${CLAUDE_SKILL_DIR}/scripts/orch.ts" status --run "<目录>"
```

`--by` 必填，不冒填其他模型来绕过家族限制。中断恢复前必须确认旧 worker 已停；无法确认就拒绝推进。需要 stop 时，先告知用户，再显式运行 `stop --run <目录>`；仅核实过身份的进程组会被终止。exec 改变命令名等身份不明情况需人工核查，不能当作已停。

退出码：0 完成；1 卡住/P1；2 用法或配置错误；3 交给主会话；4 中断；5 待验证。done 运行不盲目重放；旧版本状态不自动迁移。

## 权限与安全

- 默认严格：当前没有通过真实五层隔离探针的 provider，默认不准入；可能全部阶段都交主控。不要为跑通而自行填 `unsafe_read` / `unsafe_exec`。
- 用户可在本机 `[safety]` 逐 provider 显式配置例外；汇总必须说明未隔离风险。pi 永远不能执行。配置中的沙箱参数不等于已验证的强制边界。
- `--allow` 只能记录用户授权。类别为 `deps`、`network:<域名,...>` / `network:*`、`publish`、`deploy`、`push`、`data`、`prod-config`。裸 `network` 报错；不同类别互不包含。主控不得依据方案自行加权限。
- 验收使用本机沙箱、最小环境和专用临时目录；没有支持的沙箱不裸跑。域名授权不能让不支持域名隔离的层全联网；`network:*` 才开放全部出站。
- 联网放开后，不声称 `.git` 只读能阻止发布/推送。凭证隔离、方案闸门与提示词不是完整的物理保证；macOS 钥匙串等仍待实测。
- 敏感路径读取前排除，符号链接不跟随；回传、diff、验收输出、账本、错误、汇总统一扫描。安全标记不因脱敏后能继续解析而消失。
- 不给任何 CLI 加 bypass、yolo、always-approve；只读角色移除 Bash/写工具并禁止子会话。
- 不 commit、不 push、不安装新依赖，除非用户对相应动作已明确授权。

## 配置与验证

配置为 `~/.config/orchestrate/models.conf` + `routing.toml`（可用 `ORCHESTRATE_HOME` 改目录）。两者全无可用示例并说明；只缺一个直接报错，不静默回退。`--sample` 显式使用示例。能力家族和支持 effort 来自 `references/catalog.toml`，本机 ID 不参与猜测。

```bash
rtk proxy "${CLAUDE_SKILL_DIR}/scripts/config.sh" preflight
rtk proxy "${CLAUDE_SKILL_DIR}/scripts/config.sh" init --propose
# 审阅提案；确认后才 --apply，现有配置先备份
rtk proxy "${CLAUDE_SKILL_DIR}/scripts/config.sh" init --apply
rtk proxy "${CLAUDE_SKILL_DIR}/scripts/config.sh" check
rtk proxy "${CLAUDE_SKILL_DIR}/scripts/config.sh" efforts --sample
rtk proxy "${CLAUDE_SKILL_DIR}/scripts/config.sh" isolation verify
rtk proxy "${CLAUDE_SKILL_DIR}/scripts/config.sh" cache clear
```

`isolation verify` 只跑合成本地探针，不调用模型、不检查真实凭证、不开放 provider。`isolation <provider>` 目前明确返回未验证；真实认证/读取/写入/Git/网络/凭证隔离需另行授权与实测。付费 probe 需要 `--confirm-paid`，也不能绕过安全准入。

## 汇报与账本

主控以汇总为主，按风险抽查 `plan.md`、最新 `review-N.json`、`verify.txt` 和本次增量；核对证据后再采信，不只转述 worker。

- `usage.jsonl` 每次调用含失败、重试、超时，金额来源区分 CLI 报价/价格估算/未知/确认未发送；未知不当零，有未知时合计显示 `≥`。
- Claude 累计报价按会话取差；优先原生增量字段。夹具验证不等于真实续接账单已验证。
- “本次 token 按 opus 单价重算”只是换单价估算，不是 Opus 单独完成任务的真实花费。
- `orch.ts report [--root <运行根目录>]` 按位置/能力汇总调用、失败率、已知金额和修复轮次。
- 4 类任务 × 3 组 × 2 次的真实 benchmark 需用户先给金额上限；未做之前不宣称已证实省钱。
