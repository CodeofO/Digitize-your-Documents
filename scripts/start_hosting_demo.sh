#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="${DEMO_DIR:-/private/tmp/document-automation-workspace-demo}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-18080}"
ACCESS_CODE="${APP_ACCESS_SECRET:-${ACCESS_CODE:-document-demo-access}}"
SESSION_SECRET_KEY="${SESSION_SECRET_KEY:-document-demo-session-secret}"
NGROK_URL="${NGROK_URL:-}"
DEMO_DETACH="${DEMO_DETACH:-false}"
SERVER_LOG="${DEMO_DIR}/server.log"
NGROK_LOG="${DEMO_DIR}/ngrok.log"
SERVER_PID_FILE="${DEMO_DIR}/server.pid"
NGROK_PID_FILE="${DEMO_DIR}/ngrok.pid"
URL_FILE="${DEMO_DIR}/demo_url.txt"

mkdir -p "${DEMO_DIR}/documents" "${DEMO_DIR}/raw" "${DEMO_DIR}/processing"

cd "${ROOT_DIR}/frontend"
npm run build
cd "${ROOT_DIR}"

server_env=(
  APP_ENV=production
  ACCESS_CONTROL_MODE=shared_secret
  APP_ACCESS_SECRET="${ACCESS_CODE}"
  SESSION_SECRET_KEY="${SESSION_SECRET_KEY}"
  SESSION_TTL_SECONDS="${SESSION_TTL_SECONDS:-3600}"
  SESSION_COOKIE_SECURE=true
  SESSION_COOKIE_SAMESITE=lax
  DATABASE_URL="sqlite:///${DEMO_DIR}/demo.db"
  DOCUMENT_STORAGE_DIR="${DEMO_DIR}/documents"
  RAW_STORAGE_DIR="${DEMO_DIR}/raw"
  PROCESSING_TMP_DIR="${DEMO_DIR}/processing"
  STORAGE_BACKEND=local
  UPLOAD_RETENTION_HOURS="${UPLOAD_RETENTION_HOURS:-24}"
  RETENTION_CLEANUP_INTERVAL_SECONDS="${RETENTION_CLEANUP_INTERVAL_SECONDS:-3600}"
  SECURITY_HEADERS_ENABLED=true
  ALLOW_RUNTIME_SETTINGS=false
  SERVE_FRONTEND=true
  FRONTEND_DIST_DIR="${ROOT_DIR}/frontend/dist"
  VLM_PROVIDER="${VLM_PROVIDER:-mock}"
  VLM_MODEL_NAME="${VLM_MODEL_NAME:-mock-vlm}"
  BATCH_MAX_WORKERS="${BATCH_MAX_WORKERS:-2}"
  PYTHONDONTWRITEBYTECODE=1
)
server_cmd=(
  "${ROOT_DIR}/.venv/bin/python"
  -m uvicorn app.main:app
  --app-dir "${ROOT_DIR}/backend"
  --host "${HOST}"
  --port "${PORT}"
)

if [[ "${DEMO_DETACH}" == "true" ]]; then
  nohup env "${server_env[@]}" "${server_cmd[@]}" >"${SERVER_LOG}" 2>&1 &
else
  env "${server_env[@]}" "${server_cmd[@]}" >"${SERVER_LOG}" 2>&1 &
fi

SERVER_PID=$!
echo "${SERVER_PID}" >"${SERVER_PID_FILE}"

cleanup() {
  if [[ -n "${NGROK_PID:-}" ]]; then kill "${NGROK_PID}" 2>/dev/null || true; fi
  kill "${SERVER_PID}" 2>/dev/null || true
}
if [[ "${DEMO_DETACH}" != "true" ]]; then
  trap cleanup EXIT INT TERM
fi

sleep 2

ngrok_cmd=(ngrok http "${PORT}" --log="${NGROK_LOG}")
if [[ -n "${NGROK_URL}" ]]; then
  ngrok_cmd+=(--url "${NGROK_URL}")
fi

if [[ "${DEMO_DETACH}" == "true" ]]; then
  nohup "${ngrok_cmd[@]}" >/dev/null 2>&1 &
else
  "${ngrok_cmd[@]}" &
fi

NGROK_PID=$!
echo "${NGROK_PID}" >"${NGROK_PID_FILE}"
sleep 3

DEMO_URL=""
for _ in {1..20}; do
  DEMO_URL="$(
    curl -s http://127.0.0.1:4040/api/tunnels |
      "${ROOT_DIR}/.venv/bin/python" -c 'import json,sys; data=json.load(sys.stdin); print(next((t["public_url"] for t in data.get("tunnels", []) if t.get("proto") == "https"), ""))'
  )"
  if [[ -n "${DEMO_URL}" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "${DEMO_URL}" ]]; then
  echo "Could not read ngrok demo URL. Check ${NGROK_LOG}." >&2
  exit 1
fi

printf "%s\n" "${DEMO_URL}" >"${URL_FILE}"

echo
echo "Demo URL: ${DEMO_URL}"
echo "Access URL: ${DEMO_URL}/#access=${ACCESS_CODE}"
echo "Local URL: http://${HOST}:${PORT}"
echo "Data dir: ${DEMO_DIR}"
echo
echo "Press Ctrl+C to stop."

if [[ "${DEMO_DETACH}" == "true" ]]; then
  trap - EXIT INT TERM
  echo "Detached. Stop with: DEMO_DIR=${DEMO_DIR} ./scripts/stop_hosting_demo.sh"
  exit 0
fi

wait
