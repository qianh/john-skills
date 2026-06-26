---
name: video-gen
description: "Agnes AI 视频生成工具。触发条件：用户请求生成视频、AI 视频、文生视频、制作一段视频时使用。支持文字描述生成视频，默认 5 秒，可调整时长。USE WHEN: 生成视频, 视频生成, AI 视频, 文生视频, generate video, create video, make a video, video generation."
---

# Agnes AI 视频生成（video-gen）

基于 Agnes AI `agnes-video-v2.0` 模型，通过文字描述生成视频。视频生成为异步任务，通过脚本自动轮询直到完成。

## 前置条件

确认 `AGNES_API_KEY` 环境变量已设置：

```bash
echo $AGNES_API_KEY   # 应有输出，否则无法调用
```

## 调用方式

使用 `skills/video-gen/scripts/generate.sh` 脚本（自动提交任务 + 轮询 + 返回 URL）。

```bash
bash ~/.claude/skills/john/video-gen/scripts/generate.sh "prompt 内容" [时长秒数]
```

### 示例

```bash
# 默认 5 秒
bash ~/.claude/skills/john/video-gen/scripts/generate.sh "a golden retriever running on a beach at sunset"

# 指定 10 秒
bash ~/.claude/skills/john/video-gen/scripts/generate.sh "a golden retriever running on a beach at sunset" 10
```

脚本输出（完成后）：
```
提交成功，video_id: abc123
轮询中... (1/30)
轮询中... (2/30)
✅ 生成完成！
视频 URL: https://cdn.agnes-ai.com/videos/abc123.mp4
下载中...
已保存到: ~/Downloads/video_20260626_120000.mp4
```

## 时长预设

| 时长 | frames | fps | 命令 |
|------|--------|-----|------|
| 3 秒 | 81 | 24 | `"prompt" 3` |
| 5 秒（默认） | 121 | 24 | `"prompt"` 或 `"prompt" 5` |
| 10 秒 | 241 | 24 | `"prompt" 10` |
| 18 秒（最长） | 441 | 24 | `"prompt" 18` |

## 工作流程

1. 从用户消息提取视频描述，翻译为英文
2. 检查 `$AGNES_API_KEY` 是否设置
3. 运行 `generate.sh` 脚本（自动处理提交 + 轮询）
4. 脚本返回视频 URL 后，展示给用户

## 脚本位置

```
skills/video-gen/scripts/generate.sh
```

## 错误处理

| 错误 | 原因 | 处理 |
|------|------|------|
| `401 Unauthorized` | API Key 无效或未设置 | 提示用户检查 `AGNES_API_KEY` |
| 轮询超时（30次后仍 in_progress） | 任务耗时过长 | 提示用户稍后用 video_id 手动查询 |
| `status: failed` | 生成失败 | 调整 prompt 后重试 |
