---
name: kb
description: 个人知识库 agent，基于 Karpathy LLM Wiki 模式。触发条件：用户输入 /kb query "问题"、/kb ingest、/kb ingest <URL>、/kb lint、/kb lint --fix 时使用此 skill。管理位于 ~/John/wiki/ 的结构化 Wiki，支持查询综合答案、摄入本地笔记和外部 URL、Wiki 健康检查三种操作。
---

# 知识库 Agent (kb)

Python 后端：`/Users/hong/John/ai/john-brain/kb.py`  
Wiki 目录：`/Users/hong/John/wiki/`  
笔记目录：`/Users/hong/John/md/`

## 操作路由

根据用户命令加载对应参考文档并执行：

| 用户命令 | 参考文档 | Bash 命令 |
|----------|----------|-----------|
| `/kb query "问题"` | [references/query.md](references/query.md) | `python kb.py query "问题"` |
| `/kb ingest` | [references/ingest.md](references/ingest.md) | `python kb.py ingest` |
| `/kb ingest <URL>` | [references/ingest.md](references/ingest.md) | `python kb.py ingest <URL>` |
| `/kb lint` | [references/lint.md](references/lint.md) | `python kb.py lint` |
| `/kb lint --fix` | [references/lint.md](references/lint.md) | `python kb.py lint --fix` |

## 执行方式

```bash
cd /Users/hong/John/ai/john-brain && python kb.py <command> [args]
```

执行前确认 `ANTHROPIC_API_KEY` 环境变量已设置。
