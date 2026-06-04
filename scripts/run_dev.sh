#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://${BACKEND_HOST}:${BACKEND_PORT}}"
BACKEND_RELOAD="${BACKEND_RELOAD:-true}"

if [[ ! -x "${ROOT_DIR}/.venv/bin/python" ]]; then
  echo "Missing .venv. Create it first:"
  echo "  uv venv --python 3.11 .venv"
  echo "  uv pip install -e 'backend[dev]'"
  exit 1
fi

if ! "${ROOT_DIR}/.venv/bin/python" - <<'PY' >/dev/null 2>&1
import bleach
import fastapi
import google.genai
import pymupdf
import uvicorn
import uvicorn.middleware.asgi2
import uvicorn.protocols.http.h11_impl
PY
then
  echo "Backend dependencies look incomplete. Refresh the uv environment:"
  echo "  uv pip install -e 'backend[dev]'"
  echo "  uv pip install --reinstall 'uvicorn[standard]' fastapi pymupdf bleach google-genai"
  exit 1
fi

echo "Applying database migrations..."
(
  cd "${ROOT_DIR}/backend"
  PYTHONDONTWRITEBYTECODE=1 "${ROOT_DIR}/.venv/bin/python" -m alembic upgrade head
)

install_frontend_dependencies() {
  if [[ -f "${ROOT_DIR}/frontend/package-lock.json" ]]; then
    (cd "${ROOT_DIR}/frontend" && npm ci)
  else
    (cd "${ROOT_DIR}/frontend" && npm install)
  fi
}

if [[ ! -d "${ROOT_DIR}/frontend/node_modules" ]]; then
  echo "Installing frontend dependencies..."
  install_frontend_dependencies
elif [[ ! -f "${ROOT_DIR}/frontend/node_modules/lucide-react/dist/esm/icons/chevron-down.js" ]]; then
  echo "Frontend dependencies look incomplete. Reinstalling from lockfile..."
  install_frontend_dependencies
fi

require_free_port() {
  local label="$1"
  local port="$2"
  local env_name="$3"

  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Cannot start ${label}: port ${port} is already in use."
    echo
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN || true
    echo
    echo "Stop the existing process, or run with a different port:"
    echo "  ${env_name}=<port> ./scripts/run_dev.sh"
    exit 1
  fi
}

require_free_port "backend" "${BACKEND_PORT}" "BACKEND_PORT"
require_free_port "frontend" "${FRONTEND_PORT}" "FRONTEND_PORT"

kill_tree() {
  local pid="$1"
  local child

  if ! kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi

  if command -v pgrep >/dev/null 2>&1; then
    for child in $(pgrep -P "${pid}" 2>/dev/null || true); do
      kill_tree "${child}"
    done
  fi

  kill "${pid}" 2>/dev/null || true
}

cleanup() {
  if [[ -n "${FRONTEND_PID:-}" ]]; then kill_tree "${FRONTEND_PID}"; fi
  if [[ -n "${BACKEND_PID:-}" ]]; then kill_tree "${BACKEND_PID}"; fi
}
trap cleanup EXIT INT TERM

echo "Starting backend:  http://${BACKEND_HOST}:${BACKEND_PORT}"
(
  backend_args=(
    app.main:app
    --app-dir "${ROOT_DIR}/backend"
    --host "${BACKEND_HOST}"
    --port "${BACKEND_PORT}"
  )
  if [[ "${BACKEND_RELOAD}" == "true" ]]; then
    backend_args+=(
      --reload
      --reload-dir "${ROOT_DIR}/backend/app"
      --reload-include "*.py"
    )
  fi
  PYTHONDONTWRITEBYTECODE=1 "${ROOT_DIR}/.venv/bin/python" -m uvicorn "${backend_args[@]}"
) &
BACKEND_PID=$!

echo "Starting frontend: http://${FRONTEND_HOST}:${FRONTEND_PORT}"
(
  cd "${ROOT_DIR}/frontend"
  VITE_API_BASE_URL="${VITE_API_BASE_URL}" \
    npm run dev -- --host "${FRONTEND_HOST}" --port "${FRONTEND_PORT}"
) &
FRONTEND_PID=$!

echo
echo "Document Automation Workspace is starting."
echo "Frontend: http://${FRONTEND_HOST}:${FRONTEND_PORT}"
echo "Backend:  http://${BACKEND_HOST}:${BACKEND_PORT}"
echo "Press Ctrl+C to stop both."
echo

while true; do
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    wait "${BACKEND_PID}" || true
    exit 1
  fi
  if ! kill -0 "${FRONTEND_PID}" 2>/dev/null; then
    wait "${FRONTEND_PID}" || true
    exit 1
  fi
  sleep 1
done
