#!/usr/bin/env bash
# Music downloader using yt-dlp
# Supports song names (search) and direct URLs
#
# Usage:
#   ./download.sh "歌曲名 艺人"             # 按名称搜索并下载
#   ./download.sh --file playlist.txt       # 从歌单文件批量下载
#   ./download.sh <URL>                     # 直接下载URL（单曲/播放列表）
#   ./download.sh --output ~/Music "歌名"   # 指定输出目录

set -e

OUTPUT_DIR="${HOME}/Music/Downloads"
ITEMS=()   # 可以是搜索关键词或URL
FILE_MODE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output|-o)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --file|-f)
      FILE_MODE="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage:"
      echo "  download.sh \"艺人 歌名\"               # 搜索下载"
      echo "  download.sh --file playlist.txt        # 歌单文件批量下载"
      echo "  download.sh <URL>                      # 直接下载URL"
      echo "  download.sh --output <dir> ...         # 指定输出目录"
      echo ""
      echo "歌单文件格式（每行一首，支持名称或URL，# 开头为注释）："
      echo "  周杰伦 七里香"
      echo "  林俊杰 江南"
      echo "  https://www.youtube.com/watch?v=..."
      exit 0
      ;;
    *)
      ITEMS+=("$1")
      shift
      ;;
  esac
done

# Load from file
if [[ -n "$FILE_MODE" ]]; then
  if [[ ! -f "$FILE_MODE" ]]; then
    echo "Error: File not found: $FILE_MODE"
    exit 1
  fi
  while IFS= read -r line; do
    line="${line%%#*}"        # strip comments
    line="${line#"${line%%[![:space:]]*}"}"  # ltrim
    line="${line%"${line##*[![:space:]]}"}"  # rtrim
    [[ -n "$line" ]] && ITEMS+=("$line")
  done < "$FILE_MODE"
fi

if [[ ${#ITEMS[@]} -eq 0 ]]; then
  echo "Error: 请提供歌曲名称、URL 或歌单文件。"
  echo "Usage: download.sh --file playlist.txt"
  echo "       download.sh \"周杰伦 七里香\""
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "输出目录: $OUTPUT_DIR"
echo "共 ${#ITEMS[@]} 首..."
echo ""

# yt-dlp options for MP3 download
YT_DLP_OPTS=(
  --extract-audio
  --audio-format mp3
  --audio-quality 0
  --output "$OUTPUT_DIR/%(title)s.%(ext)s"
  --embed-thumbnail
  --embed-metadata
  --add-metadata
  --no-playlist-reverse
  --ignore-errors
  --no-update
  --progress
)

SUCCESS=0
FAILED=0

# detect_need_cookies: returns true if output contains login/bot/captcha errors
needs_cookies() {
  echo "$1" | grep -qiE "Sign in to confirm|bot|age.restrict|login|private|members only|captcha|HTTP Error 429"
}

for item in "${ITEMS[@]}"; do
  # 判断是URL还是搜索关键词
  if [[ "$item" == http* ]]; then
    query="$item"
    echo "→ [URL] $item"
  else
    query="ytsearch1:${item}"
    echo "→ [搜索] $item"
  fi

  # 先不带 cookies 尝试
  set +e
  output=$(yt-dlp "${YT_DLP_OPTS[@]}" "$query" 2>&1)
  exit_code=$?
  set -e
  echo "$output"

  if [[ $exit_code -eq 0 ]]; then
    ((SUCCESS++))
  elif needs_cookies "$output"; then
    # 失败且是登录/bot 验证类错误，自动用 safari cookies 重试
    echo "  ↻ 需要验证，使用 cookies 重试..."
    if yt-dlp --cookies-from-browser chrome "${YT_DLP_OPTS[@]}" "$query"; then
      ((SUCCESS++))
    else
      echo "  ✗ 失败: $item"
      ((FAILED++))
    fi
  else
    echo "  ✗ 失败: $item"
    ((FAILED++))
  fi
  echo ""
done

echo "完成: 成功 $SUCCESS 首，失败 $FAILED 首"
echo "文件保存至: $OUTPUT_DIR"
