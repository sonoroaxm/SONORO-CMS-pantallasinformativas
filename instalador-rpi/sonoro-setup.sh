#!/bin/bash
# ============================================================
# SONORO AV — Script de instalación maestra RPi4
# Versión: 1.0
# Uso: sudo bash sonoro-setup.sh
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── COLORES ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

# ── VERIFICAR ROOT ───────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  err "Ejecutar como root: sudo bash sonoro-setup.sh"
fi

# ── CONFIGURACIÓN ────────────────────────────────────────────
CMS_URL="https://cms.sonoro.com.co"
SONORO_USER="sonoro"
PLAYER_DIR="/home/${SONORO_USER}/sonoro-player"
MEDIA_DIR="/home/${SONORO_USER}/media"
SERVICE_NAME="sonoro-player"

echo -e "\n${CYAN}"
echo "  ███████╗ ██████╗ ███╗   ██╗ ██████╗ ██████╗  ██████╗ "
echo "  ██╔════╝██╔═══██╗████╗  ██║██╔═══██╗██╔══██╗██╔═══██╗"
echo "  ███████╗██║   ██║██╔██╗ ██║██║   ██║██████╔╝██║   ██║"
echo "  ╚════██║██║   ██║██║╚██╗██║██║   ██║██╔══██╗██║   ██║"
echo "  ███████║╚██████╔╝██║ ╚████║╚██████╔╝██║  ██║╚██████╔╝"
echo "  ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ "
echo -e "${NC}"
echo "  CMS Digital Signage — Instalación RPi4"
echo "  Servidor: ${CMS_URL}"
echo ""

# ── PASO 1: USUARIO SONORO ───────────────────────────────────
step "1/10 Configurando usuario sonoro"
if ! id "${SONORO_USER}" &>/dev/null; then
  useradd -m -s /bin/bash "${SONORO_USER}"
  usermod -aG sudo,video,audio,render "${SONORO_USER}"
  log "Usuario ${SONORO_USER} creado"
else
  log "Usuario ${SONORO_USER} ya existe"
fi

# Permitir sudo sin contraseña para comandos del player
echo "${SONORO_USER} ALL=(ALL) NOPASSWD: /sbin/reboot, /bin/systemctl restart ${SERVICE_NAME}, /bin/systemctl start ${SERVICE_NAME}, /bin/systemctl stop ${SERVICE_NAME}" > /etc/sudoers.d/sonoro
chmod 440 /etc/sudoers.d/sonoro
log "Sudo configurado para ${SONORO_USER}"

# ── PASO 2: ACTUALIZAR SISTEMA ───────────────────────────────
step "2/10 Actualizando sistema"
apt-get update -qq
apt-get upgrade -y -qq
log "Sistema actualizado"

# ── PASO 3: DEPENDENCIAS ─────────────────────────────────────
step "3/10 Instalando dependencias"
apt-get install -y -qq \
  curl wget git \
  mpv \
  grim \
  swaybg \
  wlr-randr \
  wlrctl \
  plymouth plymouth-themes \
  openssh-server \
  unzip \
  jq \
  ffmpeg \
  espeak-ng \
  pipewire pipewire-alsa wireplumber \
  fonts-montserrat \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  v4l-utils
log "Dependencias instaladas"

# Instalar Piper TTS
step "3b/10 Instalando Piper TTS"
PIPER_DIR="/home/${SONORO_USER}/piper"
PIPER_VOICES_DIR="/home/${SONORO_USER}/piper-voices"
mkdir -p "${PIPER_DIR}" "${PIPER_VOICES_DIR}"
if [ ! -f "${PIPER_DIR}/piper" ]; then
  wget -q -O /tmp/piper.tar.gz "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz"
  tar -xzf /tmp/piper.tar.gz -C "/home/${SONORO_USER}/"
  rm /tmp/piper.tar.gz
  log "Piper TTS instalado"
else
  log "Piper TTS ya instalado"
fi
if [ ! -f "${PIPER_VOICES_DIR}/es_MX-claude-high.onnx" ]; then
  wget -q -O "${PIPER_VOICES_DIR}/es_MX-claude-high.onnx" \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_MX/claude/high/es_MX-claude-high.onnx"
  wget -q -O "${PIPER_VOICES_DIR}/es_MX-claude-high.onnx.json" \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_MX/claude/high/es_MX-claude-high.onnx.json"
  log "Voz Piper es_MX descargada"
else
  log "Voz Piper ya instalada"
fi
chown -R "${SONORO_USER}:${SONORO_USER}" "${PIPER_DIR}" "${PIPER_VOICES_DIR}"

# ── PASO 4: NODE.JS ──────────────────────────────────────────
step "4/10 Instalando Node.js v20"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs
  log "Node.js $(node -v) instalado"
else
  log "Node.js $(node -v) ya instalado"
fi

# ── PASO 5: PM2 ──────────────────────────────────────────────
step "5/10 Instalando PM2"
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 --quiet
  log "PM2 instalado"
else
  log "PM2 ya instalado"
fi

# ── PASO 6: DIRECTORIOS Y ARCHIVOS ───────────────────────────
step "6/10 Creando estructura de directorios"
mkdir -p "${PLAYER_DIR}"
mkdir -p "${MEDIA_DIR}"
chown -R "${SONORO_USER}:${SONORO_USER}" "/home/${SONORO_USER}"
log "Directorios creados"

# ── PASO 7: DEVICE_ID DESDE MAC ──────────────────────────────
step "7/10 Generando DEVICE_ID"
# Obtener MAC de la interfaz principal (eth0 o wlan0)
MAC=$(cat /sys/class/net/eth0/address 2>/dev/null || cat /sys/class/net/wlan0/address 2>/dev/null || echo "unknown")
DEVICE_ID="rpi-$(echo $MAC | tr -d ':' | tr '[:upper:]' '[:lower:]')"
log "DEVICE_ID: ${DEVICE_ID}"

# ── PASO 8: ARCHIVO .ENV ─────────────────────────────────────
step "8/10 Configurando .env"
cat > "${PLAYER_DIR}/.env" << EOF
CMS_URL=${CMS_URL}
DEVICE_ID=${DEVICE_ID}
DISPLAY_MODE=mirror
IMAGE_DURATION=15000
HDMI0_PLAYLIST=
HDMI1_PLAYLIST=
ORIENTATION_HDMI0=auto
ORIENTATION_HDMI1=auto
EOF
chown "${SONORO_USER}:${SONORO_USER}" "${PLAYER_DIR}/.env"
log ".env creado con DEVICE_ID=${DEVICE_ID}"

# ── PASO 9: DESCARGAR SYNC-APP.JS ────────────────────────────
step "9/10 Descargando sync-app.js desde CMS"
if wget -q -O "${PLAYER_DIR}/sync-app.js" "${CMS_URL}/sync-app.js" 2>/dev/null; then
  log "sync-app.js descargado desde ${CMS_URL}"
else
  warn "No se pudo conectar al CMS. El player descargará sync-app.js al primer arranque."
  # Crear un sync-app.js mínimo de espera
  cat > "${PLAYER_DIR}/sync-app.js" << 'SYNCEOF'
require('dotenv').config();
const axios = require('axios');
const CMS_URL = process.env.CMS_URL || 'https://cms.sonoro.com.co';
const DEVICE_ID = process.env.DEVICE_ID || 'rpi-unknown';
console.log(`\n🎬 SONORO Player — Modo espera`);
console.log(`📡 Intentando conectar a ${CMS_URL}...`);
async function tryConnect() {
  try {
    await axios.get(`${CMS_URL}/api/health`, { timeout: 5000 });
    console.log('✅ CMS disponible. Descargando sync-app.js...');
    const { exec } = require('child_process');
    exec(`wget -O /home/sonoro/sonoro-player/sync-app.js ${CMS_URL}/sync-app.js && sudo systemctl restart sonoro-player`, (e) => {
      if (e) console.error('Error descargando:', e.message);
    });
  } catch(e) {
    console.log('⏳ CMS no disponible, reintentando en 30s...');
    setTimeout(tryConnect, 30000);
  }
}
tryConnect();
SYNCEOF
fi

# Instalar dependencias npm
cd "${PLAYER_DIR}"
cat > package.json << 'EOF'
{
  "name": "sonoro-player",
  "version": "3.2.0",
  "main": "sync-app.js",
  "dependencies": {
    "axios": "^1.6.0",
    "dotenv": "^16.0.0",
    "socket.io-client": "^4.5.4"
  }
}
EOF
sudo -u "${SONORO_USER}" npm install --quiet
sudo -u "${SONORO_USER}" npm install canvas --quiet

# Copiar generate-overlay.js
if [ -f "${SCRIPT_DIR}/generate-overlay.js" ]; then
  cp "${SCRIPT_DIR}/generate-overlay.js" "${PLAYER_DIR}/generate-overlay.js"
  chown "${SONORO_USER}:${SONORO_USER}" "${PLAYER_DIR}/generate-overlay.js"
  log "generate-overlay.js copiado"
fi

chown -R "${SONORO_USER}:${SONORO_USER}" "${PLAYER_DIR}"
log "Dependencias npm instaladas"

# ── CONTROL CEC TV ───────────────────────────────────────────
step "CEC Control de TV"
TV_CTL_DIR="/home/${SONORO_USER}/tv-ctl"
mkdir -p "${TV_CTL_DIR}"
if [ -f "${SCRIPT_DIR}/tv-ctl.sh" ]; then
  cp "${SCRIPT_DIR}/tv-ctl.sh" "${TV_CTL_DIR}/tv-ctl.sh"
  chmod +x "${TV_CTL_DIR}/tv-ctl.sh"
  chown -R "${SONORO_USER}:${SONORO_USER}" "${TV_CTL_DIR}"
  log "tv-ctl.sh instalado en ${TV_CTL_DIR}"
else
  warn "tv-ctl.sh no encontrado en el paquete — control CEC no disponible"
fi
# Permisos CEC para usuario sonoro (ya tiene grupo video desde paso 1)
usermod -aG video "${SONORO_USER}" 2>/dev/null || true
log "Permisos CEC configurados"

# ── PASO 10: SERVICIO SYSTEMD ────────────────────────────────
step "10/10 Configurando servicio systemd"
cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=SONORO AV Player
After=network-online.target graphical-session.target
Wants=network-online.target

[Service]
Type=simple
User=${SONORO_USER}
WorkingDirectory=${PLAYER_DIR}
ExecStart=/usr/bin/node ${PLAYER_DIR}/sync-app.js
Restart=always
RestartSec=10
Environment=HOME=/home/${SONORO_USER}
Environment=WAYLAND_DISPLAY=wayland-0
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=DISPLAY=:0

[Install]
WantedBy=graphical-session.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
log "Servicio ${SERVICE_NAME} habilitado"

# ── SSH SIN CONTRASEÑA DESDE SERVIDOR CMS ───────────────────
step "Configurando acceso SSH desde servidor CMS"
mkdir -p "/home/${SONORO_USER}/.ssh"
chmod 700 "/home/${SONORO_USER}/.ssh"
touch "/home/${SONORO_USER}/.ssh/authorized_keys"
chmod 600 "/home/${SONORO_USER}/.ssh/authorized_keys"
chown -R "${SONORO_USER}:${SONORO_USER}" "/home/${SONORO_USER}/.ssh"
warn "IMPORTANTE: Agrega la clave pública del servidor CMS en:"
warn "  /home/${SONORO_USER}/.ssh/authorized_keys"
warn "  Ver guía en cms.sonoro.com.co/docs/ssh-setup"

# ── RESUMEN FINAL ────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✓ Instalación completada${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  DEVICE_ID : ${DEVICE_ID}"
echo "  CMS URL   : ${CMS_URL}"
echo "  Player    : ${PLAYER_DIR}/sync-app.js"
echo "  Media     : ${MEDIA_DIR}"
echo "  Servicio  : systemctl status ${SERVICE_NAME}"
echo ""
echo "  Próximos pasos:"
echo "  1. Reiniciar: sudo reboot"
echo "  2. Desde el CMS, buscar el dispositivo: ${DEVICE_ID}"
echo "  3. Asignarle nombre y playlist"
echo ""
