#!/bin/bash
# SONORO AV CMS — Instalador RPi v5.2 (RPi4 + RPi5 nativo)
# S172 (04/08/2026): portal cautivo (wifi-recover + dnsmasq preseed + CAPTIVE_OWN_DNS)
#                    + OverlayFS RPi5 (regresion v5.1 corregida) + iptables en base.
# S169 (02/08/2026): plymouth theme symlink + MODULES=most + splash PNG real
#                    + cmdline console=tty3 + fbcat/screenshot + hdmi hotplug
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
  pipewire pipewire-alsa wireplumber v4l-utils autossh qrencode network-manager \
  iptables overlayroot cec-utils"

if [ "$IS_RPI5" = "1" ]; then
  # RPi5 nativo: ffmpeg vout_drm, sin X11/mpv/openbox/plymouth-en-DRM (bloquean DRM master)
  # S169: imagemagick (splash JPEG→PNG real) + fbcat (screenshot helper).
  apt-get install -y -qq $BASE_PKGS imagemagick fbcat
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
# S172: CAPTIVE_OWN_DNS=1 default en RPi5 — el dnsmasq de NM en modo shared
# no siempre honra dnsmasq-shared.d/ con wildcard `address=/#/`; el fallback
# propio en :5353 + iptables UDP redirect garantiza que Android/iOS/Win vean
# el portal cautivo. Default OFF en RPi4 (donde el flujo actual ya funciona).
if [ "$IS_RPI5" = "1" ]; then
  CAPTIVE_OWN_DNS_LINE="CAPTIVE_OWN_DNS=1"
else
  CAPTIVE_OWN_DNS_LINE="# CAPTIVE_OWN_DNS=1  # opt-in en RPi4"
fi
cat > "${PLAYER_DIR}/.env" << ENV
CMS_URL=${CMS_URL}
DEVICE_ID=${DEVICE_ID}
SONORO_MODEL=${SONORO_MODEL}
${CAPTIVE_OWN_DNS_LINE}
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
  step "6b.0/9 Plymouth splash SONORO (S167 boot silencioso)"
  # Instalar plymouth base + tema SONORO. Plymouth libera DRM antes de handoff
  # a getty/ffmpeg → compatible con vout_drm. Sin fbcon=map:1 (deja TTY libre).
  # S169: plymouth-themes arrastra script.so requerido en initramfs.
  apt-get install -y -qq plymouth plymouth-themes >/dev/null 2>&1 || warn "plymouth apt install fallo"
  PLYMOUTH_THEME_DIR="/usr/share/plymouth/themes/sonoro"
  mkdir -p "$PLYMOUTH_THEME_DIR"
  cp "${SCRIPT_DIR}/plymouth-sonoro/sonoro.plymouth" "${PLYMOUTH_THEME_DIR}/"
  cp "${SCRIPT_DIR}/plymouth-sonoro/sonoro.script"   "${PLYMOUTH_THEME_DIR}/"
  # sonoro.script (12/03/2026) referencia nombres literales splashhorizontalcms/verticalcms.png
  cp "${SCRIPT_DIR}/splash_horizontal.png" "${PLYMOUTH_THEME_DIR}/splashhorizontalcms.png"
  cp "${SCRIPT_DIR}/splash_vertical.png"   "${PLYMOUTH_THEME_DIR}/splashverticalcms.png"
  # Copia opcional splash.png si existe (fallback plymouth theme).
  [ -f "${SCRIPT_DIR}/plymouth-sonoro/splash.png" ] && \
    cp "${SCRIPT_DIR}/plymouth-sonoro/splash.png" "${PLYMOUTH_THEME_DIR}/splash.png"

  # S169 fix crítico: los splash entregados eran JPEG con extensión .png →
  # plymouth los rechaza silenciosamente y muestra pantalla negra. Detectar y
  # reconvertir a PNG real con imagemagick.
  for f in "${PLYMOUTH_THEME_DIR}/splashhorizontalcms.png" \
           "${PLYMOUTH_THEME_DIR}/splashverticalcms.png" \
           "${PLYMOUTH_THEME_DIR}/splash.png"; do
    [ -f "$f" ] || continue
    if file "$f" | grep -qi 'JPEG'; then
      warn "$(basename $f) era JPEG disfrazado — reconvirtiendo a PNG real"
      convert "$f" "${f}.real.png" && mv "${f}.real.png" "$f"
    fi
  done

  # Fix S168b: CRLF de Windows rompe plymouth (memoria HISTORIAL:4701).
  sed -i 's/\r$//' "${PLYMOUTH_THEME_DIR}/sonoro.plymouth" "${PLYMOUTH_THEME_DIR}/sonoro.script"
  # Registrar como alternativa (necesario para que initramfs incluya default.plymouth).
  update-alternatives --install /usr/share/plymouth/themes/default.plymouth \
    default.plymouth "${PLYMOUTH_THEME_DIR}/sonoro.plymouth" 100 >/dev/null 2>&1 || true
  update-alternatives --set default.plymouth "${PLYMOUTH_THEME_DIR}/sonoro.plymouth" >/dev/null 2>&1 || true
  plymouth-set-default-theme sonoro >/dev/null 2>&1 || warn "plymouth-set-default-theme fallo"
  # S169: Debian a veces NO crea el symlink /usr/share/plymouth/themes/default.plymouth,
  # y plymouthd cae al tema `text` sin previo aviso. Forzarlo.
  ln -sf /etc/alternatives/default.plymouth /usr/share/plymouth/themes/default.plymouth

  # S169: initramfs necesita MODULES=most para incluir vc4 (KMS DRM RPi5),
  # sin él plymouth arranca pero no puede pintar → pantalla negra.
  if [ -f /etc/initramfs-tools/initramfs.conf ]; then
    sed -i 's/^MODULES=.*/MODULES=most/' /etc/initramfs-tools/initramfs.conf
  fi

  # S169: plymouthd.conf con timings sanos para KMS RPi5.
  mkdir -p /etc/plymouth
  cat > /etc/plymouth/plymouthd.conf <<'PLYCONF'
[Daemon]
Theme=sonoro
ShowDelay=0
DeviceTimeout=8
PLYCONF

  # S169: acortar plymouth-quit-wait a 3s (default espera hasta que systemd
  # complete el arranque de graphical.target; en headless nunca cierra).
  mkdir -p /etc/systemd/system/plymouth-quit-wait.service.d
  cat > /etc/systemd/system/plymouth-quit-wait.service.d/override.conf <<'PQW'
[Service]
ExecStart=
ExecStart=/bin/sleep 3
ExecStart=/usr/bin/plymouth quit
PQW

  # disable_splash=1 en config.txt (memoria HISTORIAL 12/03/2026) — mata el rainbow splash del firmware.
  CONFIG="/boot/firmware/config.txt"
  [ -f "$CONFIG" ] || CONFIG="/boot/config.txt"
  if [ -f "$CONFIG" ] && ! grep -q "^disable_splash=" "$CONFIG"; then
    echo "disable_splash=1" >> "$CONFIG"
    log "config.txt: disable_splash=1 anadido"
  fi

  # cmdline.txt: agregar quiet splash plymouth.enable=1 si no estan (una sola linea).
  CMDLINE="/boot/firmware/cmdline.txt"
  [ -f "$CMDLINE" ] || CMDLINE="/boot/cmdline.txt"
  if [ -f "$CMDLINE" ]; then
    # S169: quitar plymouth.debug si algún flash previo lo dejó (verboso).
    sed -i 's/ *plymouth\.debug//g' "$CMDLINE"
    # S169: console=tty1 hace visible en HDMI. Mover a tty3 (invisible).
    sed -i 's/console=tty1/console=tty3/g' "$CMDLINE"
    # S169: loglevel=0 silencia kernel messages residuales.
    for kw in "quiet" "splash" "plymouth.enable=1" "logo.nologo" "vt.global_cursor_default=0" "loglevel=0"; do
      grep -q "$kw" "$CMDLINE" || sed -i "1 s|$| $kw|" "$CMDLINE"
    done
    log "cmdline.txt: quiet splash plymouth.enable=1 logo.nologo vt.global_cursor_default=0 loglevel=0 console=tty3"
  else
    warn "cmdline.txt no encontrado — splash puede no activarse"
  fi

  # S169: config.txt — HDMI hotplug + boot_delay + RTC trickle charge.
  if [ -f "$CONFIG" ]; then
    for kv in "hdmi_force_hotplug=1" "boot_delay=3" "dtparam=rtc_bbat_vchg=3000000"; do
      k="${kv%%=*}"
      grep -q "^${k}=" "$CONFIG" || echo "$kv" >> "$CONFIG"
    done
    log "config.txt: hdmi_force_hotplug + boot_delay=3 + rtc_bbat_vchg"
  fi

  # S169: enmascarar getty@tty1 — compite con ffmpeg vout_drm por DRM master
  # y en cold-boot puede pintar dialog "Press enter". tty2 sigue activo como fallback.
  systemctl mask getty@tty1.service 2>/dev/null || true

  # S169: regenerar initramfs para incorporar MODULES=most + plymouth theme.
  update-initramfs -u >/dev/null 2>&1 || warn "update-initramfs fallo"
  log "initramfs regenerado (vc4 + plymouth theme incluidos)"

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

step "6d/9 Screenshot helper RPi5 (S169)"
if [ "$IS_RPI5" = "1" ]; then
  # sonoro-screenshot.sh: extrae frame del video actual con ffmpeg -vframes 1
  # (fbcat no sirve — vout_drm usa plano overlay no fb0). sync-app.js lo llama
  # via IS_RPI5 branch en socket.on('screenshot_request').
  if [ -f "${SCRIPT_DIR}/sonoro-screenshot.sh" ]; then
    cp "${SCRIPT_DIR}/sonoro-screenshot.sh" /usr/local/bin/sonoro-screenshot.sh
    chmod +x /usr/local/bin/sonoro-screenshot.sh
    log "sonoro-screenshot.sh instalado en /usr/local/bin"
  else
    warn "sonoro-screenshot.sh no encontrado en SCRIPT_DIR — screenshot RPi5 no funcionara"
  fi
fi

step "6d2/9 CEC TV control script (tv-ctl.sh)"
if [ -f "${SCRIPT_DIR}/tv-ctl.sh" ]; then
  install -d -o sonoro -g sonoro /home/sonoro/tv-ctl
  cp "${SCRIPT_DIR}/tv-ctl.sh" /home/sonoro/tv-ctl/tv-ctl.sh
  sed -i 's/\r$//' /home/sonoro/tv-ctl/tv-ctl.sh
  chown sonoro:sonoro /home/sonoro/tv-ctl/tv-ctl.sh
  chmod +x /home/sonoro/tv-ctl/tv-ctl.sh
  log "tv-ctl.sh instalado en /home/sonoro/tv-ctl/"
else
  warn "tv-ctl.sh no encontrado en SCRIPT_DIR — CEC TV control no funcionara"
fi

step "6e/9 Deshabilitando WiFi power management"
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

step "6f/9 Portal cautivo — preseed dnsmasq + wifi-recover (S172)"
# Preseed dnsmasq wildcard: aunque activation-portal.js tambien lo crea al
# arrancar el hotspot, dejarlo pre-instalado evita perderlo si el portal falla
# antes de setupCaptivePortal(). Es idempotente (mismo path el portal reescribe).
if [ -f "${SCRIPT_DIR}/sonoro-captive.conf" ]; then
  mkdir -p /etc/NetworkManager/dnsmasq-shared.d
  cp "${SCRIPT_DIR}/sonoro-captive.conf" /etc/NetworkManager/dnsmasq-shared.d/sonoro-captive.conf
  log "dnsmasq wildcard preseed instalado (10.42.0.1)"
else
  warn "sonoro-captive.conf no encontrado — dnsmasq preseed omitido"
fi

# wifi-recover: sale de Hotspot fallback cuando reaparece un AP guardado.
# S161 (RPi4) + adaptado S172 para perfiles netplan-* de Debian 13.
if [ -f "${SCRIPT_DIR}/wifi-recover.sh" ]; then
  cp "${SCRIPT_DIR}/wifi-recover.sh"      /usr/local/bin/wifi-recover.sh
  chmod +x /usr/local/bin/wifi-recover.sh
  cp "${SCRIPT_DIR}/wifi-recover.service" /etc/systemd/system/wifi-recover.service
  cp "${SCRIPT_DIR}/wifi-recover.timer"   /etc/systemd/system/wifi-recover.timer
  systemctl daemon-reload
  systemctl enable wifi-recover.timer
  systemctl start  wifi-recover.timer 2>/dev/null || true
  log "wifi-recover instalado (timer cada 2 min)"
else
  warn "wifi-recover.sh no encontrado — recovery Hotspot no funcionara"
fi

step "7/9 Configurando tunnel SSH"
TUNNEL_KEY="/home/${SONORO_USER}/.ssh/vps_tunnel"
mkdir -p "/home/${SONORO_USER}/.ssh"
chmod 700 "/home/${SONORO_USER}/.ssh"
if [ ! -f "${TUNNEL_KEY}" ]; then
  sudo -u "${SONORO_USER}" ssh-keygen -t ed25519 -f "${TUNNEL_KEY}" -N "" -q
fi
# v5.3 (S172f): endurecido contra race boot + zombie forward
# - After/Wants network-online.target: no arranca sin default route
# - ExitOnForwardFailure=yes: ssh sale si -R falla (autossh reintenta con conexion limpia)
# - ServerAliveInterval/CountMax: detecta cuelgues VPS en <=90s
# - RestartSec=30: da tiempo al VPS a liberar TIME_WAIT del socket anterior
# - StartLimitBurst=0: systemd nunca deja de reintentar
# - AUTOSSH_GATETIME=30: umbral antes de considerar la sesion estable
# v5.4 (S185g): TUNNEL_PORT desde EnvironmentFile (rango 22200-22299 por-device
# asignado por backend en /api/activate; fallback 2222 si el file no existe)
mkdir -p /etc/sonoro
if [ ! -f /etc/sonoro/tunnel-port ]; then
  echo "TUNNEL_PORT=2222" > /etc/sonoro/tunnel-port
fi
chmod 644 /etc/sonoro/tunnel-port
cat > /etc/systemd/system/sonoro-tunnel.service << 'TUN'
[Unit]
Description=SONORO SSH Tunnel
After=network-online.target sonoro-player.service
Wants=network-online.target
[Service]
User=__SONORO_USER__
Environment="AUTOSSH_GATETIME=30"
EnvironmentFile=-/etc/sonoro/tunnel-port
ExecStart=/usr/bin/autossh -M 0 -N \
  -o "ExitOnForwardFailure=yes" \
  -o "ServerAliveInterval=30" \
  -o "ServerAliveCountMax=3" \
  -o "StrictHostKeyChecking=no" \
  -o "UserKnownHostsFile=/dev/null" \
  -R ${TUNNEL_PORT}:localhost:22 \
  -i __TUNNEL_KEY__ \
  debian@45.181.156.171
Restart=always
RestartSec=30
StartLimitBurst=0
[Install]
WantedBy=multi-user.target
TUN
sed -i "s|__SONORO_USER__|${SONORO_USER}|g; s|__TUNNEL_KEY__|${TUNNEL_KEY}|g" /etc/systemd/system/sonoro-tunnel.service

# Sudoers: permite al user aplicar tunnel_port sin password (portal + sync-app)
cat > /etc/sudoers.d/sonoro-tunnel-port << SUDO
${SONORO_USER} ALL=(root) NOPASSWD: /usr/bin/tee /etc/sonoro/tunnel-port
${SONORO_USER} ALL=(root) NOPASSWD: /bin/systemctl restart sonoro-tunnel
SUDO
chmod 440 /etc/sudoers.d/sonoro-tunnel-port

# Sudoers: permite al portal persistir device_secret HMAC (VULN-003/006 P5)
# tee escribe el archivo, chmod/chown restringen a sonoro:sonoro 400,
# restart sync-app fuerza recarga del interceptor axios.
cat > /etc/sudoers.d/sonoro-device-secret << SUDO
${SONORO_USER} ALL=(root) NOPASSWD: /usr/bin/tee /etc/sonoro/device-secret
${SONORO_USER} ALL=(root) NOPASSWD: /bin/chmod 400 /etc/sonoro/device-secret
${SONORO_USER} ALL=(root) NOPASSWD: /bin/chown ${SONORO_USER}\:${SONORO_USER} /etc/sonoro/device-secret
${SONORO_USER} ALL=(root) NOPASSWD: /bin/systemctl restart sonoro-sync-rpi5
${SONORO_USER} ALL=(root) NOPASSWD: /bin/systemctl restart sonoro-sync
SUDO
chmod 440 /etc/sudoers.d/sonoro-device-secret

systemctl daemon-reload && systemctl enable sonoro-tunnel
log "Tunnel SSH configurado (TUNNEL_PORT por-device, fallback 2222)"

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

step "8b/9 OverlayFS root RO (v5.4 — deterministico, sin fallback)"
# Regla de oro (RPi4 stack, PARTE 2.5 ALISTAMIENTO-RPI.md): la MicroSD debe ir
# en modo RO tras el arranque para sobrevivir cortes de energia. Upper layer en
# tmpfs, lower en SD; cualquier cambio se pierde salvo persist explicito via
# sonoro-sd-rw/sonoro-sd-ro.
#
# v5.4 (S172g): overlayroot movido a BASE_PKGS (fail-fast en paso 2 si el repo
# Debian 13 no lo tiene). Confirmado disponible en trixie/main (0.18.debian14).
# Sin condicionales — si llegamos aca, overlayroot esta instalado.
if [ "$IS_RPI5" = "1" ]; then
  # 1) Configuracion overlayroot: upper en tmpfs (RAM), lower en SD.
  cat > /etc/overlayroot.local.conf << 'OVL'
overlayroot="tmpfs:recurse=0"
OVL

  # 2) journald volatile (evita escritura constante a SD).
  mkdir -p /etc/systemd/journald.conf.d
  cat > /etc/systemd/journald.conf.d/volatile.conf << 'JC'
[Journal]
Storage=volatile
RuntimeMaxUse=50M
JC

  # 3) Scripts de mantenimiento de la capa persistente.
  cat > /usr/local/bin/sonoro-sd-rw << 'SDRW'
#!/bin/bash
mount -o remount,rw /media/root-ro
SDRW

  cat > /usr/local/bin/sonoro-sd-ro << 'SDRO'
#!/bin/bash
sync
echo 3 > /proc/sys/vm/drop_caches
mount -o remount,ro /media/root-ro
SDRO

  cat > /usr/local/bin/overlay-maintenance << 'OVM'
#!/bin/bash
echo "=== Estado overlay ==="
mount | grep -E "overlay|root-ro"
echo ""
echo "=== Espacio lower (SD) ==="
df -h /media/root-ro 2>/dev/null || echo "lower no montado"
echo ""
echo "=== Espacio upper (RAM) ==="
df -h / | tail -1
OVM

  chmod +x /usr/local/bin/sonoro-sd-rw \
           /usr/local/bin/sonoro-sd-ro \
           /usr/local/bin/overlay-maintenance

  # 4) Sudoers NOPASSWD para el usuario sonoro (persistencia automatica
  #    desde sync-app.js / activation-portal.js persistWifiToSD()).
  cat > /etc/sudoers.d/sonoro-persist << 'SUD'
sonoro ALL=(root) NOPASSWD: /usr/local/bin/sonoro-sd-rw, /usr/local/bin/sonoro-sd-ro
SUD
  chmod 440 /etc/sudoers.d/sonoro-persist

  # 5) Regenerar initramfs para incorporar el hook de overlayroot.
  update-initramfs -u >/dev/null 2>&1 || warn "update-initramfs (overlayroot) fallo"
  log "OverlayFS configurado — tras reboot / sera RO (upper en tmpfs)"
  OVERLAY_ENABLED=1
else
  # RPi4: OverlayFS ya configurado en el flujo maestro docs/ALISTAMIENTO-RPI.md
  # PARTE 2.5. No tocamos aqui para no romper unidades desplegadas.
  OVERLAY_ENABLED=0
  log "RPi4 — OverlayFS gestionado por ALISTAMIENTO-RPI.md (no tocar)"
fi

step "9/9 Instalacion completada"
TUNNEL_PUBKEY=$(cat "${TUNNEL_KEY}.pub" 2>/dev/null || echo "")
# Hotspot ID: quitar prefijo modelo (rpi4-|rpi5-) para que el sufijo sea el mismo
# independiente del hardware, y matchee marcaje físico del dispositivo.
HOTSPOT_ID=$(echo "${DEVICE_ID}" | sed -E 's/^rpi[45]-//' | tr '[:lower:]' '[:upper:]' | rev | cut -c1-6 | rev)
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  SONORO AV CMS v5.2 instalado (${SONORO_MODEL})${NC}"
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
