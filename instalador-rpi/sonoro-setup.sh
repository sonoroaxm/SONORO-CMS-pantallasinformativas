#!/bin/bash
# SONORO AV CMS — Instalador RPi v4.0
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
# Fix S168 #8: instalador antes NO copiaba xinitrc.sh — RPis quedaban con drift
# del filesystem base (algunas con xinitrc viejo sin touch /tmp/sonoro-x11-ready
# ni tier-awareness). Ahora copia y setea permisos.
cp "${SCRIPT_DIR}/xinitrc.sh" "${PLAYER_DIR}/"
chmod +x "${PLAYER_DIR}/xinitrc.sh"
# Fix S168 #7: tier default para xinitrc HDMI enforcement. Cambia a doble|pro si
# el device es tier superior antes de shipping. RPi5 solo soporta sencilla hoy
# (memoria project_producto1_licencias.md + D4 en RPI5-READINESS).
if [ ! -f /etc/default/sonoro ]; then
  cat > /etc/default/sonoro << DEF
# SONORO AV — configuracion runtime del RPi
# SONORO_TIER: sencilla|doble|pro (afecta xinitrc.sh HDMI enforcement).
SONORO_TIER=sencilla
DEF
  log "/etc/default/sonoro creado (SONORO_TIER=sencilla)"
fi
# Ejecutar npm install como usuario sonoro (bug S168 #3: evita node_modules root-owned)
sudo -u "${SONORO_USER}" bash -c "cd '${PLAYER_DIR}' && npm install --omit=dev --quiet"
cat > "${PLAYER_DIR}/.env" << ENV
CMS_URL=${CMS_URL}
DEVICE_ID=${DEVICE_ID}
ENV
log "Player instalado"

step "6/8 Configurando servicio"
# Fix S168 #1+#5: usar sonoro-player.service del instalador (tiene Environment DISPLAY/XAUTHORITY,
# After sonoro-x11.service, ExecStartPre que espera al X11 listo). Antes se generaba inline un
# service pobre que rompia detectar orientacion y splash porque no exportaba DISPLAY.
cp "${SCRIPT_DIR}/sonoro-player.service" /etc/systemd/system/sonoro-player.service
systemctl daemon-reload && systemctl enable sonoro-player
log "Servicio habilitado"

# Fix S168 #1: arrancar el service y verificar que corre. Antes el instalador terminaba con el
# service enabled pero NUNCA started; el operador tenia que acordarse de correr systemctl start
# a mano (§4.1 del navegable). Ahora es automatico y falla temprano si algo esta mal.
step "6a/8 Preflight de dependencias Node.js"
if ! sudo -u "${SONORO_USER}" node -e "['axios','dotenv','form-data','socket.io-client'].forEach(m => require(m))" 2>/dev/null; then
  echo "[ERR] Faltan dependencias Node.js en ${PLAYER_DIR}/node_modules. Reintentar 'npm install' como usuario ${SONORO_USER}." >&2
  exit 1
fi
log "Dependencias Node.js OK (axios, dotenv, form-data, socket.io-client)"

step "6b/8 Iniciando sonoro-player"
systemctl start sonoro-player
sleep 5
if ! systemctl is-active --quiet sonoro-player; then
  echo "[ERR] sonoro-player.service no arranco. Ver logs:" >&2
  journalctl -u sonoro-player -n 40 --no-pager >&2
  exit 1
fi
log "sonoro-player arrancado y verificado activo"


step "6c/8 Deshabilitando WiFi power management"
mkdir -p /etc/NetworkManager/dispatcher.d
cat > /etc/NetworkManager/dispatcher.d/99-disable-wifi-pm << 'PM'
#!/bin/bash
IFACE=$1
ACTION=$2
if [ "$IFACE" = "wlan0" ] && [ "$ACTION" = "up" ]; then
    /usr/sbin/iw dev wlan0 set power_save off
fi
PM
chmod +x /etc/NetworkManager/dispatcher.d/99-disable-wifi-pm
/usr/sbin/iw dev wlan0 set power_save off 2>/dev/null || true
log "WiFi power management deshabilitado (evita desconexiones periodicas)"

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
echo -e "${GREEN}  SONORO AV CMS v4.0 instalado${NC}"
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
