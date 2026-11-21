#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
PLUGINS_DIR="${HOME}/.gemini/config/plugins"
DEST_DIR="${PLUGINS_DIR}/workshop"

echo "Installing Antigravity Plugin Workshop into ${DEST_DIR}..."
mkdir -p "${DEST_DIR}"
cp "${REPO_ROOT}/plugin.json" "${DEST_DIR}/plugin.json"
rm -rf "${DEST_DIR}/sidecars"
cp -R "${REPO_ROOT}/sidecars" "${DEST_DIR}/sidecars"

echo "[OK] Installed! Restart Google Antigravity once, then open Sidebar -> Plugins -> 创意工坊."
