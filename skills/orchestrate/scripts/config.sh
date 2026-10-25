#!/usr/bin/env bash
# config.sh — orchestrate 的用户配置管理
#
#   config.sh where       打印用户配置目录
#   config.sh detect      探测本机已安装的 Provider 及其可用模型 ID（只读，不发模型请求）
#   config.sh init        复制 models.sample.conf 与 routing.example.toml；已存在的文件保留
#   config.sh check       校验 models.conf 与 routing.toml。不发模型请求
#   config.sh preflight   检查 claude / codex / grok / pi 是否安装、是否登录
#
# 配置目录: $ORCHESTRATE_HOME，否则 ${XDG_CONFIG_HOME:-~/.config}/orchestrate
# 全局指令不再写入 CLAUDE.md 或 AGENTS.md。调度只在主会话里由 skill 触发。
set -euo pipefail

SKILL_DIR=$(cd "$(dirname "$0")/.." && pwd)
CONF_DIR="${ORCHESTRATE_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/orchestrate}"
PROVIDERS="claude codex grok pi"

# 列出某 Provider 本机可用的模型 ID（原样可填入 models.conf 第三列）；claude 无列表命令
list_models() {
  case $1 in
    codex) { codex debug models 2> /dev/null | grep -o '"slug": *"[^"]*"' | sed 's/.*: *"\(.*\)"/\1/'; } || true ;;
    grok)  { grok models 2> /dev/null | sed -n 's/^ *- //p'; } || true ;;
    pi)    { pi --list-models 2> /dev/null | awk 'NR > 1 { print $1 "/" $2 }'; } || true ;;
  esac
}

cmd_where() { echo "$CONF_DIR"; }

cmd_detect() {
  local p path
  for p in $PROVIDERS; do
    if path=$(command -v "$p"); then echo "## $p  已安装: $path"; else echo "## $p  未安装"; continue; fi
    if [[ $p == claude ]]; then
      echo "(无模型列表命令。Claude 系用 claude-<name>；经网关的其他模型用 vendor/model)"
    else
      list_models "$p"
    fi
  done
}

copy_new() {
  local src=$1 dest=$2
  if [[ -e $dest ]]; then echo "保留（已存在）: $dest"; return; fi
  cp "$src" "$dest"
  echo "已创建: $dest"
}

cmd_init() {
  mkdir -p "$CONF_DIR"
  copy_new "$SKILL_DIR/references/models.sample.conf" "$CONF_DIR/models.conf"
  copy_new "$SKILL_DIR/references/routing.example.toml" "$CONF_DIR/routing.toml"
  if [[ -e $CONF_DIR/routing.md ]]; then
    echo "routing.md 已不再读取。orch 用的是 routing.toml。这个旧文件没有改动。"
  fi
  echo "下一步：按网关实际价格改 models.conf 的价格列。预检：config.sh preflight"
}

cmd_check() {
  local bad=0 i=0 tmp n line nfields a p m k price_bad known t word fields
  if [[ ${1:-} == --probe ]]; then
    echo "check 不再发模型请求。登录状态用 config.sh preflight。"
  fi
  local conf="$CONF_DIR/models.conf" routing="$CONF_DIR/routing.toml"
  [[ -f $conf ]] || { echo "未初始化：先运行 config.sh init" >&2; exit 1; }
  tmp=$(mktemp -d)
  trap "rm -rf '$tmp'" EXIT

  while IFS= read -r line || [[ -n ${line:-} ]]; do
    line=${line%%#*}
    line=${line#"${line%%[![:space:]]*}"}
    line=${line%"${line##*[![:space:]]}"}
    [[ -z $line ]] && continue
    read -r -a fields <<< "$line"
    nfields=${#fields[@]}
    i=$((i + 1))
    a=${fields[0]}
    p=${fields[1]:-}
    m=${fields[2]:-}
    if ((nfields < 3 || nfields > 7)); then
      echo "FAIL  行格式应为 3 到 7 列: $line" > "$tmp/r.$i"
      continue
    fi
    case " $PROVIDERS " in
      *" $p "*) ;;
      *) echo "FAIL  $a@$p  未知 provider（应为: ${PROVIDERS}）" > "$tmp/r.$i"; continue ;;
    esac
    price_bad=0
    for ((k = 3; k < nfields; k++)); do
      [[ ${fields[k]} =~ ^[0-9]+([.][0-9]+)?$ ]] || price_bad=1
    done
    if ((price_bad)); then
      echo "FAIL  $a@$p  价格列要是数字" > "$tmp/r.$i"
      continue
    fi
    if command -v "$p" > /dev/null; then
      echo "OK    $a@$p -> ${m}" > "$tmp/r.$i"
    else
      echo "FAIL  $a@$p  provider 未安装" > "$tmp/r.$i"
    fi
  done < "$conf"

  if ((i == 0)); then
    echo "FAIL  models.conf 没有任何启用的行"
    return 1
  fi
  for ((n = 1; n <= i; n++)); do cat "$tmp/r.$n"; done
  grep -qh '^FAIL' "$tmp"/r.* 2> /dev/null && bad=1

  if [[ ! -f $routing ]]; then
    echo "WARN  缺少 ${routing}（config.sh init 可生成）"
    return $bad
  fi
  known=$(awk '{ sub(/#.*/, ""); if ($1 ~ /^[A-Za-z]/ && NF >= 3) print $1 }' "$conf" | sort -u)
  while read -r word; do
    [[ -n $word ]] || continue
    [[ $word == *[0-9]* || $word == *-* ]] || continue
    grep -qxF "$word" <<< "$known" || echo "WARN  routing.toml 引用了 models.conf 未配置的模型: $word"
  done < <(grep -oE '"[^"]+"' "$routing" | tr -d '"' || true)
  while read -r t; do
    [[ -n $t ]] || continue
    grep -qF "\"$t\"" "$routing" || echo "WARN  $t 已配置，但 routing.toml 没有路由到它"
  done <<< "$known"
  return $bad
}

cmd_preflight() {
  local bun=${BUN:-}
  [[ -n $bun && -x $bun ]] || bun=$(command -v bun || true)
  [[ -n $bun && -x $bun ]] || bun=$HOME/.bun/bin/bun
  [[ -x $bun ]] || { echo "未找到 bun，无法运行预检" >&2; exit 1; }
  exec "$bun" "$SKILL_DIR/scripts/orch.ts" preflight
}

case "${1:-}" in
  where)     cmd_where ;;
  detect)    cmd_detect ;;
  init)      cmd_init ;;
  check)     shift; cmd_check "$@" ;;
  preflight) cmd_preflight ;;
  *) sed -n '2,11p' "$0" >&2; exit 2 ;;
esac
