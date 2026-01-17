#!/bin/bash
# Automated economy feedback loop driven by LLM analysis + Codex fixes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

START_MINUTES="${START_MINUTES:-5}"
INCREMENT_MINUTES="${INCREMENT_MINUTES:-5}"
MAX_MINUTES="${MAX_MINUTES:-0}"
SERVER_URL="${SERVER_URL:-http://localhost:3001}"
LM_STUDIO_URL="${LM_STUDIO_URL:-http://localhost:1234}"
CODEX_HOOK="${CODEX_HOOK:-$PROJECT_DIR/scripts/headless-codex.sh}"
PROGRESS_FILE="${PROGRESS_FILE:-$PROJECT_DIR/PROGRESS.md}"
CONTAINER_NAME="${CONTAINER_NAME:-space-trader}"
CONTAINER_COMPOSE_FILE="${CONTAINER_COMPOSE_FILE:-podman-compose.yml}"
USE_CONTAINER_TESTS="${USE_CONTAINER_TESTS:-true}"
TEST_CMD="${TEST_CMD:-npm test}"
COLLECTION_INTERVAL_SECONDS="${COLLECTION_INTERVAL_SECONDS:-}"
SLEEP_BETWEEN_LOOPS_SECONDS="${SLEEP_BETWEEN_LOOPS_SECONDS:-0}"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
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
    npx tsx scripts/collect-economy-data.ts
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
  if ! curl -s "${LM_STUDIO_URL%/}/v1/models" > /dev/null 2>&1; then
    log "LM Studio not reachable at $LM_STUDIO_URL; skipping analysis."
    echo ""
    return 0
  fi

  log "Analyzing data via LM Studio..."
  npx tsx scripts/analyze-with-llm.ts "$data_file"
  local report_file
  report_file="$(latest_file "economy-reports/economy-report-*.md")"
  if [ -z "$report_file" ]; then
    log "WARNING: analysis completed but no report found."
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
    rg -n "Issue Identified|WARNING|ERROR" "$report_file" || true
  else
    grep -nE "Issue Identified|WARNING|ERROR" "$report_file" || true
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
  line="$(echo "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  if [ -n "$line" ]; then
    echo "$line"
  fi
}

write_progress() {
  local issues_file="$1"
  log "Overwriting $PROGRESS_FILE from issues..."
  {
    echo "# Automated Economy Feedback Tasks"
    echo ""
    echo "## Issues"
    while IFS= read -r issue; do
      if [ -n "$issue" ]; then
        echo "- $issue"
      fi
    done < "$issues_file"
    echo ""
    echo "## Tasks (ordered by importance)"
    while IFS= read -r issue; do
      task="$(format_task_line "$issue" || true)"
      if [ -n "${task:-}" ]; then
        echo "- [ ] $task"
      fi
    done < "$issues_file"
  } > "$PROGRESS_FILE"
}

run_codex_until_done() {
  local issues_file="$1"
  if [ ! -x "$CODEX_HOOK" ]; then
    log "ERROR: CODEX_HOOK not executable: $CODEX_HOOK"
    exit 1
  fi

  while true; do
    if command -v rg > /dev/null 2>&1; then
      rg -q "\\[ \\]" "$PROGRESS_FILE" || break
    else
      grep -q "\\[ \\]" "$PROGRESS_FILE" || break
    fi

    log "Invoking headless Codex via $CODEX_HOOK..."
    "$CODEX_HOOK" "$PROGRESS_FILE" "$issues_file"
    sleep 1
  done
}

run_tests() {
  log "Running tests: $TEST_CMD"
  if [ "$USE_CONTAINER_TESTS" = "true" ] && command -v podman > /dev/null 2>&1; then
    if podman ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      podman exec "$CONTAINER_NAME" sh -lc "$TEST_CMD"
      return
    fi
  fi

  if [ "$USE_CONTAINER_TESTS" = "true" ] && command -v docker > /dev/null 2>&1; then
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      docker exec "$CONTAINER_NAME" sh -lc "$TEST_CMD"
      return
    fi
  fi

  sh -lc "$TEST_CMD"
}

duration="$START_MINUTES"
loop_count=0

while true; do
  loop_count=$((loop_count + 1))
  log "=== Loop $loop_count: duration ${duration} minutes ==="
  ensure_server

  interval="$COLLECTION_INTERVAL_SECONDS"
  if [ -z "$interval" ]; then
    if [ "$duration" -le 5 ]; then
      interval=10
    else
      interval=30
    fi
  fi

  data_file="$(run_collection "$duration" "$interval")"
  report_file="$(analyze_data "$data_file")"
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
  run_codex_until_done "$issues_file"
  run_tests
  log "Feedback tasks complete; restarting loop."

  if [ "$SLEEP_BETWEEN_LOOPS_SECONDS" -gt 0 ]; then
    sleep "$SLEEP_BETWEEN_LOOPS_SECONDS"
  fi
done
