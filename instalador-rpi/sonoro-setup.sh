#!/bin/bash
# SONORO AV CMS — Instalador RPi v5.0 (RPi4 + RPi5 nativo)
# Ejecutar como: sudo bash sonoro-setup.sh

set -e
CMS_URL="https://cms.sonoro.com.co"
SONORO_USER="sonoro"
PLAYER_DIR="/home/${SONORO_USER}/sonoro-player"
MEDIA_DIR="/home/${SONORO_USER}/media"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC} $1" >&2; }
step() { echo -e "\n${GREEN}━━━ $1 ━━━${NC}"; }

step "0/9 Deteccion de modelo"
MODEL=$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown)
case "$MODEL" in
  *"Raspberry Pi 5"*)  IS_RPI5=1; SONORO_MODEL=rpi5 ;;
  *"Raspberry Pi 4"*)  IS_RPI5=0; SONORO_MODEL=rpi4 ;;
  *) err "Modelo no soportado: $MODEL"; exit 1 ;;
esac
log "Modelo detectado: $MODEL  → SONORO_MODEL=$SONORO_MODEL"

# Prompt DEVICE_ID (obligatorio) — antes estaba hardcoded a rpi4-cliente-01
DEFAULT_DEVICE_ID="${SONORO_MODEL}-cliente-01"
read -rp "DEVICE_ID [${DEFAULT_DEVICE_ID}]: " DEVICE_ID
DEVICE_ID="${DEVICE_ID:-$DEFAULT_DEVICE_ID}"

# Prompt tier (solo RPi4 hoy — RPi5 forzado sencilla, ver project_producto1_licencias.md)
if [ "$IS_RPI5" = "1" ]; then
  SONORO_TIER="sencilla"
  log "RPi5 → tier forzado sencilla (single HDMI, D4 en RPI5-READINESS)"
else
  read -rp "SONORO_TIER (sencilla|doble|pro) [sencilla]: " SONORO_TIER
  SONORO_TIER="${SONORO_TIER:-sencilla}"
fi

step "1/9 Actualizando sistema"
apt-get update -qq && apt-get upgrade -y -qq

step "2/9 Instalando dependencias"
# Base común (ambos modelos): red, ssh, ffmpeg, TTS, tunnel, utilidades
BASE_PKGS="curl wget git openssh-server unzip ffmpeg espeak-ng alsa-utils \
  pipewire pipewire-alsa wireplumber v4l-utils autossh qrencode network-manager"

if [ "$IS_RPI5" = "1" ]; then
  # RPi5 nativo: ffmpeg vout_drm, sin X11/mpv/openbox/plymouth-en-DRM (bloquean DRM master)
  apt-get install -y -qq $BASE_PKGS
  log "Dependencias RPi5 instaladas (headless, ffmpeg vout_drm)"
else
  # RPi4: flujo actual con mpv + Wayland tools (grim/swaybg/wlr-randr) + X11 vía sonoro-x11.service
  apt-get install -y -qq $BASE_PKGS mpv grim swaybg wlr-randr
  log "Dependencias RPi4 instaladas (mpv + Wayland tools)"
fi

step "2b/9 Instalando Piper TTS (voz neural offline)"
PIPER_DIR="/home/${SONORO_USER}/piper"
PIPER_VERSION="2023.11.14-2"
PIPER_ARCH="linux_aarch64"   # RPi4/RPi5 ARM64 (naming actual del release)
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

step "3/9 Instalando Node.js"
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
log "Node.js $(node --version)"

step "4/9 Configurando directorios"
mkdir -p "${PLAYER_DIR}" "${MEDIA_DIR}"
chown -R ${SONORO_USER}:${SONORO_USER} "/home/${SONORO_USER}"

step "5/9 Instalando player"
cp "${SCRIPT_DIR}/sync-app.js" "${PLAYER_DIR}/"
cp "${SCRIPT_DIR}/activation-portal.js" "${PLAYER_DIR}/"
cp "${SCRIPT_DIR}/package.json" "${PLAYER_DIR}/"
# Splash idle (ambos modelos — sync-app.js los busca en PLAYER_DIR)
cp "${SCRIPT_DIR}/splash_horizontal.png" "${PLAYER_DIR}/" 2>/dev/null || warn "splash_horizontal.png no encontrado"
cp "${SCRIPT_DIR}/splash_vertical.png"   "${PLAYER_DIR}/" 2>/dev/null || warn "splash_vertical.png no encontrado"

if [ "$IS_RPI5" = "1" ]; then
  # RPi5: player nativo ffmpeg vout_drm + concat (S168b — gap 0ms visual)
  cp "${SCRIPT_DIR}/player-rpi5.js" "${PLAYER_DIR}/"
  log "player-rpi5.js copiado"
else
  # Fix S168 #8: xinitrc solo aplica a RPi4 (X11/mpv path).
  cp "${SCRIPT_DIR}/xinitrc.sh" "${PLAYER_DIR}/"
  chmod +x "${PLAYER_DIR}/xinitrc.sh"
fi

# /etc/default/sonoro — SONORO_MODEL + SONORO_TIER + DEVICE_ID (fuente única para services).
# Reescribimos SIEMPRE para que reflash sobre imagen previa no arrastre modelo/tier viejo.
cat > /etc/default/sonoro << DEF
# SONORO AV — configuracion runtime del RPi (generado por sonoro-setup.sh)
SONORO_MODEL=${SONORO_MODEL}
SONORO_TIER=${SONORO_TIER}
DEVICE_ID=${DEVICE_ID}
DEF
log "/etc/default/sonoro escrito (MODEL=${SONORO_MODEL} TIER=${SONORO_TIER} DEVICE_ID=${DEVICE_ID})"

# Ejecutar npm install como usuario sonoro (bug S168 #3: evita node_modules root-owned)
sudo -u "${SONORO_USER}" bash -c "cd '${PLAYER_DIR}' && npm install --omit=dev --quiet"
cat > "${PLAYER_DIR}/.env" << ENV
CMS_URL=${CMS_URL}
DEVICE_ID=${DEVICE_ID}
SONORO_MODEL=${SONORO_MODEL}
ENV
log "Player instalado"

step "6/9 Configurando servicios"
if [ "$IS_RPI5" = "1" ]; then
  # RPi5: sync + player-rpi5 (ffmpeg vout_drm reclama DRM master exclusivo)
  cp "${SCRIPT_DIR}/sonoro-sync-rpi5.service"    /etc/systemd/system/sonoro-sync-rpi5.service
  cp "${SCRIPT_DIR}/sonoro-player-rpi5.service"  /etc/systemd/system/sonoro-player-rpi5.service
  systemctl daemon-reload
  # Mask servicios RPi4 (evita conflicto si imagen previa los tenía). vout_drm no coexiste con X11.
  systemctl mask sonoro-x11.service sonoro-player.service 2>/dev/null || true
  systemctl enable sonoro-sync-rpi5.service sonoro-player-rpi5.service
  log "Services RPi5 habilitados (sync-rpi5 + player-rpi5), RPi4 services enmascarados"
else
  # RPi4: flujo actual X11 + mpv
  cp "${SCRIPT_DIR}/sonoro-player.service" /etc/systemd/system/sonoro-player.service
  systemctl daemon-reload && systemctl enable sonoro-player
  log "Service RPi4 habilitado (sonoro-player)"
fi

step "6a/9 Preflight de dependencias Node.js"
if ! sudo -u "${SONORO_USER}" bash -c "cd '${PLAYER_DIR}' && node -e \"['axios','dotenv','form-data','socket.io-client'].forEach(m => require(m))\"" 2>/dev/null; then
  err "Faltan dependencias Node.js en ${PLAYER_DIR}/node_modules. Reintentar 'npm install' como usuario ${SONORO_USER}."
  exit 1
fi
log "Dependencias Node.js OK (axios, dotenv, form-data, socket.io-client)"

step "6b/9 Iniciando player"
if [ "$IS_RPI5" = "1" ]; then
  systemctl start sonoro-sync-rpi5.service
  sleep 3
  systemctl start sonoro-player-rpi5.service
  sleep 5
  for svc in sonoro-sync-rpi5 sonoro-player-rpi5; do
    if ! systemctl is-active --quiet "$svc"; then
      err "${svc}.service no arranco. Logs:"
      journalctl -u "$svc" -n 40 --no-pager >&2
      exit 1
    fi
  done
  log "sonoro-sync-rpi5 + sonoro-player-rpi5 activos"
else
  systemctl start sonoro-player
  sleep 5
  if ! systemctl is-active --quiet sonoro-player; then
    err "sonoro-player.service no arranco. Logs:"
    journalctl -u sonoro-player -n 40 --no-pager >&2
    exit 1
  fi
  log "sonoro-player arrancado y verificado activo"
fi

if [ "$IS_RPI5" = "1" ]; then
  step "6b.1/9 Boot headless (multi-user.target)"
  # RPi5: ffmpeg vout_drm necesita DRM master exclusivo. labwc/LXDE-Pi arranca en
  # graphical.target y toma DRM → ffmpeg falla. Signage puro = sin desktop.
  # getty@tty2 (habilitado en 6c) sigue disponible como fallback local.
  systemctl set-default multi-user.target
  log "Default target = multi-user.target (labwc no arrancara al boot)"
fi

step "6c/9 Vias de recuperacion (leccion S168b brick seguritech)"
# Regla de oro: en RPi5 nativo SIEMPRE al menos UNA via de recuperacion abierta
# (getty en algun TTY + ethernet autoconnect). Cerrarlas todas = brick remoto.
#
# 6c.1 — Ethernet autoconnect: perfil NM al lado de netplan-generated.
#        NM lee ambos; el que tenga autoconnect + prioridad más alta gana.
NM_DIR="/etc/NetworkManager/system-connections"
mkdir -p "$NM_DIR"
if [ -f "${SCRIPT_DIR}/nm-wired-fallback.nmconnection" ]; then
  cp "${SCRIPT_DIR}/nm-wired-fallback.nmconnection" "${NM_DIR}/sonoro-wired-fallback.nmconnection"
  chmod 600 "${NM_DIR}/sonoro-wired-fallback.nmconnection"
  chown root:root "${NM_DIR}/sonoro-wired-fallback.nmconnection"
  nmcli connection reload 2>/dev/null || true
  log "Ethernet fallback autoconnect instalado (sonoro-wired-fallback)"
else
  warn "nm-wired-fallback.nmconnection no encontrado — saltando (revisar SCRIPT_DIR)"
fi

# 6c.2 — getty@tty2 accesible: en RPi5 ffmpeg vout_drm toma tty1, dejamos tty2 libre.
#        En RPi4 tty1 la usa X11; también dejamos tty2 como redundancia.
systemctl unmask getty@tty2.service 2>/dev/null || true
systemctl enable getty@tty2.service 2>/dev/null || true
systemctl start  getty@tty2.service 2>/dev/null || true
log "getty@tty2 habilitado (Ctrl+Alt+F2 fallback)"

# 6c.3 — SSH password auth ON (en fresh Bookworm ya viene, aseguramos).
if [ -f /etc/ssh/sshd_config ]; then
  sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  log "SSH PasswordAuthentication yes"
fi

step "6d/9 Deshabilitando WiFi power management"
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

step "7/9 Configurando tunnel SSH"
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

step "8/9 Post-setup checklist"
if [ "$IS_RPI5" = "1" ]; then
  CHECK_SVCS="sonoro-sync-rpi5 sonoro-player-rpi5 sonoro-tunnel getty@tty2"
else
  CHECK_SVCS="sonoro-player sonoro-tunnel getty@tty2"
fi
for svc in $CHECK_SVCS; do
  state=$(systemctl is-active "$svc" 2>&1 || true)
  if [ "$state" = "active" ]; then
    log "  $svc → active"
  else
    warn "  $svc → $state"
  fi
done
echo ""
echo "  Perfiles NetworkManager:"
nmcli -t -f NAME,TYPE,AUTOCONNECT con show | sed 's/^/    /'
echo ""
echo "  /etc/default/sonoro:"
sed 's/^/    /' /etc/default/sonoro

step "9/9 Instalacion completada"
TUNNEL_PUBKEY=$(cat "${TUNNEL_KEY}.pub" 2>/dev/null || echo "")
# Hotspot ID: quitar prefijo modelo (rpi4-|rpi5-) para que el sufijo sea el mismo
# independiente del hardware, y matchee marcaje físico del dispositivo.
HOTSPOT_ID=$(echo "${DEVICE_ID}" | sed -E 's/^rpi[45]-//' | tr '[:lower:]' '[:upper:]' | rev | cut -c1-6 | rev)
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  SONORO AV CMS v5.0 instalado (${SONORO_MODEL})${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  DEVICE_ID : ${DEVICE_ID}"
echo "  MODEL     : ${SONORO_MODEL}"
echo "  TIER      : ${SONORO_TIER}"
echo "  CMS URL   : ${CMS_URL}"
echo ""
echo -e "${YELLOW}  VIAS DE RECUPERACION (S168b — no cerrar las 3):${NC}"
echo "    1) SSH: sonoro@<ip>  (password auth ON)"
echo "    2) Ethernet: cable → DHCP autoconnect (sonoro-wired-fallback)"
echo "    3) TTY2: Ctrl+Alt+F2 en pantalla local"
echo ""
echo -e "${YELLOW}  HOTSPOT EMERGENCIA:${NC}"
echo "    Red:   SCMS-${HOTSPOT_ID}"
echo "    Clave: sonorocms"
echo ""
warn "AGREGAR CLAVE PUBLICA AL VPS:"
warn "  echo \"${TUNNEL_PUBKEY}\" >> ~/.ssh/authorized_keys"
echo ""
echo "  Reiniciar: sudo reboot"
