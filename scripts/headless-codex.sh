#!/bin/bash
# Hook to run headless Codex against PROGRESS.md and issue output.
# Customize CODEX_CMD/CODEX_ARGS for your Codex CLI.

set -euo pipefail

PROGRESS_FILE="${1:-PROGRESS.md}"
ISSUES_FILE="${2:-}"

CODEX_CMD="${CODEX_CMD:-codex}"
CODEX_ARGS="${CODEX_ARGS:-}"

if ! command -v "$CODEX_CMD" > /dev/null 2>&1; then
  echo "ERROR: $CODEX_CMD not found. Set CODEX_CMD to your headless Codex executable." >&2
  exit 1
fi

if [ -n "$ISSUES_FILE" ] && [ -f "$ISSUES_FILE" ]; then
  export CODEX_ISSUES_FILE="$ISSUES_FILE"
fi

export CODEX_PROGRESS_FILE="$PROGRESS_FILE"

exec "$CODEX_CMD" $CODEX_ARGS "$PROGRESS_FILE"
