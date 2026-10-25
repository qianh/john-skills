#!/usr/bin/env bash
# dispatch.sh — 把一个子任务派给指定 Provider 上的指定模型（无头单轮），最终回复输出到 stdout。
#
# 用法:
#   dispatch.sh -p <claude|codex|grok|pi> -m <模型别名|raw:<模型参数>> -r <plan|exec|review> [-C 目录] [-f 提示词文件] [-R 运行账本id]
#   提示词默认从 stdin 读取。
#
# 角色权限:
#   plan / review → 只读（不允许改文件）
#   exec          → 允许在 -C 目录内改文件（不使用任何 bypass / yolo 类参数）
#
# 模型别名 → 模型参数 来自用户配置 models.conf（见 config.sh where / init），
# 找不到 (别名, provider) 对应行就报错，不猜。raw:<参数> 可绕过配置直接传。
#
# -R 运行账本id：
#   不指定：一次性会话，行为与之前完全一致。
#   指定：查询 sessions.tsv；有则续接，无则新建并记录。
set -euo pipefail

provider="" model="" role="" dir="$PWD" pfile="" runid=""
while getopts "p:m:r:C:f:R:" o; do
  case "$o" in
    p) provider=$OPTARG ;; m) model=$OPTARG ;; r) role=$OPTARG ;;
    C) dir=$OPTARG ;; f) pfile=$OPTARG ;; R) runid=$OPTARG ;;
    *) exit 2 ;;
  esac
done
[[ -n $provider && -n $model && -n $role ]] || { sed -n 2,15p "$0" >&2; exit 2; }
[[ $role =~ ^(plan|exec|review)$ ]] || { echo "role 必须是 plan|exec|review" >&2; exit 2; }
[[ -d $dir ]] || { echo "目录不存在: $dir" >&2; exit 2; }
# pi 没有文件系统沙箱，exec 无法限制在工作目录内，只允许承担只读角色
[[ $provider == pi && $role == exec ]] && { echo "pi 无法把写权限限制在工作目录内，不能承担 exec；请换 claude / codex / grok 外壳" >&2; exit 2; }

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

# 会话续接处理
session_id=""
resume=0
exit_code=0
skill_dir=$(cd "$(dirname "$0")/.." && pwd)
if [[ -n $runid ]]; then
  run_dir="${ORCHESTRATE_RUNS:-${XDG_CACHE_HOME:-$HOME/.cache}/orchestrate/runs}/$runid"
  [[ -d $run_dir ]] || { echo "运行账本不存在: $runid" >&2; exit 1; }
  session_id=$("$skill_dir/scripts/run.sh" session get "$runid" "$provider" "$model" || true)
  if [[ -n $session_id ]]; then
    resume=1
  fi
fi

cd "$dir"
case "$provider" in
  claude)
    mode=plan; [[ $role == exec ]] && mode=acceptEdits
    if ((resume)); then
      exit_code=0
      claude -p -r "${session_id}" --model "$id" --permission-mode "$mode" < "$tmp/prompt.md" | tee "$tmp/out.txt" || exit_code=$?
      if [[ $exit_code == 0 && -n $runid ]]; then
        "$skill_dir/scripts/run.sh" session set "${runid}" "$provider" "$model" "${session_id}"
      fi
    else
      if [[ -n ${runid} ]]; then
        session_id=$(uuidgen | tr A-Z a-z)
      fi
      exit_code=0
      claude -p ${runid:+--session-id "$session_id"} --model "$id" --permission-mode "$mode" < "$tmp/prompt.md" | tee "$tmp/out.txt" || exit_code=$?
      if [[ $exit_code == 0 && -n $runid ]]; then
        "$skill_dir/scripts/run.sh" session set "${runid}" "$provider" "$model" "${session_id}"
      fi
    fi
    ;;
  codex)
    sb=read-only; [[ $role == exec ]] && sb=workspace-write
    if ((resume)); then
      exit_code=0
      codex exec resume --skip-git-repo-check -m "$id" -c "sandbox_mode=\"$sb\"" -o "$tmp/out.md" "${session_id}" - < "$tmp/prompt.md" > "$tmp/log.txt" 2>&1 || exit_code=$?
    else
      if [[ -n ${runid} ]]; then
        ephemeral=""
      else
        ephemeral="--ephemeral"
      fi
      exit_code=0
      out=$(codex exec --skip-git-repo-check $ephemeral -s "$sb" -m "$id" -C "$dir" \
        -o "$tmp/out.md" --json - < "$tmp/prompt.md" 2>&1) || exit_code=$?
      if [[ $exit_code == 0 && -n $runid ]]; then
        session_id=$(echo "$out" | grep '"thread.started"' | grep -o '"thread_id":"[^"]*"' | head -1 | cut -d'"' -f4)
        if [[ -n ${session_id} ]]; then
          "$skill_dir/scripts/run.sh" session set "${runid}" "$provider" "$model" "${session_id}"
        fi
      elif ((exit_code != 0)); then
        echo "$out" >&2
      fi
    fi
    if ((exit_code != 0)); then
      [[ -f "$tmp/log.txt" ]] && cat "$tmp/log.txt" >&2
    else
      cat "$tmp/out.md" | tee "$tmp/out.txt"
    fi
    ;;
  grok)
    mode=plan; [[ $role == exec ]] && mode=acceptEdits
    if ((resume)); then
      exit_code=0
      grok -r "${session_id}" -m "$id" --permission-mode "$mode" --cwd "$dir" --prompt-file "$tmp/prompt.md" | tee "$tmp/out.txt" || exit_code=$?
      if [[ $exit_code == 0 && -n $runid ]]; then
        "$skill_dir/scripts/run.sh" session set "${runid}" "$provider" "$model" "${session_id}"
      fi
    else
      if [[ -n ${runid} ]]; then
        session_id=$(uuidgen | tr A-Z a-z)
      fi
      exit_code=0
      grok ${runid:+-s "$session_id"} -m "$id" --permission-mode "$mode" --cwd "$dir" --prompt-file "$tmp/prompt.md" | tee "$tmp/out.txt" || exit_code=$?
      if [[ $exit_code == 0 && -n $runid ]]; then
        "$skill_dir/scripts/run.sh" session set "${runid}" "$provider" "$model" "${session_id}"
      fi
    fi
    ;;
  pi)
    tools=(); [[ $role != exec ]] && tools=(--tools read,grep,find,ls)
    if [[ -n ${runid} ]]; then
      session_id=${session_id:-$(uuidgen | tr A-Z a-z)}
      exit_code=0
      pi -p --session-id "$session_id" --model "$id" ${tools[@]+"${tools[@]}"} "$(cat "$tmp/prompt.md")" | tee "$tmp/out.txt" || exit_code=$?
      if ((exit_code == 0)); then
        "$skill_dir/scripts/run.sh" session set "${runid}" "$provider" "$model" "${session_id}"
      fi
    else
      exit_code=0
      pi -p --no-session --model "$id" ${tools[@]+"${tools[@]}"} "$(cat "$tmp/prompt.md")" | tee "$tmp/out.txt" || exit_code=$?
    fi
    ;;
  *) echo "未知 provider: $provider" >&2; exit 2 ;;
esac

# 保存提示词到 briefs
if [[ -n $runid ]]; then
  run_dir="${ORCHESTRATE_RUNS:-${XDG_CACHE_HOME:-$HOME/.cache}/orchestrate/runs}/${runid}"
  # mktemp 保证同一秒内同 provider、同角色的多次派发不会互相覆盖
  brief_file=$(mktemp "${run_dir}/briefs/$(date '+%Y%m%d-%H%M%S')-${provider}-${role}.XXXXXX")
  {
    echo "# 派发记录"
    echo "时间：$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
    echo "Provider：${provider}"
    echo "模型：${model}（${id}）"
    echo "角色：${role}"
    [[ -n ${session_id} ]] && echo "会话 ID：${session_id}（续接：${resume}）"
    echo ""
    echo "## 提示词"
    echo ""
    cat "${tmp}/prompt.md"
  } > "${brief_file}"
fi

exit ${exit_code:-0}
