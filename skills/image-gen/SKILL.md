---
name: image-gen
description: "Agnes AI 图片生成工具。触发条件：用户请求生成图片、画一张图、AI 画图、文生图、生成一张 XX 图片时使用。支持文字描述生成图片，默认 1024×1024 正方形，可指定其他尺寸。USE WHEN: 生成图片, 画图, AI 画图, 文生图, generate image, draw, create image, make a picture, image generation."
---

# Agnes AI 图片生成（image-gen）

基于 Agnes AI `agnes-image-2.1-flash` 模型，通过文字描述生成图片。

## 前置条件

确认以下环境变量已设置：

```bash
echo $AGNES_API_KEY    # 必填，否则无法调用
echo $AGNES_BASE_URL   # 可选，默认 https://apihub.agnes-ai.com
```

## 调用方式

Claude 直接通过 Bash 工具调用 Agnes API，返回图片 URL。

### 标准调用（默认 1024×1024）

```bash
curl -s -X POST "${AGNES_BASE_URL:-https://apihub.agnes-ai.com}/v1/images/generations" \
  -H "Authorization: Bearer $AGNES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.1-flash",
    "prompt": "<用户描述的内容>",
    "size": "1024x1024",
    "extra_body": {
      "response_format": "url"
    }
  }'
```

成功响应示例：
```json
{
  "data": [
    { "url": "https://cdn.agnes-ai.com/images/xxx.png" }
  ]
}
```

用 `jq` 提取 URL：
```bash
curl ... | jq -r '.data[0].url'
```

### 指定尺寸

用户提到"横版/竖版/宽屏"时覆盖 `size`：

| 场景 | size |
|------|------|
| 默认（正方形） | `1024x1024` |
| 横版 16:9 | `1344x768` |
| 竖版 9:16 | `768x1344` |
| 横版 4:3 | `1024x768` |

## 工作流程

1. 从用户消息提取图片描述，翻译为英文（模型对英文 prompt 效果更好）
2. 检查 `$AGNES_API_KEY` 是否设置
3. 执行上方 curl 命令，提取 URL：`IMG_URL=$(curl ... | jq -r '.data[0].url')`
4. 下载到本地 `~/Downloads/`：
   ```bash
   FILENAME="image_$(date +%Y%m%d_%H%M%S).png"
   curl -sL "$IMG_URL" -o ~/Downloads/"$FILENAME"
   ```
5. 用 Markdown 图片语法展示本地路径：`![生成结果](~/Downloads/FILENAME)`
6. 告知用户图片已保存到 `~/Downloads/FILENAME`，并说明尺寸和描述

## 错误处理

| 错误 | 原因 | 处理 |
|------|------|------|
| `401 Unauthorized` | API Key 无效或未设置 | 提示用户检查 `AGNES_API_KEY` |
| `400 Bad Request` | 参数格式错误 | 检查 `size` 格式（宽x高，如 `1024x1024`） |
| 响应无 `data[0].url` | 返回 base64 而非 URL | 确认 `extra_body.response_format` 为 `"url"` |
| 超时 | 生成耗时较长 | 建议 curl 加 `--max-time 120` |
