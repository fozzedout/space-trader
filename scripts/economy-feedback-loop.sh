#!/bin/bash
# Automated economy feedback loop driven by LLM analysis + Codex fixes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

START_MINUTES="${START_MINUTES:-30}"
INCREMENT_MINUTES="${INCREMENT_MINUTES:-5}"
MAX_MINUTES="${MAX_MINUTES:-0}"
SERVER_URL="${SERVER_URL:-http://localhost:3001}"
LM_STUDIO_URL="${LM_STUDIO_URL:-}"
LM_STUDIO_BASE_URL="${LM_STUDIO_BASE_URL:-}"
CODEX_HOOK="${CODEX_HOOK:-$PROJECT_DIR/scripts/headless-codex.sh}"
PROGRESS_FILE="${PROGRESS_FILE:-$PROJECT_DIR/PROGRESS.md}"
CONTAINER_NAME="${CONTAINER_NAME:-space-trader}"
CONTAINER_COMPOSE_FILE="${CONTAINER_COMPOSE_FILE:-podman-compose.yml}"
USE_CONTAINER_TESTS="${USE_CONTAINER_TESTS:-true}"
TEST_CMD="${TEST_CMD:-npm test}"
COLLECTION_INTERVAL_SECONDS="${COLLECTION_INTERVAL_SECONDS:-}"
SLEEP_BETWEEN_LOOPS_SECONDS="${SLEEP_BETWEEN_LOOPS_SECONDS:-0}"
MAX_LOOPS="${MAX_LOOPS:-10}"
CODEX_MAX_ROUNDS="${CODEX_MAX_ROUNDS:-0}"
CODEX_TIMEOUT_SECONDS="${CODEX_TIMEOUT_SECONDS:-900}"
ISSUE_LIMIT="${ISSUE_LIMIT:-0}"
ISSUE_PATTERN="${ISSUE_PATTERN:-Issue Identified:|\\*\\*Issue Identified\\*\\*:|Recommendation:|\\*\\*Recommendation\\*\\*:}"
RESUME_PENDING_TASKS="${RESUME_PENDING_TASKS:-true}"

LM_STUDIO_CHAT_URL=""
if [ -n "$LM_STUDIO_URL" ]; then
  if [[ "$LM_STUDIO_URL" == *"/v1/"* ]]; then
    LM_STUDIO_CHAT_URL="$LM_STUDIO_URL"
    LM_STUDIO_BASE_URL="${LM_STUDIO_URL%%/v1/*}"
  else
    LM_STUDIO_BASE_URL="$LM_STUDIO_URL"
  fi
fi

if [ -z "$LM_STUDIO_BASE_URL" ]; then
  LM_STUDIO_BASE_URL="http://localhost:1234"
fi

LM_STUDIO_CHAT_URL="${LM_STUDIO_CHAT_URL:-${LM_STUDIO_BASE_URL%/}/v1/chat/completions}"
LM_STUDIO_MODELS_URL="${LM_STUDIO_BASE_URL%/}/v1/models"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >&2
}

health_check() {
  curl -s "${SERVER_URL%/}/api/health" > /dev/null 2>&1
}

wait_for_health() {
  for _ in {1..30}; do
    if health_check; then
      return 0
    fi
    sleep 1
  done
  log "ERROR: server not ready at $SERVER_URL"
  exit 1
}

ensure_server() {
  if health_check; then
    return 0
  fi

  if command -v podman > /dev/null 2>&1; then
    log "Starting Podman container..."
    podman compose -f "$CONTAINER_COMPOSE_FILE" up -d
  elif command -v docker > /dev/null 2>&1; then
    log "Starting Docker container..."
    docker compose -f "$CONTAINER_COMPOSE_FILE" up -d
  else
    log "ERROR: server not reachable and no container runtime found."
    exit 1
  fi

  wait_for_health
}

latest_file() {
  local pattern="$1"
  ls -t $pattern 2>/dev/null | head -1
}

run_collection() {
  local duration="$1"
  local interval="$2"
  log "Collecting economy data for ${duration} minutes (interval ${interval}s)..."
  DURATION_MINUTES="$duration" COLLECTION_INTERVAL_SECONDS="$interval" SERVER_URL="$SERVER_URL" \
    npx tsx scripts/collect-economy-data.ts >&2
  local data_file
  data_file="$(latest_file "economy-data/economy-data-*.json")"
  if [ -z "$data_file" ]; then
    log "ERROR: no economy data file created."
    exit 1
  fi
  echo "$data_file"
}

analyze_data() {
  local data_file="$1"
  if ! curl -s "$LM_STUDIO_MODELS_URL" > /dev/null 2>&1; then
    log "LM Studio not reachable at $LM_STUDIO_BASE_URL; skipping analysis."
    return 1
  fi

  log "Analyzing data via LM Studio..."
  if ! LM_STUDIO_URL="$LM_STUDIO_CHAT_URL" npx tsx scripts/analyze-with-llm.ts "$data_file" >&2; then
    log "ERROR: analysis failed."
    return 1
  fi
  local report_file
  report_file="$(latest_file "economy-reports/economy-report-*.md")"
  if [ -z "$report_file" ]; then
    log "ERROR: analysis completed but no report found."
    return 1
  fi
  echo "$report_file"
}

extract_issues() {
  local report_file="$1"
  if [ -z "$report_file" ]; then
    echo "LLM analysis unavailable or report missing."
    return 0
  fi

  if command -v rg > /dev/null 2>&1; then
    rg -n "$ISSUE_PATTERN" "$report_file" || true
  else
    grep -nE "$ISSUE_PATTERN" "$report_file" || true
  fi
}

format_task_line() {
  local line="$1"
  line="${line#*:}"
  line="${line#- }"
  line="${line//\*\*/}"
  line="${line#Issue Identified: }"
  line="${line#WARNING: }"
  line="${line#ERROR: }"
  line="${line#Recommendation: }"
  line="$(echo "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^[0-9]+[).][[:space:]]+//')"
  if [ -z "$line" ]; then
    return 1
  fi
  if [[ "$line" == \#* ]]; then
    return 1
  fi
  echo "$line"
}

write_progress() {
  local issues_file="$1"
  log "Overwriting $PROGRESS_FILE from issues..."
  {
    echo "# Automated Economy Feedback Tasks"
    echo ""
    echo "## Issues"
    local issue_count=0
    declare -A seen_issues
    while IFS= read -r issue; do
      if [ -n "$issue" ]; then
        local issue_key
        issue_key="$(format_task_line "$issue" || true)"
        if [ -z "$issue_key" ]; then
          continue
        fi
        if [ -n "${seen_issues[$issue_key]+x}" ]; then
          continue
        fi
        seen_issues[$issue_key]=1
        issue_count=$((issue_count + 1))
        if [ "$ISSUE_LIMIT" -gt 0 ] && [ "$issue_count" -gt "$ISSUE_LIMIT" ]; then
          break
        fi
        echo "- $issue_key"
      fi
    done < "$issues_file"
    echo ""
    echo "## Tasks (ordered by importance)"
    issue_count=0
    declare -A seen_tasks
    while IFS= read -r issue; do
      task="$(format_task_line "$issue" || true)"
      if [ -n "${task:-}" ]; then
        if [ -n "${seen_tasks[$task]+x}" ]; then
          continue
        fi
        seen_tasks[$task]=1
        issue_count=$((issue_count + 1))
        if [ "$ISSUE_LIMIT" -gt 0 ] && [ "$issue_count" -gt "$ISSUE_LIMIT" ]; then
          break
        fi
        echo "- [ ] $task"
      fi
    done < "$issues_file"
  } > "$PROGRESS_FILE"
}

has_pending_tasks() {
  if command -v rg > /dev/null 2>&1; then
    rg -q "\\[ \\]" "$PROGRESS_FILE"
  else
    grep -q "\\[ \\]" "$PROGRESS_FILE"
  fi
}

count_pending_tasks() {
  if command -v rg > /dev/null 2>&1; then
    rg -c "\\[ \\]" "$PROGRESS_FILE" || true
  else
    grep -c "\\[ \\]" "$PROGRESS_FILE" || true
  fi
}

run_codex_once() {
  local issues_file="$1"
  if [ ! -x "$CODEX_HOOK" ]; then
    log "ERROR: CODEX_HOOK not executable: $CODEX_HOOK"
    exit 1
  fi

  log "Invoking headless Codex via $CODEX_HOOK..."
  if command -v timeout > /dev/null 2>&1; then
    timeout "$CODEX_TIMEOUT_SECONDS" "$CODEX_HOOK" "$PROGRESS_FILE" "$issues_file"
  else
    "$CODEX_HOOK" "$PROGRESS_FILE" "$issues_file"
  fi
}

process_tasks_until_done() {
  local issues_file="$1"
  local round=0
  local max_rounds="$CODEX_MAX_ROUNDS"
  if [ "$max_rounds" -le 0 ]; then
    max_rounds="$(count_pending_tasks)"
  fi
  while has_pending_tasks; do
    round=$((round + 1))
    if [ "$max_rounds" -gt 0 ] && [ "$round" -gt "$max_rounds" ]; then
      log "ERROR: exceeded CODEX_MAX_ROUNDS=$max_rounds with remaining tasks."
      exit 1
    fi
    run_codex_once "$issues_file"
    sleep 1
  done
  run_tests
}

run_tests() {
  log "Running tests: $TEST_CMD"
  local test_env="SERVER_URL=$SERVER_URL"
  if [ "$USE_CONTAINER_TESTS" = "true" ] && command -v podman > /dev/null 2>&1; then
    if podman ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      if podman exec -e SERVER_URL="$SERVER_URL" "$CONTAINER_NAME" sh -lc "$TEST_CMD"; then
        return
      fi
      log "Container tests failed; falling back to host."
    fi
  fi

  if [ "$USE_CONTAINER_TESTS" = "true" ] && command -v docker > /dev/null 2>&1; then
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      if docker exec -e SERVER_URL="$SERVER_URL" "$CONTAINER_NAME" sh -lc "$TEST_CMD"; then
        return
      fi
      log "Container tests failed; falling back to host."
    fi
  fi

  sh -lc "$test_env $TEST_CMD"
}

duration="$START_MINUTES"
loop_count=0

while true; do
  loop_count=$((loop_count + 1))
  if [ "$MAX_LOOPS" -gt 0 ] && [ "$loop_count" -gt "$MAX_LOOPS" ]; then
    log "Reached MAX_LOOPS (${MAX_LOOPS}). Exiting."
    exit 0
  fi
  log "=== Loop $loop_count: duration ${duration} minutes ==="
  ensure_server

  if [ "$RESUME_PENDING_TASKS" = "true" ] && [ -f "$PROGRESS_FILE" ] && has_pending_tasks; then
    log "Pending tasks detected in $PROGRESS_FILE; resuming without new analysis."
    process_tasks_until_done ""
    log "Feedback tasks complete; restarting loop."
    if [ "$SLEEP_BETWEEN_LOOPS_SECONDS" -gt 0 ]; then
      sleep "$SLEEP_BETWEEN_LOOPS_SECONDS"
    fi
    continue
  fi

  interval="$COLLECTION_INTERVAL_SECONDS"
  if [ -z "$interval" ]; then
    if [ "$duration" -le 5 ]; then
      interval=10
    else
      interval=30
    fi
  fi

  data_file="$(run_collection "$duration" "$interval")"
  if ! report_file="$(analyze_data "$data_file")"; then
    log "ERROR: analysis unavailable; aborting loop."
    exit 1
  fi
  issues_file="$(mktemp)"
  extract_issues "$report_file" > "$issues_file"

  if [ ! -s "$issues_file" ]; then
    log "No issues detected. Increasing duration by ${INCREMENT_MINUTES} minutes."
    duration=$((duration + INCREMENT_MINUTES))
    if [ "$MAX_MINUTES" -gt 0 ] && [ "$duration" -gt "$MAX_MINUTES" ]; then
      log "Reached MAX_MINUTES (${MAX_MINUTES}). Exiting."
      exit 0
    fi
    if [ "$SLEEP_BETWEEN_LOOPS_SECONDS" -gt 0 ]; then
      sleep "$SLEEP_BETWEEN_LOOPS_SECONDS"
    fi
    continue
  fi

  write_progress "$issues_file"
  process_tasks_until_done "$issues_file"
  log "Feedback tasks complete; restarting loop."

  if [ "$SLEEP_BETWEEN_LOOPS_SECONDS" -gt 0 ]; then
    sleep "$SLEEP_BETWEEN_LOOPS_SECONDS"
  fi
done
