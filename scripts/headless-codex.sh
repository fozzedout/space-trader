#!/bin/bash
# Hook to run headless Codex against PROGRESS.md and issue output.
# Customize CODEX_CMD/CODEX_SUBCMD/CODEX_ARGS for your Codex CLI.

set -euo pipefail

PROGRESS_FILE="${1:-PROGRESS.md}"
ISSUES_FILE="${2:-}"

CODEX_CMD="${CODEX_CMD:-codex}"
CODEX_SUBCMD="${CODEX_SUBCMD:-exec}"
CODEX_ARGS="${CODEX_ARGS:---full-auto --sandbox workspace-write}"

if ! command -v "$CODEX_CMD" > /dev/null 2>&1; then
  echo "ERROR: $CODEX_CMD not found. Set CODEX_CMD to your headless Codex executable." >&2
  exit 1
fi

if [ -n "$ISSUES_FILE" ] && [ -f "$ISSUES_FILE" ]; then
  export CODEX_ISSUES_FILE="$ISSUES_FILE"
fi

export CODEX_PROGRESS_FILE="$PROGRESS_FILE"

PROMPT_FILE="$(mktemp)"
{
  echo "Use the tasks in $PROGRESS_FILE to drive changes."
  echo "Process only the single most important unchecked task, then exit."
  echo "Do not work on or modify any other tasks in this run."
  echo "Do not edit the Issues section."
  echo "Do not rewrite task text or add new tasks; only update one checkbox."
  echo "Use [ ] for pending and [x] for complete; do not introduce other markers."
  echo "If you need to mark in progress, keep [ ] and append ' (in progress)' to the task text."
  echo "If you cannot complete the task, leave it unchecked and explain why."
  if [ -n "$ISSUES_FILE" ] && [ -f "$ISSUES_FILE" ]; then
    echo ""
    echo "Issues list:"
    cat "$ISSUES_FILE"
  fi
} > "$PROMPT_FILE"

exec "$CODEX_CMD" "$CODEX_SUBCMD" $CODEX_ARGS - < "$PROMPT_FILE"
