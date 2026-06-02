# Query 操作流程

## 目标
在 Wiki 中检索与问题最相关的页面，使用 Claude 综合作答，并附带来源引用。

## 执行步骤

1. 运行查询命令：
   ```bash
   cd /Users/hong/John/ai/john-brain && python kb.py query "<用户问题>"
   ```

2. 将命令输出直接呈现给用户（包含答案和参考来源）。

3. 如果输出提示"Wiki 中没有找到相关内容"，建议用户先运行 `/kb ingest`。

## 注意事项

- 若 Wiki 为空，先引导用户运行 ingest
- 输出中的"参考来源"路径相对于 `~/John/wiki/`
