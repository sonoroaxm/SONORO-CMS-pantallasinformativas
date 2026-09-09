#!/usr/bin/env bash
# ============================================================
# SONORO AV — Bootstrap del installer RPi
# Descarga los archivos companion de instalador-rpi/ a /tmp y
# ejecuta sonoro-setup.sh. Uso:
#   curl -fsSL https://raw.githubusercontent.com/sonoroaxm/SONORO-CMS-pantallasinformativas/main/instalador-rpi/sonoro-bootstrap.sh | sudo bash
# Fix S197 fila 59-A: sonoro-setup.sh asume ${SCRIPT_DIR} con todos los
# companions (sync-app.js, player-rpi5.js, activation-portal.js, splash png,
# plymouth-sonoro/, units .service). Bajar solo setup.sh via 1-liner falla
# en 5/9 con "cannot stat '/tmp/sync-app.js'". Este wrapper hace git clone
# --depth 1 + cp + exec setup.
# ============================================================
set -euo pipefail

REPO="${SONORO_INSTALLER_REPO:-https://github.com/sonoroaxm/SONORO-CMS-pantallasinformativas.git}"
BRANCH="${SONORO_INSTALLER_BRANCH:-main}"
TMP_REPO="/tmp/sonoro-installer-repo"
TMP_STAGE="/tmp"

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: ejecutar como root (sudo bash)" >&2
  exit 1
fi

command -v git >/dev/null 2>&1 || {
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq git >/dev/null 2>&1
}

echo "[bootstrap] clonando ${REPO}@${BRANCH} (shallow)"
rm -rf "$TMP_REPO"
git clone --depth 1 --branch "$BRANCH" "$REPO" "$TMP_REPO" >/dev/null

echo "[bootstrap] copiando instalador-rpi/* a ${TMP_STAGE}"
cp -r "${TMP_REPO}/instalador-rpi/." "${TMP_STAGE}/"
chmod +x "${TMP_STAGE}"/*.sh 2>/dev/null || true

echo "[bootstrap] handoff a sonoro-setup.sh"
exec bash "${TMP_STAGE}/sonoro-setup.sh" "$@"
