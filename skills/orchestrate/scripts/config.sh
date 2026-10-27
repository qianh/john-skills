#!/usr/bin/env bash
# Config parsing and migration share the same Bun implementation as the runner.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUN_BIN=${BUN:-}
[[ -n "$BUN_BIN" && -x "$BUN_BIN" ]] || BUN_BIN=$(command -v bun || true)
[[ -n "$BUN_BIN" && -x "$BUN_BIN" ]] || BUN_BIN="$HOME/.bun/bin/bun"
[[ -x "$BUN_BIN" ]] || { echo "未找到 bun，无法管理 orchestrate 配置" >&2; exit 2; }
exec "$BUN_BIN" "$SCRIPT_DIR/config-cli.ts" "$@"
