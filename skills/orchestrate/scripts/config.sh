#!/usr/bin/env bash
# config.sh — orchestrate 的用户配置管理
#
#   config.sh where            打印用户配置目录
#   config.sh detect           探测本机已安装的 Provider 及其可用模型 ID（只读）
#   config.sh init             创建配置目录：用 detect 的结果生成 models.conf 骨架（候选行全部注释），
#                              并复制 routing.md 示例；已存在的文件保留，不覆盖
#   config.sh check [--probe]  校验 models.conf 与 routing.md；--probe 对每行发一次最小请求实测（会消耗少量 token）
#
# 配置目录: $ORCHESTRATE_HOME，否则 ${XDG_CONFIG_HOME:-~/.config}/orchestrate
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

gen_models_conf() {
  cat << 'EOF'
# models.conf — 模型别名 × Provider → 该 Provider 下实际使用的模型参数
#
# 每行三列（空白分隔）:  <别名>  <provider>  <模型参数>
#   别名      routing.md 里引用的名字，自己起，不含空格
#   provider  claude | codex | grok | pi
#   模型参数  原样传给该 provider 的模型选项，必须是下面列出的本机真实 ID（不要猜）
#
# 同一别名的多行 = 它能在哪些 provider 上跑；**第一行是默认外壳**，其余是兜底。
# 没有对应行的组合，dispatch.sh 会直接报错，不会擅自猜 ID。
#
# 启用方式：把候选行的 <别名> 换成自己起的名字并去掉行首 "# "。
# 改完用 `config.sh check --probe` 实测。作者的完整样本见 skill 的 references/models.sample.conf。
EOF
  local p path
  for p in $PROVIDERS; do
    echo
    if path=$(command -v "$p"); then echo "# ===== ${p}（已安装: ${path}）====="; else echo "# ===== ${p}（未安装，跳过）====="; continue; fi
    if [[ $p == claude ]]; then
      echo "# claude 没有模型列表命令。Claude 系写 claude-<name>（如 claude-sonnet-5-5）；"
      echo "# 经网关的其他模型写 vendor/model。确认可用的 ID 后按下面格式自行添加："
      echo "# <别名>  claude  <模型参数>"
    else
      list_models "$p" | awk -v p="$p" '{ printf "# <别名>  %s  %s\n", p, $0 }'
    fi
  done
}

cmd_init() {
  mkdir -p "$CONF_DIR"
  if [[ -e $CONF_DIR/models.conf ]]; then
    echo "保留（已存在）: $CONF_DIR/models.conf"
  else
    gen_models_conf > "$CONF_DIR/models.conf.tmp" && mv "$CONF_DIR/models.conf.tmp" "$CONF_DIR/models.conf"; echo "已创建骨架（候选全部注释，需启用）: $CONF_DIR/models.conf"
  fi
  if [[ -e $CONF_DIR/routing.md ]]; then
    echo "保留（已存在）: $CONF_DIR/routing.md"
  else
    cp "$SKILL_DIR/routing.example.md" "$CONF_DIR/routing.md"; echo "已创建: $CONF_DIR/routing.md"
  fi
  echo "下一步：在 models.conf 启用要用的模型行；按自己的模型清单改写 routing.md（示例是作者的偏好）；最后 config.sh check --probe"
}

cmd_check() {
  local probe=0 bad=0 i=0 a p m x tmp n known t
  [[ ${1:-} == --probe ]] && probe=1
  local conf="$CONF_DIR/models.conf" routing="$CONF_DIR/routing.md"
  [[ -f $conf ]] || { echo "未初始化：先运行 config.sh init" >&2; exit 1; }
  tmp=$(mktemp -d); trap "rm -rf '$tmp'" EXIT; mkdir "$tmp/cwd"

  while read -r a p m x; do
    case ${a:-} in ''|\#*) continue ;; esac
    i=$((i + 1))
    if [[ -z ${m:-} || -n ${x:-} ]]; then echo "FAIL  行格式应为 3 列: $a ${p:-} ${m:-} ${x:-}" > "$tmp/r.$i"; continue; fi
    case " $PROVIDERS " in *" $p "*) ;; *) echo "FAIL  $a@$p  未知 provider（应为: ${PROVIDERS}）" > "$tmp/r.$i"; continue ;; esac
    command -v "$p" > /dev/null || { echo "FAIL  $a@$p  provider 未安装" > "$tmp/r.$i"; continue; }
    if ((probe)); then
      (
        out=$(echo 'Reply with exactly: OK' | "$SKILL_DIR/scripts/dispatch.sh" -p "$p" -m "$a" -r review -C "$tmp/cwd" 2>&1) || true
        if [[ $out == *OK* ]]; then echo "PASS  $a@$p -> $m"; else echo "FAIL  $a@$p -> $m  实测无有效回复: $(echo "$out" | tail -1 | cut -c1-120)"; fi
      ) > "$tmp/r.$i" &
    else
      echo "OK    $a@$p -> ${m}（未实测）" > "$tmp/r.$i"
    fi
  done < "$conf"
  wait
  if ((i == 0)); then
    echo "FAIL  models.conf 没有任何启用的行（候选行都还是注释）"; return 1
  fi
  for ((n = 1; n <= i; n++)); do cat "$tmp/r.$n"; done
  grep -qh '^FAIL' "$tmp"/r.* 2> /dev/null && bad=1

  if [[ -f $routing ]]; then
    known=$(awk '$1 !~ /^#/ && NF >= 3 { print $1 }' "$conf" | sort -u)
    for t in $(grep -oE '`[a-z][a-z0-9]*(-[a-z0-9.]+)+`' "$routing" | tr -d '`' | sort -u); do
      [[ $t == *[0-9]* ]] || continue
      grep -qxF "$t" <<< "$known" || echo "WARN  routing.md 引用了 models.conf 未配置的模型: $t"
    done
    for t in $known; do
      grep -qF "\`$t\`" "$routing" || echo "WARN  $t 已配置，但 routing.md 没有路由到它"
    done
  else
    echo "WARN  缺少 ${routing}（config.sh init 可生成）"
  fi
  return $bad
}

case "${1:-}" in
  where)  cmd_where ;;
  detect) cmd_detect ;;
  init)   cmd_init ;;
  check)  shift; cmd_check "$@" ;;
  *) sed -n 2,10p "$0" >&2; exit 2 ;;
esac
