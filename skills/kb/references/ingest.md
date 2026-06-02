# Ingest 操作流程

## 目标
将内容（本地笔记变更或外部 URL）摄入 Wiki，由 Claude 分析并写入/更新相应页面。

## 场景 A：摄入本地笔记变更

```bash
cd /Users/hong/John/ai/john-brain && python kb.py ingest
```

- 自动检测 `~/John/md/` 中自上次 ingest 以来新增或修改的文件
- 首次运行会扫描全部笔记

## 场景 B：摄入外部 URL

```bash
cd /Users/hong/John/ai/john-brain && python kb.py ingest <URL>
```

示例：
```bash
python kb.py ingest https://example.com/article
```

## 输出解读

- `写入: pages/concepts/xxx.md` — 新建或更新了 wiki 页面
- `→ 跳过（无需写入 wiki）` — 内容不值得写入（如格式文件等）
- `✓ Ingest 完成，索引已更新` — 操作成功完成

## 注意事项

- `~/John/md/` 原始笔记**不会被修改**
- Wiki 页面如已存在，Claude 会智能合并新旧内容
