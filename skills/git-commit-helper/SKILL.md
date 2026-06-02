---
name: git-commit-helper
description: 智能 Git 提交助手，自动分析未提交代码变更并生成中文总结，默认使用 feat 类型创建 commit，跳过 lint 检查（--no-verify），直接推送到远端。当用户需要提交代码、推送代码、或想了解代码变更内容时使用。支持用户指定提交类型覆盖默认行为。
---

# Git Commit Helper

自动化 Git 提交流程的智能助手，提供中文变更总结、智能类型检测和规范化提交。

## 核心功能

1. **变更分析**：生成未提交代码的中文总结
2. **快速提交**：默认使用 feat 类型，跳过 lint 检查
3. **安全提交**：不修改代码，仅执行 git 操作
4. **自动推送**：直接推送到远端仓库，无需用户确认

## 工作流程

### 标准流程

按以下步骤执行 Git 提交操作：

1. **检查 Git 状态**
   ```bash
   git status
   ```
   验证当前在 git 仓库中，检查是否有未提交的变更

2. **获取变更详情**
   ```bash
   git diff HEAD
   ```
   获取所有未提交的变更（包括已暂存和未暂存）

3. **生成中文变更总结**
   ```bash
   git diff HEAD | python /path/to/scripts/analyze_changes.py
   ```
   - 使用 `analyze_changes.py` 脚本分析变更
   - 输出包含：文件变更列表、类型分布、代码统计
   - 向用户展示此总结

4. **确定提交信息**
   - **默认类型**：使用 `feat` 作为提交类型
   - **用户指定**：如果用户明确指定类型（如 fix/docs），使用用户指定的类型
   - **描述内容**：基于变更总结，生成简洁的中文描述
   - Commit message 格式：`<type>: <description>`
     - type: feat（默认）或用户指定的类型
     - description: 简洁描述变更内容（中文）

5. **执行提交**
   ```bash
   # 暂存所有变更
   git add -A
   
   # 提交（跳过 pre-commit hooks，包括 lint 检查）
   git commit --no-verify -m "<type>: <description>"
   ```
   - 使用 `--no-verify` 标志跳过 Git hooks（包括 lint、格式化检查等）

6. **推送到远端**
   ```bash
   # 获取当前分支名
   BRANCH=$(git branch --show-current)
   
   # 推送到远端
   git push origin $BRANCH
   ```
   - 如果推送失败（如需要先 pull），提示用户处理冲突
   - 成功后，告知用户提交已完成并推送

## 脚本说明

### analyze_changes.py

分析 git diff 输出，生成结构化的中文变更总结。

**输入**：git diff 输出（通过 stdin 或文件）

**输出**：
```
本次提交共涉及 X 个文件的变更：

新增文件 (X 个)：
  + path/to/file1.py
  + path/to/file2.js

修改文件 (X 个)：
  ~ path/to/file3.py
  ~ path/to/file4.js

文件类型分布：
  • 源代码: X 个
  • 配置文件: X 个
  • 文档: X 个

代码变更统计：+X 行, -X 行
```

## 用户自定义

### 默认行为

- **提交类型**：默认使用 `feat`
- **跳过检查**：自动使用 `--no-verify` 跳过 lint、pre-commit hooks
- **无需确认**：分析完变更后直接提交并推送

### 指定提交类型

如果用户明确指定类型，覆盖默认的 feat：

```
用户：这是一个 fix，修复了登录问题
→ 使用 type = "fix"

用户：这是 docs，更新了 README
→ 使用 type = "docs"

用户：refactor 重构了数据库查询
→ 使用 type = "refactor"
```

**支持的类型**：feat, fix, docs, style, refactor, perf, test, build, ci, chore

### 指定提交信息

如果用户提供完整 commit message，直接使用：

```
用户：commit message 用 "fix: 修复用户登录验证逻辑错误"
→ 直接使用此 message，跳过自动生成
```

## 安全原则

- **只读分析**：分析脚本仅读取 git diff，不修改任何文件
- **跳过检查**：使用 `--no-verify` 跳过 pre-commit hooks（包括 lint、格式化等）
- **直接提交**：分析完变更后直接提交推送，无需用户确认
- **无破坏性**：不执行 `git reset`、`git rebase` 等危险操作
- **错误提示**：推送失败时提示用户，不自动处理冲突

## 响应格式

完成提交后，向用户报告：

```
📊 代码变更分析：

本次提交共涉及 3 个文件的变更：
新增文件 (1 个)：
  + src/auth/login.py
修改文件 (2 个)：
  ~ src/main.py
  ~ src/config.py

文件类型分布：
  • 源代码: 3 个

代码变更统计：+156 行, -23 行

✅ 提交成功！

提交信息：feat: 添加用户认证模块
已推送到远端分支: main
```

## 错误处理

### 不在 Git 仓库
```
❌ 当前目录不是 Git 仓库
请先初始化 Git 仓库：git init
```

### 没有变更
```
ℹ️  没有检测到未提交的代码变更
工作区是干净的
```

### 推送失败
```
⚠️  推送失败：remote rejected

可能原因：
- 远端有新提交，需要先 pull
- 没有推送权限
- 网络连接问题

建议操作：
git pull --rebase
# 解决冲突后
git push origin <branch>
```

## 注意事项

1. **跳过检查**：使用 `--no-verify` 会跳过所有 Git hooks，包括 lint、格式化、测试等
2. **默认类型**：除非用户明确指定，否则统一使用 `feat` 类型
3. **无需确认**：分析完变更后会直接提交并推送，无需等待用户确认
4. **分支保护**：如果目标分支有保护规则，推送可能失败
5. **首次推送**：如果是新分支首次推送，可能需要 `git push -u origin <branch>`
6. **用户优先**：用户明确指定的类型或 commit message 始终优先
