#!/usr/bin/env bash
set -euo pipefail

DEMO_DIR="${DEMO_DIR:-/private/tmp/document-automation-workspace-demo}"

for pid_file in "${DEMO_DIR}/ngrok.pid" "${DEMO_DIR}/server.pid"; do
  if [[ -f "${pid_file}" ]]; then
    pid="$(cat "${pid_file}")"
    if [[ -n "${pid}" ]]; then
      kill "${pid}" 2>/dev/null || true
    fi
    rm -f "${pid_file}"
  fi
done

if command -v lsof >/dev/null 2>&1; then
  for port in "${PORT:-18080}" 4040; do
    pids="$(lsof -tiTCP:"${port}" -sTCP:LISTEN || true)"
    if [[ -n "${pids}" ]]; then
      kill ${pids} 2>/dev/null || true
    fi
  done
fi
