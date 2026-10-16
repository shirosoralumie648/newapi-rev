#!/usr/bin/env bash
# Build (when backend sources changed) and start a throwaway new-api
# instance backed by SQLite for the Playwright end-to-end tests.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_DIR="${E2E_BACKEND_DIR:-${TMPDIR:-/tmp}/new-api-e2e}"
BIN="$RUN_DIR/new-api-e2e"

if [ "${E2E_RESET_DB:-0}" = "1" ]; then
  rm -f "$RUN_DIR"/one-api.db "$RUN_DIR"/one-api.db-* "$RUN_DIR"/one-api.db.*
fi

mkdir -p "$RUN_DIR"

if [ ! -x "$BIN" ] || [ -n "$(find "$REPO_ROOT" -name '*.go' -not -path "$REPO_ROOT/web/*" -newer "$BIN" -print -quit)" ]; then
  echo "[e2e-backend] building $BIN"
  (cd "$REPO_ROOT" && go build -o "$BIN" .)
fi

export PORT="${E2E_BACKEND_PORT:-3300}"
export SQLITE_PATH="$RUN_DIR/one-api.db?_pragma=busy_timeout(30000)&_pragma=journal_mode(WAL)&_txlock=immediate"
export GLOBAL_API_RATE_LIMIT_ENABLE=false
export GLOBAL_WEB_RATE_LIMIT_ENABLE=false
export CRITICAL_RATE_LIMIT_ENABLE=false

cd "$RUN_DIR"
exec "$BIN"
