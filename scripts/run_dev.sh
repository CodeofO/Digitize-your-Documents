#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://${BACKEND_HOST}:${BACKEND_PORT}}"

if [[ ! -x "${ROOT_DIR}/.venv/bin/python" ]]; then
  echo "Missing .venv. Create it first:"
  echo "  uv venv --python 3.11 .venv"
  echo "  uv pip install -e 'backend[dev]'"
  exit 1
fi

if [[ ! -d "${ROOT_DIR}/frontend/node_modules" ]]; then
  echo "Installing frontend dependencies..."
  (cd "${ROOT_DIR}/frontend" && npm install)
fi

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then kill "${BACKEND_PID}" 2>/dev/null || true; fi
  if [[ -n "${FRONTEND_PID:-}" ]]; then kill "${FRONTEND_PID}" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

echo "Starting backend:  http://${BACKEND_HOST}:${BACKEND_PORT}"
(
  cd "${ROOT_DIR}"
  "${ROOT_DIR}/.venv/bin/python" -m uvicorn app.main:app \
    --app-dir backend \
    --host "${BACKEND_HOST}" \
    --port "${BACKEND_PORT}"
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
echo "Digitize Your Document is starting."
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
