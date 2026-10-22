#!/usr/bin/env bash
# dispatch.sh — 把一个子任务派给指定 Provider 上的指定模型（无头单轮），最终回复输出到 stdout。
#
# 用法:
#   dispatch.sh -p <claude|codex|grok|pi> -m <模型别名|raw:<模型参数>> -r <plan|exec|review> [-C 目录] [-f 提示词文件]
#   提示词默认从 stdin 读取。
#
# 角色权限:
#   plan / review → 只读（不允许改文件）
#   exec          → 允许在 -C 目录内改文件（不使用任何 bypass / yolo 类参数）
#
# 模型别名 → 模型参数 来自用户配置 models.conf（见 config.sh where / init），
# 找不到 (别名, provider) 对应行就报错，不猜。raw:<参数> 可绕过配置直接传。
set -euo pipefail

provider="" model="" role="" dir="$PWD" pfile=""
while getopts "p:m:r:C:f:" o; do
  case "$o" in
    p) provider=$OPTARG ;; m) model=$OPTARG ;; r) role=$OPTARG ;;
    C) dir=$OPTARG ;; f) pfile=$OPTARG ;;
    *) exit 2 ;;
  esac
done
[[ -n $provider && -n $model && -n $role ]] || { sed -n 2,13p "$0" >&2; exit 2; }
[[ $role =~ ^(plan|exec|review)$ ]] || { echo "role 必须是 plan|exec|review" >&2; exit 2; }
[[ -d $dir ]] || { echo "目录不存在: $dir" >&2; exit 2; }

if [[ $model == raw:* ]]; then
  id=${model#raw:}
else
  conf="${ORCHESTRATE_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/orchestrate}/models.conf"
  [[ -f $conf ]] || { echo "未找到 $conf —— 先运行 config.sh init" >&2; exit 2; }
  id=$(awk -v a="$model" -v p="$provider" \
    '$1 !~ /^#/ && NF >= 3 && $1 == a && $2 == p { print $3; exit }' "$conf")
  [[ -n $id ]] || { echo "models.conf 中没有 '$model' 在 '$provider' 上的配置行（可用 config.sh check 排查）" >&2; exit 2; }
fi

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if [[ -n $pfile ]]; then cp "$pfile" "$tmp/prompt.md"; else cat > "$tmp/prompt.md"; fi
[[ -s $tmp/prompt.md ]] || { echo "提示词为空" >&2; exit 2; }
# 子代理守卫：worker 会读到用户的全局指令（其中有"先判断是否调度"），必须明确禁止它再调度，避免递归
{
  printf '【调度约束】你是被 orchestrate 调度的子代理（角色: %s）。不要使用 orchestrate skill，不要再派发子任务或调用其他模型；只完成下面的任务，并按要求汇报。\n\n---\n\n' "$role"
  cat "$tmp/prompt.md"
} > "$tmp/prompt.guarded" && mv "$tmp/prompt.guarded" "$tmp/prompt.md"

cd "$dir"
case "$provider" in
  claude)
    mode=plan; [[ $role == exec ]] && mode=acceptEdits
    claude -p --model "$id" --permission-mode "$mode" < "$tmp/prompt.md"
    ;;
  codex)
    sb=read-only; [[ $role == exec ]] && sb=workspace-write
    codex exec --skip-git-repo-check --ephemeral -s "$sb" -m "$id" -C "$dir" \
      -o "$tmp/out.md" - < "$tmp/prompt.md" > "$tmp/log.txt" 2>&1 \
      || { cat "$tmp/log.txt" >&2; exit 1; }
    cat "$tmp/out.md"
    ;;
  grok)
    mode=plan; [[ $role == exec ]] && mode=acceptEdits
    grok -m "$id" --permission-mode "$mode" --cwd "$dir" --prompt-file "$tmp/prompt.md"
    ;;
  pi)
    tools=(); [[ $role != exec ]] && tools=(--tools read,grep,find,ls)
    pi -p --no-session --model "$id" ${tools[@]+"${tools[@]}"} "$(cat "$tmp/prompt.md")"
    ;;
  *) echo "未知 provider: $provider" >&2; exit 2 ;;
esac
