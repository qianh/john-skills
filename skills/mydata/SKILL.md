---
name: mydata
description: 个人数据画像 skill。将 Claude Code 对话、Codex 对话、Obsidian 笔记综合处理，通过 Ollama embedding 匹配，增量更新 ~/John/wiki/pages/self/ 下的六个个人画像页面。触发条件：用户输入 /mydata ingest、/mydata profile、/mydata status，或对话中出现"我之前讨论过"、"我的习惯"、"我对X的看法"等语义时。
---

# 个人数据画像 (mydata)

实现脚本：`~/.claude/PAI/Tools/mydata/ingest.ts`  
画像目录：`~/John/wiki/pages/self/`  
数据来源：`~/.claude/transcripts/` + `~/.claude/projects/`（Claude）、`~/.codex/sessions/`（Codex）、`~/John/md/`（Obsidian）

## 命令路由

| 用户命令 | 执行 | 说明 |
|----------|------|------|
| `/mydata ingest` | `bun ingest.ts ingest` | 处理增量数据，更新画像 |
| `/mydata ingest --full` | `bun ingest.ts ingest --full` | 全量重处理（初次或修复） |
| `/mydata profile` | `bun ingest.ts profile` | 展示当前画像内容 |
| `/mydata status` | `bun ingest.ts status` | 显示水印和数据统计 |

## 执行方式

```bash
cd ~/.claude/PAI/Tools/mydata && bun ingest.ts <command> [--full]
```

## 自动触发

对话中检测到以下语义时，读取相关 self/ 页面作为上下文：
- "我之前讨论过 / 研究过 / 做过..."
- "我的习惯 / 偏好 / 风格是..."
- "我对 X 的看法 / 理解 / 想法..."
- "根据我的经验 / 背景..."

读取方式：`Read ~/John/wiki/pages/self/<最相关页面>.md`

## 依赖检查

运行前确认：
1. Ollama 运行中：`curl -s http://localhost:11434/api/tags`
2. 模型已拉取：`ollama list | grep nomic-embed-text`
