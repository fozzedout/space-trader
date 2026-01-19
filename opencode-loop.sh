#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PROGRESS_FILE="${PROGRESS_FILE:-$ROOT/PROGRESS.md}"
OPENCODE_CMD="${OPENCODE_CMD:-opencode}"
OPENCODE_ARGS="${OPENCODE_ARGS:-}"
MAX_ITERS="${MAX_ITERS:-200}"

if [[ ! -f "$PROGRESS_FILE" ]]; then
  echo "Missing PROGRESS.md at: $PROGRESS_FILE" >&2
  exit 1
fi

if ! command -v "$OPENCODE_CMD" >/dev/null 2>&1; then
  echo "OpenCode command not found: $OPENCODE_CMD" >&2
  echo "Set OPENCODE_CMD to your OpenCode CLI executable." >&2
  exit 1
fi

HAS_RG=0
if command -v rg >/dev/null 2>&1; then
  HAS_RG=1
fi

count_status() {
  local status="$1"
  local count=""
  if [[ "$HAS_RG" -eq 1 ]]; then
    count="$(rg -c "\\| ${status} \\|" "$PROGRESS_FILE" || true)"
  else
    count="$(grep -c "| ${status} |" "$PROGRESS_FILE" || true)"
  fi
  if [[ -z "$count" ]]; then
    count="0"
  fi
  echo "$count"
}

hash_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    cksum "$file" | awk '{print $1}'
  fi
}

build_prompt() {
  local prompt_file="$1"
  local in_progress_count="$2"

  cat >"$prompt_file" <<'PROMPT'
You are OpenCode, a coding agent running in this repository.

Goal:
- If a task is already "in progress", complete that task and mark it "done".
- Otherwise, select the single most important "not started" task, mark it "in progress",
  implement it fully, then mark it "done".
- Only one task per run.

Rules:
- If a task is too large, split it into smaller tasks in PROGRESS.md first. Then complete
  one of the new tasks in the same run.
- Do not leave any task marked "in progress" when you finish.
- Do not add implementation notes to PROGRESS.md; only edit task rows.
- Use ECONOMY_BIBLE.md for details as needed.

Context: PROGRESS.md contents below.
PROMPT

  if [[ "$in_progress_count" -gt 0 ]]; then
    cat >>"$prompt_file" <<'PROMPT'

Note: A task is already marked "in progress". Finish that specific task in this run.
PROMPT
  fi

  {
    echo ""
    echo "---- PROGRESS.md ----"
    cat "$PROGRESS_FILE"
    echo "---- END PROGRESS.md ----"
  } >>"$prompt_file"
}

iter=1
while ((iter <= MAX_ITERS)); do
  not_started_count="$(count_status "not started")"
  in_progress_count="$(count_status "in progress")"

  if [[ "$not_started_count" -eq 0 && "$in_progress_count" -eq 0 ]]; then
    echo "No remaining tasks; exiting."
    exit 0
  fi

  before_hash="$(hash_file "$PROGRESS_FILE")"
  prompt_file="$(mktemp)"
  build_prompt "$prompt_file" "$in_progress_count"

  "$OPENCODE_CMD" $OPENCODE_ARGS <"$prompt_file"

  rm -f "$prompt_file"
  after_hash="$(hash_file "$PROGRESS_FILE")"

  iter=$((iter + 1))
done

echo "Reached MAX_ITERS=$MAX_ITERS; stopping." >&2
exit 5
