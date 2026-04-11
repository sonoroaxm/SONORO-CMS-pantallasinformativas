#!/bin/bash
# SONORO AV CMS — Instalador RPi v3.5
# Ejecutar como: sudo bash sonoro-setup.sh

set -e
DEVICE_ID="rpi4-cliente-01"
CMS_URL="https://cms.sonoro.com.co"
SONORO_USER="sonoro"
PLAYER_DIR="/home/${SONORO_USER}/sonoro-player"
MEDIA_DIR="/home/${SONORO_USER}/media"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
step() { echo -e "\n${GREEN}━━━ $1 ━━━${NC}"; }

step "1/8 Actualizando sistema"
apt-get update -qq && apt-get upgrade -y -qq

step "2/8 Instalando dependencias"
# espeak-ng se mantiene como fallback pero Piper es el motor principal de TTS
apt-get install -y -qq curl wget git mpv grim swaybg wlr-randr openssh-server unzip ffmpeg \
  espeak-ng alsa-utils pipewire pipewire-alsa wireplumber v4l-utils autossh qrencode
log "Dependencias instaladas"

step "2b/8 Instalando Piper TTS (voz neural offline)"
PIPER_DIR="/home/${SONORO_USER}/piper"
PIPER_VERSION="2023.11.14-2"
PIPER_ARCH="aarch64"   # RPi4 ARM64
PIPER_TAR="piper_${PIPER_ARCH}.tar.gz"
PIPER_URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${PIPER_TAR}"

if [ ! -f "/usr/local/bin/piper" ]; then
  log "Descargando Piper ${PIPER_VERSION}..."
  TMP_DIR=$(mktemp -d)
  wget -q "${PIPER_URL}" -O "${TMP_DIR}/${PIPER_TAR}"
  tar -xzf "${TMP_DIR}/${PIPER_TAR}" -C "${TMP_DIR}"
  cp "${TMP_DIR}/piper/piper" /usr/local/bin/piper
  chmod +x /usr/local/bin/piper
  rm -rf "${TMP_DIR}"
  log "Piper instalado en /usr/local/bin/piper"
else
  log "Piper ya instalado: $(/usr/local/bin/piper --version 2>&1 | head -1)"
fi

# Voz latinoamericana — es_MX-claude-high
mkdir -p "${PIPER_DIR}"
VOICE_ONNX="${PIPER_DIR}/es_MX-claude-high.onnx"
VOICE_JSON="${PIPER_DIR}/es_MX-claude-high.onnx.json"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_MX/claude/high"

if [ ! -f "${VOICE_ONNX}" ]; then
  log "Descargando voz latinoamericana (es_MX-claude-high)..."
  wget -q "${VOICE_BASE}/es_MX-claude-high.onnx"      -O "${VOICE_ONNX}"
  wget -q "${VOICE_BASE}/es_MX-claude-high.onnx.json" -O "${VOICE_JSON}"
  chown -R ${SONORO_USER}:${SONORO_USER} "${PIPER_DIR}"
  log "Voz instalada en ${PIPER_DIR}"
else
  log "Voz latinoamericana ya instalada"
fi

step "3/8 Instalando Node.js"
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
log "Node.js $(node --version)"

step "4/8 Configurando directorios"
mkdir -p "${PLAYER_DIR}" "${MEDIA_DIR}"
chown -R ${SONORO_USER}:${SONORO_USER} "/home/${SONORO_USER}"

step "5/8 Instalando player"
cp "${SCRIPT_DIR}/sync-app.js" "${PLAYER_DIR}/"
cp "${SCRIPT_DIR}/activation-portal.js" "${PLAYER_DIR}/"
cp "${SCRIPT_DIR}/package.json" "${PLAYER_DIR}/"
cd "${PLAYER_DIR}" && npm install --quiet
cat > "${PLAYER_DIR}/.env" << ENV
CMS_URL=${CMS_URL}
DEVICE_ID=${DEVICE_ID}
ENV
log "Player instalado"

step "6/8 Configurando servicio"
cat > /etc/systemd/system/sonoro-player.service << SVC
[Unit]
Description=SONORO AV Player
After=network.target graphical.target
[Service]
User=${SONORO_USER}
WorkingDirectory=${PLAYER_DIR}
EnvironmentFile=${PLAYER_DIR}/.env
ExecStart=/usr/bin/node ${PLAYER_DIR}/sync-app.js
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
SVC
systemctl daemon-reload && systemctl enable sonoro-player
log "Servicio habilitado"

step "7/8 Configurando tunnel SSH"
TUNNEL_KEY="/home/${SONORO_USER}/.ssh/vps_tunnel"
mkdir -p "/home/${SONORO_USER}/.ssh"
chmod 700 "/home/${SONORO_USER}/.ssh"
if [ ! -f "${TUNNEL_KEY}" ]; then
  sudo -u "${SONORO_USER}" ssh-keygen -t ed25519 -f "${TUNNEL_KEY}" -N "" -q
fi
cat > /etc/systemd/system/sonoro-tunnel.service << TUN
[Unit]
Description=SONORO SSH Tunnel
After=network.target
[Service]
User=${SONORO_USER}
ExecStart=/usr/bin/autossh -M 0 -N -R 2222:localhost:22 -i ${TUNNEL_KEY} -o StrictHostKeyChecking=no -o ServerAliveInterval=30 debian@45.181.156.171
Restart=always
RestartSec=15
[Install]
WantedBy=multi-user.target
TUN
systemctl daemon-reload && systemctl enable sonoro-tunnel
log "Tunnel SSH configurado"

step "8/8 Instalacion completada"
TUNNEL_PUBKEY=$(cat "${TUNNEL_KEY}.pub" 2>/dev/null || echo "")
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  SONORO AV CMS v3.5 instalado${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  DEVICE_ID : ${DEVICE_ID}"
echo "  CMS URL   : ${CMS_URL}"
echo ""
echo -e "${YELLOW}  HOTSPOT EMERGENCIA:${NC}"
echo "  Red:   SCMS-$(echo ${DEVICE_ID} | sed 's/rpi4-//' | tr '[:lower:]' '[:upper:]' | rev | cut -c1-6 | rev)"
echo "  Clave: sonorocms"
echo ""
warn "AGREGAR CLAVE PUBLICA AL VPS:"
warn "  echo \"${TUNNEL_PUBKEY}\" >> ~/.ssh/authorized_keys"
echo ""
echo "  Reiniciar: sudo reboot"
