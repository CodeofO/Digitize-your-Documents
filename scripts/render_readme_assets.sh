#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/assets/readme-src"
OUT_DIR="$ROOT_DIR/assets/readme"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -x "$CHROME_BIN" ]]; then
  echo "Chrome not found. Set CHROME_BIN to a Chromium/Chrome executable." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

render() {
  local name="$1"
  local size="$2"
  "$CHROME_BIN" \
    --headless=new \
    --disable-gpu \
    --hide-scrollbars \
    --force-device-scale-factor=1 \
    "--window-size=$size" \
    "--screenshot=$OUT_DIR/$name.png" \
    "file://$SRC_DIR/$name.html"
}

render overview 1600,1000
render core-modules 1600,1000
render workflow-builder 1600,1000
render workflow-builder-results 1600,1000
