#!/usr/bin/env bash
# run.sh — orchestrate 运行账本管理
#
#   run.sh new [<slug>]                          创建账本目录 <YYYYmmdd-HHMMSS>-<slug>，返回 id
#   run.sh note <id>                             从 stdin 读内容，以 ## <时间> 小节追加进 ledger.md
#   run.sh brief <id>                            输出账本内容（供上下文包使用）
#   run.sh session get <id> <provider> <model>   查询 sessions.tsv 中的会话 id
#   run.sh session set <id> <provider> <model> <sid>
#                                                在 sessions.tsv 中写入或覆盖会话 id
#   run.sh path <id>                             输出账本目录路径
#   run.sh list                                  列出所有账本 id
#
set -euo pipefail

RUNS_DIR="${ORCHESTRATE_RUNS:-${XDG_CACHE_HOME:-$HOME/.cache}/orchestrate/runs}"

cmd_new() {
  local slug=${1:-} ts dir id
  [[ $slug == /* ]] && { echo "slug 不能以 / 开头" >&2; exit 1; }
  slug=$(echo "$slug" | sed 's/[^a-z0-9-]//g')
  ts=$(date '+%Y%m%d-%H%M%S')
  if [[ -n $slug ]]; then
    id="${ts}-${slug}"
  else
    id="$ts"
  fi
  dir="$RUNS_DIR/$id"
  [[ -d $dir ]] && { echo "账本已存在: $id" >&2; exit 1; }
  mkdir -p "$dir/briefs"
  {
    echo "# 账本：$id"
    echo "创建时间：$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
    echo "工作目录：$PWD"
    echo ""
  } > "$dir/ledger.md"
  touch "$dir/sessions.tsv"
  echo "$id"
}

cmd_note() {
  local id=$1 dir
  [[ -z $id ]] && { sed -n 2,12p "$0" >&2; exit 2; }
  dir=$(cmd_path "$id")
  {
    echo "## $(date '+%H:%M:%S')"
    cat
    echo ""
  } >> "$dir/ledger.md"
}

cmd_brief() {
  local id=$1 dir ledger
  [[ -z $id ]] && { sed -n 2,12p "$0" >&2; exit 2; }
  dir=$(cmd_path "$id")
  ledger="$dir/ledger.md"
  [[ -f $ledger ]] && cat "$ledger"
}

cmd_session_get() {
  local id=$1 provider=$2 model=$3 dir sessions
  [[ -z $model ]] && { sed -n 2,12p "$0" >&2; exit 2; }
  dir=$(cmd_path "$id")
  sessions="$dir/sessions.tsv"
  [[ -f $sessions ]] && awk -v p="$provider" -v m="$model" '$1 == p && $2 == m { print $3; exit }' "$sessions"
}

cmd_session_set() {
  local id=$1 provider=$2 model=$3 sid=$4 dir sessions tmp
  [[ -z $sid ]] && { sed -n 2,12p "$0" >&2; exit 2; }
  dir=$(cmd_path "$id")
  sessions="$dir/sessions.tsv"
  # 并行派发可能同时写同一账本：用 mkdir 锁串行化整个读改写；临时文件放同目录，mv 才是原子替换
  local lock="$dir/.sessions.lock" n=0
  until mkdir "$lock" 2> /dev/null; do
    n=$((n + 1)); ((n > 100)) && { echo "获取 sessions.tsv 锁超时: $lock" >&2; exit 1; }
    sleep 0.1
  done
  tmp=$(mktemp "$dir/.sessions.XXXXXX")
  trap "rm -f '$tmp'; rmdir '$lock' 2> /dev/null" EXIT
  if [[ -f $sessions ]]; then
    awk -v p="$provider" -v m="$model" '!($1 == p && $2 == m)' "$sessions" > "$tmp"
  else
    : > "$tmp"
  fi
  echo "$provider	$model	$sid" >> "$tmp"
  mv "$tmp" "$sessions"
  trap - EXIT  # 先撤 trap 再释放锁，避免退出时误删别人刚拿到的锁
  rmdir "$lock"
}

cmd_path() {
  local id=$1 dir
  [[ -z $id ]] && { sed -n 2,12p "$0" >&2; exit 2; }
  dir="$RUNS_DIR/$id"
  [[ -d $dir ]] || { echo "账本不存在: $id" >&2; exit 1; }
  echo "$dir"
}

cmd_list() {
  [[ -d $RUNS_DIR ]] && ls -d "$RUNS_DIR"/* 2>/dev/null | xargs -n1 basename | sort || true
}

case "${1:-}" in
  new)       shift; cmd_new "$@" ;;
  note)      shift; cmd_note "$@" ;;
  brief)     shift; cmd_brief "$@" ;;
  session)   shift; subcmd=${1:-}; shift || true
            case "$subcmd" in
              get) cmd_session_get "$@" ;;
              set) cmd_session_set "$@" ;;
              *) sed -n 2,12p "$0" >&2; exit 2 ;;
            esac ;;
  path)      shift; cmd_path "$@" ;;
  list)      cmd_list ;;
  *) sed -n 2,12p "$0" >&2; exit 2 ;;
esac
