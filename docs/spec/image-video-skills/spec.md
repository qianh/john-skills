---
feature: image-video-skills
executor: claude-code
scores: { 规模: L, 风险: L, 项目: 老, 领域清晰度: 清晰 }
nodes: [NS, N1, N5, N7]
flavors: { N1: grill-with-docs, N5: test-driven-development, N7: verification-before-completion }
execution_modes: { N1: current-agent, N5: current-agent, N7: current-agent }
deps_check: { grill-with-docs: ok, superpowers:test-driven-development: ok, superpowers:verification-before-completion: ok }
status: done
spec_commit: ""
goal_condition: "`ls skills/image-gen/SKILL.md skills/video-gen/SKILL.md` 两文件均存在，且 `grep -q \"agnes-image-2.1-flash\" skills/image-gen/SKILL.md && grep -q \"agnes-video-v2.0\" skills/video-gen/SKILL.md` 均退出码 0"
goal_condition_waived: false
goal_condition_waiver_reason: ""
created: 2026-06-26
---

# image-video-skills · Spec

## 项目意图与约束
- 已决策 ADR：skills 格式为 `skills/<name>/SKILL.md`，frontmatter 必须含 `name`/`description`
- 活跃演进方向：spec skill 持续迭代（近期主线）；plugin 结构稳定
- 不可违背约束：无 build/rebuild step；skill 以 `john:` namespace 暴露；无独立测试框架
- Recon 读取的意图文档：CLAUDE.md、skills/john/SKILL.md、skills/wechat-cli/SKILL.md、git log -15

## 涉及服务 / 跨仓范围
- 当前项目：john-skills Plugin Package（Claude Code 插件，`~/John/ai/john-skills`）
- 关联服务/仓：无跨仓依赖
- 外部 API：Agnes AI（`https://apihub.agnes-ai.com`）— 仅在 SKILL.md 中文档化，不在本仓修改
- 改动面：新增 `skills/image-gen/` 和 `skills/video-gen/` 两个目录各含一个 SKILL.md

## 问题与非目标

- **要解决的痛点**：在 Claude Code 会话中直接生成 AI 图片和视频，无需手动构造 API 请求
- **用户**：John，Claude Code 日常用户
- **真实意图**：
  1. `image-gen`：文生图，Claude 直接调 Agnes API 返回图片 URL，默认 1024×1024
  2. `video-gen`：文生视频，Claude 调 API 提交任务 → bash 脚本轮询 → 返回视频 URL，默认 5s(121frames@24fps)
  3. API Key 统一用 `AGNES_API_KEY` 环境变量
  4. image-gen 纯 inline curl（SKILL.md），video-gen 用 `scripts/generate.sh` bash 脚本
- **非目标**：img2img（图生图）暂不支持；bun/TypeScript 脚本；手动 curl 命令文档

**goal_condition 同步**（N1 后更新）：
`ls skills/image-gen/SKILL.md skills/video-gen/SKILL.md skills/video-gen/scripts/generate.sh` 三文件均存在，且 `grep -q "agnes-image-2.1-flash" skills/image-gen/SKILL.md && grep -q "agnes-video-v2.0" skills/video-gen/SKILL.md` 均退出码 0

## 领域词表
N/A

## 需求
N/A（规模 L，跳过 N3）

## 数据模型 / API / UI / 兼容 / 权限
N/A

## 验收标准
N/A

## 测试策略
N/A

## 任务拆解
N/A（规模 L，跳过 N4）

## 实现与测试记录

- `skills/image-gen/SKILL.md` — 文生图 skill，内联 curl，默认 1024×1024，$AGNES_API_KEY
- `skills/video-gen/SKILL.md` — 视频生成 skill，引用 generate.sh，默认 5s
- `skills/video-gen/scripts/generate.sh` — bash 脚本，提交+轮询+返回 URL，支持 3/5/10/18s 预设
- RED 验证：三文件不存在，exit 1 ✅
- GREEN 验证：三文件创建后，ls/grep/bash -n 全部通过 ✅

## 审查记录
N/A（规模 L，跳过 N6）

## 验证记录（DoD）

- ✅ 三文件存在：`ls skills/image-gen/SKILL.md skills/video-gen/SKILL.md skills/video-gen/scripts/generate.sh` → exit 0
- ✅ 模型名正确：`grep -q "agnes-image-2.1-flash" skills/image-gen/SKILL.md` → exit 0；`grep -q "agnes-video-v2.0" skills/video-gen/SKILL.md` → exit 0
- ✅ generate.sh 语法合法：`bash -n` → exit 0
- ✅ generate.sh 可执行：`-rwxr-xr-x`
- ✅ frontmatter name 正确：`name: image-gen`、`name: video-gen`
- ✅ AGNES_API_KEY 引用：image-gen(5处)、video-gen(4处)、generate.sh(6处)
- ✅ goal_condition 成立：完整命令 exit 0
- ⏭️ lint/typecheck/build：BLOCKED+waived(本项目无编译/lint框架，纯 markdown+bash 文件；用户 2026-06-26 确认豁免)

### 意图覆盖率追踪
| 意图（N1 逼出） | spec 章节 | 实现任务 | N7 验证命令 + 期望输出 | 状态 |
|---|---|---|---|---|
| image-gen 文生图，Bash 直调 API 返回 URL | 问题与非目标 | N5:image-gen/SKILL.md | `grep -q "agnes-image-2.1-flash" skills/image-gen/SKILL.md` → exit 0 | ✅ |
| video-gen 异步生成，bash 脚本轮询 | 问题与非目标 | N5:video-gen/SKILL.md+generate.sh | `bash -n skills/video-gen/scripts/generate.sh` → exit 0 | ✅ |
| API Key 用 AGNES_API_KEY | 问题与非目标 | N5:两文件+脚本 | `grep -c "AGNES_API_KEY" skills/image-gen/SKILL.md skills/video-gen/scripts/generate.sh` → 各>0 | ✅ |
| 默认 1024×1024 / 默认 5s(121frames) | 问题与非目标 | N5:两 SKILL.md | `grep "1024x1024" skills/image-gen/SKILL.md` / `grep "121" skills/video-gen/SKILL.md` → 有输出 | ✅ |

## Gate 审计记录
| Gate | 时间 | 决策摘要 | 确认方式 |
|------|------|---------|---------|
| Gate 1 编排闸 | 2026-06-26T00:00:00Z | 接受4节点(NS→N1→N5→N7)；四维L/L/老/清晰；N1/N5均选current-agent | AskUserQuestion |
| Gate 2 N3定稿 | N/A | 规模L跳过N3 | N/A |
| Gate 2 N6审查 | N/A | 规模L跳过N6 | N/A |

## 节点执行追踪
| 节点 | 框架绑定 | 执行模式(Gate 1 选定) | 调用证明 | 状态 |
|------|---------|---------------------|---------|------|
| NS   | advisor自读 | current-agent | native:Read+Bash | ✅ |
| N1   | grill-with-docs | current-agent | Skill("grill-with-docs") | ✅ |
| N5   | superpowers:test-driven-development | current-agent | Skill("superpowers:test-driven-development") | ✅ |
| N7   | superpowers:verification-before-completion | current-agent | Skill("superpowers:verification-before-completion") | ✅ |

## 需求追溯矩阵
N/A

## 决策与归档（ADR）

（N8 填充，本轮未编排 N8）
