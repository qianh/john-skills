#!/usr/bin/env bash
# config.sh — orchestrate 的用户配置管理
#
#   config.sh where            打印用户配置目录
#   config.sh detect           探测本机已安装的 Provider 及其可用模型 ID（只读）
#   config.sh init             创建配置目录：用 detect 的结果生成 models.conf 骨架（候选行全部注释），
#                              并复制 routing.md 示例；已存在的文件保留，不覆盖
#   config.sh check [--probe]  校验 models.conf 与 routing.md；--probe 对每行发一次最小请求实测（会消耗少量 token）
#   config.sh instructions status|install|remove [--target claude|codex|pi|grok|all] [--dry-run]
#                              在各 Provider 的全局指令文件里写入/移除"动手前先判断是否调度"的指引（仅改标记块，先备份）；
#                              pi 看不到 skill 时建 ~/.pi/agent/skills/orchestrate 软链；codex 未装插件时建 ~/.agents/skills/orchestrate 软链。grok 读 CLAUDE.md，随 claude 覆盖
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
# 启用方式：把要用的候选行复制到下面「已启用」区，把 <别名> 换成自己起的名字、去掉行首 "# "。
# 行序 = 优先级，所以启用行集中写在「已启用」区，不要在候选区就地取消注释。
# 改完用 `config.sh check --probe` 实测。作者的完整样本见 skill 的 references/models.sample.conf。

# ===== 已启用（同一别名的第一行 = 默认外壳）=====

# ===== 以下为本机探测到的候选（均为注释）=====
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

# ---------- instructions：把"动手前先判断是否调度"的指引写入各 Provider 的全局指令文件 ----------
# 只改文件里 orchestrate:begin/end 标记块，块外内容一字不动；写入前备份到 $CONF_DIR/backups/
AGENTS_SKILLS_DIR="$HOME/.agents/skills"

instr_block() {
  cat << 'EOF'
<!-- orchestrate:begin v2 -->
## 多模型调度（orchestrate）

多步骤任务动手前，先按以下标准判断是否值得多模型调度：跨多模块 / 碰钱·权限·迁移·生产 / 方案模糊 / 需要独立 review / 可并行拆分 / 大范围审阅评审（文档、方案、代码，适合多个模型交叉核验）。
满足任一条才加载 `orchestrate` skill（Claude Code 中为 `john:orchestrate`）；单点小改动直接做，不加载。
若提示词声明你是被调度的 planner / executor / reviewer，不得再调度。
<!-- orchestrate:end -->
EOF
}

claude_dir() { echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; }

# 各 Provider 的全局指令文件。grok 直接读 Claude 的 CLAUDE.md，与 claude 共用；
# pi 只取目录里第一个命中的候选文件（顺序见其 resource-loader），都不存在则新建 AGENTS.md
instr_file() {
  local d f
  case $1 in
    claude|grok) echo "$(claude_dir)/CLAUDE.md" ;;
    codex)
      d=${CODEX_HOME:-$HOME/.codex}
      if [[ -e $d/AGENTS.override.md ]]; then echo "$d/AGENTS.override.md"; else echo "$d/AGENTS.md"; fi ;;
    pi)
      d=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
      for f in AGENTS.override.md AGENTS.md AGENTS.MD CLAUDE.md CLAUDE.MD; do
        if [[ -f $d/$f ]]; then echo "$d/$f"; return; fi
      done
      echo "$d/AGENTS.md" ;;
  esac
}

# 该 Provider 当前能否加载到 orchestrate skill
skill_visible() {
  case $1 in
    claude|grok) grep -q '"john@' "$(claude_dir)/plugins/installed_plugins.json" 2> /dev/null || [[ -e $(claude_dir)/skills/john ]] ;;
    codex) codex_native || [[ -f $AGENTS_SKILLS_DIR/orchestrate/SKILL.md ]] ;;
    pi) [[ -f $(pi_dir)/skills/orchestrate/SKILL.md || -f $AGENTS_SKILLS_DIR/orchestrate/SKILL.md ]] ;;
  esac
}

pi_dir() { echo "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; }

# codex 自带途径能否加载：插件安装，或 ~/.codex/skills 下有该 skill（不含 ~/.agents/skills 软链）
codex_native() {
  [[ -f ${CODEX_HOME:-$HOME/.codex}/skills/orchestrate/SKILL.md ]] || { codex plugin list 2> /dev/null | grep -q '^john@'; }
}

# skill 不可见时建软链，指向旧版本或悬空时刷新。pi 链到自己的 skills 目录（~/.agents/skills 会被 codex 一并扫到，
# 与 codex 插件重复加载）；codex 只有在没装插件时才链到 ~/.agents/skills
expose_skill() { # $1=skills 目录
  local dir=$1 link="$1/orchestrate"
  if [[ -L $link ]]; then
    [[ $(readlink "$link") == "$SKILL_DIR" ]] && { echo "  skill 软链已指向当前版本: $link"; return 0; }
    echo "  skill 软链需刷新: $link -> $SKILL_DIR"
  elif [[ -e $link ]]; then
    echo "  WARN  $link 已存在且不是软链，不改动；请自行确认它是 orchestrate skill"; return 0
  else
    echo "  skill 对该 Provider 不可见，将创建软链: $link -> $SKILL_DIR"
  fi
  if ((DRY)); then echo "  (dry-run，未创建)"; return 0; fi
  mkdir -p "$dir" && ln -sfn "$SKILL_DIR" "$link" && echo "  已创建/刷新软链"
}

# 旧版本把 pi 和 codex 共用的软链放在 ~/.agents/skills；codex 已有自带途径时它会造成重复加载，迁移掉
# （pi 已安装但还没有自己的软链时先保留，等 pi 迁移完再清）
cleanup_legacy_link() {
  local link="$AGENTS_SKILLS_DIR/orchestrate"
  [[ -L $link && $(basename "$(readlink "$link")") == orchestrate ]] || return 0
  if command -v pi > /dev/null && [[ ! -f $(pi_dir)/skills/orchestrate/SKILL.md ]]; then
    echo "  旧软链 $link 暂留：pi 尚未迁移到自己的 skills 目录（install --target pi 后再清）"; return 0
  fi
  echo "  codex 已自带该 skill，旧软链会造成重复加载，将移除: $link"
  if ((DRY)); then echo "  (dry-run，未移除)"; return 0; fi
  rm -f "$link" && echo "  已移除旧软链"
}

instr_extract() { awk '/<!-- orchestrate:begin/ { f = 1 } f { print } /<!-- orchestrate:end -->/ { f = 0 }' "$1"; }

instr_backup() { # target file → 打印备份路径
  local b
  mkdir -p "$CONF_DIR/backups" || return 1
  # mktemp 保证文件名唯一，避免同一秒内的多次备份互相覆盖；cp -p 保留原权限
  b=$(mktemp "$CONF_DIR/backups/$1-$(basename "$2").$(date +%Y%m%d-%H%M%S).XXXXXX") || return 1
  cp -p "$2" "$b" && echo "$b"
}

instr_targets() {
  local t out=""
  if [[ $1 == all ]]; then
    for t in claude pi codex grok; do command -v "$t" > /dev/null && out="$out $t"; done
  else
    case $1 in claude|codex|pi|grok) out=$1 ;; *) echo "未知 --target: $1（应为 claude|codex|pi|grok|all）" >&2; exit 2 ;; esac
  fi
  echo $out
}

instr_status() {
  local t=$1 file=$2 state="未写入" vis="不可用"
  if [[ -f $file ]] && grep -q 'orchestrate:begin' "$file"; then
    instr_extract "$file" > "$TMP/cur"; instr_block > "$TMP/new"
    if cmp -s "$TMP/cur" "$TMP/new"; then state="已写入（最新）"; else state="已写入（内容过期，install 可更新）"; fi
  fi
  skill_visible "$t" && vis="可用"
  echo "[$t] ${file}  指引: ${state}  skill: ${vis}"
}

instr_install() {
  local t=$1 file=$2 b
  echo "[$t] 目标文件: $file"
  instr_block > "$TMP/block"
  if [[ ! -f $file ]]; then
    cp "$TMP/block" "$TMP/new"
  elif grep -q 'orchestrate:begin' "$file"; then
    grep -q 'orchestrate:end' "$file" || { echo "  FAIL  只有 begin 标记没有 end 标记，拒绝改动，请手工修复"; return 1; }
    awk -v bf="$TMP/block" '
      /<!-- orchestrate:begin/ { while ((getline l < bf) > 0) print l; close(bf); skip = 1; next }
      skip && /<!-- orchestrate:end -->/ { skip = 0; next }
      !skip { print }' "$file" > "$TMP/new"
  else
    { cat "$file"; if [[ -s $file ]]; then [[ -n $(tail -c1 "$file") ]] && echo; echo; fi; cat "$TMP/block"; } > "$TMP/new"
  fi
  if [[ -f $file ]] && cmp -s "$file" "$TMP/new"; then
    echo "  指引已是最新，无需改动"
  else
    echo "  变更预览:"
    if [[ -f $file ]]; then diff -u "$file" "$TMP/new" | sed 's/^/    /' || true; else sed 's/^/    + /' "$TMP/new"; fi
    if ((DRY)); then
      echo "  (dry-run，未写入)"
    else
      b=""; [[ -f $file ]] && b=$(instr_backup "$t" "$file")
      mkdir -p "$(dirname "$file")" && cat "$TMP/new" > "$file"
      echo "  已写入${b:+；原文件备份: $b}"
    fi
  fi
  case $t in
    pi) expose_skill "$(pi_dir)/skills" ;;
    codex) if codex_native; then cleanup_legacy_link; else expose_skill "$AGENTS_SKILLS_DIR"; fi ;;
  esac
}

instr_remove() {
  local t=$1 file=$2 b
  echo "[$t] 目标文件: $file"
  if [[ ! -f $file ]] || ! grep -q 'orchestrate:begin' "$file"; then echo "  未写入，无需移除"; return 0; fi
  grep -q 'orchestrate:end' "$file" || { echo "  FAIL  只有 begin 标记没有 end 标记，拒绝改动，请手工修复"; return 1; }
  # 删除标记块，并丢掉紧邻其前的一个空行（install 追加时加的）
  awk '
    /^$/ && !skip { n++; next }
    /<!-- orchestrate:begin/ { skip = 1; n = (n > 0 ? n - 1 : 0); next }
    skip { if (/<!-- orchestrate:end -->/) skip = 0; next }
    { for (; n > 0; n--) print ""; print }
    END { for (; n > 0; n--) print "" }' "$file" > "$TMP/new"
  if ((DRY)); then echo "  变更预览:"; diff -u "$file" "$TMP/new" | sed 's/^/    /' || true; echo "  (dry-run，未写入)"; return 0; fi
  b=$(instr_backup "$t" "$file")
  if [[ -z $(tr -d '[:space:]' < "$TMP/new") ]]; then rm -f "$file"; echo "  已移除；文件仅含该块，已一并删除；备份: $b"
  else cat "$TMP/new" > "$file"; echo "  已移除；备份: $b"; fi
  case $t in
    pi) [[ -L $(pi_dir)/skills/orchestrate ]] && echo "  软链 $(pi_dir)/skills/orchestrate 保留，不再需要时请手动删除" ;;
    codex) [[ -L $AGENTS_SKILLS_DIR/orchestrate ]] && echo "  软链 $AGENTS_SKILLS_DIR/orchestrate 保留，不再需要时请手动删除" ;;
  esac
  return 0
}

cmd_instructions() {
  local action=${1:-status} target=all t file seen=$'\n' list
  shift || true
  DRY=0
  while (($#)); do
    case $1 in
      --target) target=${2:-}; shift 2 ;;
      --dry-run) DRY=1; shift ;;
      *) echo "未知参数: $1" >&2; exit 2 ;;
    esac
  done
  case $action in status|install|remove) ;; *) sed -n 2,13p "$0" >&2; exit 2 ;; esac
  list=$(instr_targets "$target")
  [[ -n $list ]] || { echo "未检测到已安装的 claude / codex / pi / grok，没有可处理的目标"; return 0; }
  TMP=$(mktemp -d); trap "rm -rf '$TMP'" EXIT
  for t in $list; do
    file=$(instr_file "$t")
    if [[ $seen == *$'\n'"$file"$'\n'* ]]; then echo "[$t] 与前一目标共用 ${file}，已一并覆盖"; continue; fi
    seen="$seen$file"$'\n'
    "instr_$action" "$t" "$file"
  done
}

case "${1:-}" in
  where)        cmd_where ;;
  detect)       cmd_detect ;;
  init)         cmd_init ;;
  check)        shift; cmd_check "$@" ;;
  instructions) shift; cmd_instructions "$@" ;;
  *) sed -n 2,13p "$0" >&2; exit 2 ;;
esac
