---
name: wechat-cli
description: "微信聊天记录查询与分析工具，基于本地 wechat-cli（v0.2.4）。触发条件：用户查询微信消息、聊天记录、联系人、群成员、收藏、统计分析、导出聊天记录，或需要获取微信新消息、未读消息时使用。支持关键词搜索、时间范围过滤、多种格式导出。USE WHEN: 查微信, 微信聊天记录, 微信联系人, 微信群, 导出微信, 微信搜索, wechat, WeChat messages, chat history, wechat contacts, wechat stats, new messages."
---

# WeChat CLI 微信命令行工具

基于 `wechat-cli`（v0.2.4），从命令行查询本地微信数据。所有数据本地处理，不上传云端。

## 前置条件（必读）

1. **首次使用必须初始化**：运行 `wechat-cli init` 提取密钥
2. **微信需要运行**：初始化时微信客户端必须处于运行状态
3. **全磁盘访问权限**（macOS）：在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中添加终端（Terminal / iTerm2）

## 命令路径

```bash
# wechat-cli 安装于 fnm 管理的 Node.js 全局路径
# 若终端未自动识别，使用完整路径：
$(npm prefix -g)/bin/wechat-cli
```

## 工作流程

### 1. 首次初始化

```bash
wechat-cli init                    # 自动检测微信数据目录
wechat-cli init --db-dir /path/to/WeChat/  # 手动指定目录
wechat-cli init --force            # 强制重新提取密钥
```

**完成后**生成 `~/.wechat-cli/all_keys.json`，后续命令才可用。

---

### 2. 查看最近会话（sessions）

```bash
wechat-cli sessions                # 所有最近会话
wechat-cli sessions --limit 10     # 最近 10 个会话
wechat-cli sessions --format json  # JSON 格式输出
```

---

### 3. 查看聊天记录（history）

```bash
wechat-cli history "张三"                          # 与张三的全部记录
wechat-cli history "AI交流群" --limit 50           # 最近 50 条
wechat-cli history "张三" --start-time "2026-01-01"  # 从指定日期起
wechat-cli history "张三" --end-time "2026-04-01"    # 到指定日期止
wechat-cli history "张三" --start-time "2026-03-01" --end-time "2026-04-01"
wechat-cli history "群名" --type text              # 仅文字消息
```

**--type 可选值**：`text`、`image`、`file`、`link`、`voice`（文字/图片/文件/链接/语音）

---

### 4. 搜索消息（search）

```bash
wechat-cli search "Claude"                      # 全局搜索关键词
wechat-cli search "Claude" --chat "AI交流群"    # 在指定聊天中搜索
wechat-cli search "你好" --limit 50             # 限制结果数量
```

---

### 5. 联系人查询（contacts）

```bash
wechat-cli contacts                  # 列出所有联系人
wechat-cli contacts --query "李"     # 按名字/备注搜索
```

输出包含：昵称、备注、微信号、个人签名。

---

### 6. 群聊成员（members）

```bash
wechat-cli members "AI交流群"        # 列出群成员
```

---

### 7. 消息统计（stats）

```bash
wechat-cli stats "张三"              # 统计与张三的消息
```

输出：消息数量、最活跃发送者、时间分布。

---

### 8. 导出聊天记录（export）

```bash
wechat-cli export "张三"                        # 导出为 Markdown（默认）
wechat-cli export "张三" --format text          # 纯文本格式
wechat-cli export "AI交流群" --output ./output/ # 指定输出目录
```

---

### 9. 收藏内容（favorites）

```bash
wechat-cli favorites                # 查看微信收藏列表
```

---

### 10. 未读消息（unread）

```bash
wechat-cli unread                   # 显示未读会话
```

---

### 11. 获取新消息（new-messages）

```bash
wechat-cli new-messages             # 获取自上次调用以来的新消息
```

适合用于轮询/监控场景。

---

## 常见使用场景

### 场景 A：分析某段时间的聊天内容

```bash
wechat-cli history "张三" --start-time "2026-04-01" --end-time "2026-04-27" | 分析内容...
```

### 场景 B：跨群搜索某个话题

```bash
wechat-cli search "项目进展" --limit 100
```

### 场景 C：导出对话存档

```bash
wechat-cli export "张三" --output ~/Documents/wechat-export/
```

### 场景 D：获取群里最活跃成员

```bash
wechat-cli stats "AI交流群"
```

---

## 输出格式参考

### sessions 输出示例

```
最近会话列表（共 25 条）：

1. 张三         最后消息：你好啊        2026-04-27 10:30
2. AI交流群     最后消息：Claude 4.5 出了！ 2026-04-27 09:15
3. 李四         最后消息：[图片]          2026-04-26 23:00
```

### history 输出示例

```
张三 的消息记录（共 150 条）：

[2026-04-27 10:30] 张三: 你好啊
[2026-04-27 10:31] 我: 你好，最近怎样？
[2026-04-27 10:35] 张三: 还不错，你呢？
```

---

## 错误处理

### 密钥文件不存在

```
密钥文件不存在: ~/.wechat-cli/all_keys.json
请运行: wechat-cli init
```

**解决**：确保微信运行，然后执行 `wechat-cli init`

### 没有全磁盘访问权限

```
PermissionError: [Errno 13] Permission denied
```

**解决**：系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 添加终端应用

### 未找到联系人/群聊

```
未找到联系人：张三
```

**解决**：确认名字/备注是否正确，尝试 `wechat-cli contacts --query "张"` 查找

---

## 安全说明

- 所有数据**本地处理**，不发送到任何云端服务
- 密钥存储于 `~/.wechat-cli/`，不在此 skill 中存储任何凭证
- 只读操作，不修改微信数据
