# Lint 操作流程

## 目标
检查 Wiki 健康度：失效链接、孤立页面等问题。

## 执行

健康检查：
```bash
cd /Users/hong/John/ai/john-brain && python kb.py lint
```

自动修复简单问题（将孤立页面添加到 index.md）：
```bash
cd /Users/hong/John/ai/john-brain && python kb.py lint --fix
```

## 输出解读

- `✓ Wiki 健康检查通过` — 无问题
- `❌ 失效链接: A → B` — 页面 A 中有指向不存在页面 B 的链接
- `⚠️  孤立页面: X` — 页面 X 没有被任何其他页面引用

## 建议频率

每次大量 ingest 后运行一次 lint，保持 Wiki 结构整洁。
