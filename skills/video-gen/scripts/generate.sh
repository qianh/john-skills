#!/usr/bin/env bash
# Agnes AI 视频生成脚本
# 提交任务 → 轮询直到完成 → 输出视频 URL
#
# Usage:
#   ./generate.sh "prompt 内容"           # 默认 5 秒
#   ./generate.sh "prompt 内容" 10        # 指定 10 秒

set -e

PROMPT="${1:-}"
DURATION="${2:-5}"

if [[ -z "$PROMPT" ]]; then
  echo "Error: 请提供 prompt 内容"
  echo "Usage: ./generate.sh \"prompt\" [秒数]"
  exit 1
fi

if [[ -z "$AGNES_API_KEY" ]]; then
  echo "Error: AGNES_API_KEY 未设置"
  echo "请在 shell 中执行: export AGNES_API_KEY=your_key"
  exit 1
fi

API_BASE="${AGNES_BASE_URL:-https://apihub.agnes-ai.com}"

# 时长 → frames（8n+1 规则，fps=24）
case "$DURATION" in
  3)  FRAMES=81  ;;
  5)  FRAMES=121 ;;
  10) FRAMES=241 ;;
  18) FRAMES=441 ;;
  *)
    # 通用计算：target = duration * 24，取最近的 8n+1
    RAW=$(( DURATION * 24 ))
    N=$(( (RAW - 1) / 8 ))
    FRAMES=$(( N * 8 + 1 ))
    if [[ $FRAMES -gt 441 ]]; then
      echo "Warning: 时长超过最大值 18 秒，自动截断至 441 frames"
      FRAMES=441
    fi
    ;;
esac

echo "提交视频生成任务..."
echo "  Prompt: $PROMPT"
echo "  时长: ~${DURATION}s (${FRAMES} frames @ 24fps)"
echo ""

# 提交任务
RESPONSE=$(curl -s -X POST "${API_BASE}/v1/videos" \
  -H "Authorization: Bearer $AGNES_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"agnes-video-v2.0\",
    \"prompt\": $(jq -Rn --arg p "$PROMPT" '$p'),
    \"num_frames\": $FRAMES,
    \"frame_rate\": 24
  }")

VIDEO_ID=$(echo "$RESPONSE" | jq -r '.video_id // empty')
if [[ -z "$VIDEO_ID" ]]; then
  echo "Error: 提交失败，响应："
  echo "$RESPONSE" | jq .
  exit 1
fi

echo "提交成功，video_id: $VIDEO_ID"
echo ""

# 轮询直到完成
MAX_POLLS=30
INTERVAL=10
for i in $(seq 1 $MAX_POLLS); do
  echo "轮询中... ($i/$MAX_POLLS)"

  STATUS_RESP=$(curl -s "${API_BASE}/agnesapi?video_id=${VIDEO_ID}" \
    -H "Authorization: Bearer $AGNES_API_KEY")

  STATUS=$(echo "$STATUS_RESP" | jq -r '.status // empty')

  case "$STATUS" in
    completed)
      VIDEO_URL=$(echo "$STATUS_RESP" | jq -r '.remixed_from_video_id // empty')
      FILENAME="video_$(date +%Y%m%d_%H%M%S).mp4"
      SAVE_PATH=~/Downloads/"$FILENAME"
      echo ""
      echo "✅ 生成完成！"
      echo "视频 URL: $VIDEO_URL"
      echo "下载中..."
      curl -sL "$VIDEO_URL" -o "$SAVE_PATH"
      echo "已保存到: $SAVE_PATH"
      exit 0
      ;;
    failed)
      echo ""
      echo "❌ 生成失败："
      echo "$STATUS_RESP" | jq .
      exit 1
      ;;
    queued|in_progress) ;;
    *)
      echo "未知状态: $STATUS"
      echo "$STATUS_RESP" | jq .
      ;;
  esac
  sleep $INTERVAL
done

echo ""
echo "⚠️  轮询超时（${MAX_POLLS} 次 × ${INTERVAL}s）"
echo "video_id: $VIDEO_ID"
echo "可手动查询: curl -H \"Authorization: Bearer \$AGNES_API_KEY\" \"${API_BASE}/agnesapi?video_id=${VIDEO_ID}\""
exit 1
