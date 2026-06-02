---
name: music-downloader
description: >
  使用 yt-dlp 下载音乐（MP3 格式）。用户提供歌单（歌曲名称列表），自动搜索并下载。
  也支持直接提供 URL（单曲或播放列表链接）。
  支持平台：YouTube、SoundCloud、Bandcamp、Bilibili 等。
  触发场景："帮我下载这些歌"、"下载这个歌单"、"把这几首歌下载成 MP3"、
  "download these songs"、用户粘贴一个歌曲名称列表时使用。
---

# Music Downloader

使用 `scripts/download.sh` 封装 yt-dlp，支持按歌曲名称搜索下载或直接 URL 下载，输出 MP3 格式并自动嵌入封面和元数据。

## 核心工作流

1. **收集歌单**：用户提供歌曲名称列表（格式："艺人 歌名"，每行一首）
2. **写入临时文件**（若用户直接粘贴列表）或直接使用用户提供的文件
3. **运行脚本**批量下载
4. **报告**成功/失败数量和保存位置

## 用法

**从歌单文件批量下载（最常用）：**
```bash
bash scripts/download.sh --file playlist.txt
```

歌单文件格式（`playlist.txt`），每行一首，支持名称或 URL：
```
周杰伦 七里香
林俊杰 江南
# 这是注释，会被忽略
Taylor Swift Shake It Off
https://www.youtube.com/watch?v=xxx   # 也支持直接URL
```

**单曲按名称搜索：**
```bash
bash scripts/download.sh "周杰伦 七里香"
```

**直接下载 URL（单曲或播放列表）：**
```bash
bash scripts/download.sh "https://www.youtube.com/playlist?list=xxx"
```

**指定输出目录：**
```bash
bash scripts/download.sh --file playlist.txt --output ~/Music/我的歌单
```

## 默认输出

- 目录：`~/Music/Downloads/`
- 文件名：`<标题>.mp3`

## 搜索逻辑

- 歌曲名称 → 自动加 `ytsearch1:` 前缀，在 YouTube 搜索第一个结果
- 建议格式：`艺人名 歌曲名`（如 `周杰伦 稻香`），匹配更精准
- URL 开头（`http`）的条目直接下载，不走搜索

## 常见问题

**YouTube 下载报 JS challenge 错误：**
```bash
pip install -U yt-dlp  # 更新版本
```

**需要账号权限的内容（私有列表、会员内容等）：**
```bash
yt-dlp --cookies-from-browser chrome <URL>
```

**Bilibili 高音质需要登录：** 同上，传入浏览器 cookies。
