#!/bin/bash
# ============================================================
# SONORO AV — Configuración WiFi Provisioning
# Instala y configura hostapd + dnsmasq para modo AP temporal
# Uso: sudo bash sonoro-wifi-setup.sh
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
step() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

SONORO_USER="sonoro"
PLAYER_DIR="/home/${SONORO_USER}/sonoro-player"
AP_SSID="SONORO-Setup"
AP_PASS="sonoro2024"
AP_IP="192.168.99.1"

step "1/4 Instalando hostapd y dnsmasq"
apt-get install -y -qq hostapd dnsmasq
systemctl stop hostapd dnsmasq 2>/dev/null || true
systemctl disable hostapd dnsmasq 2>/dev/null || true
log "hostapd y dnsmasq instalados (deshabilitados por defecto)"

step "2/4 Configurando hostapd"
cat > /etc/hostapd/sonoro-ap.conf << EOF
interface=wlan0
driver=nl80211
ssid=${AP_SSID}
hw_mode=g
channel=7
wmm_enabled=0
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=${AP_PASS}
wpa_key_mgmt=WPA-PSK
wpa_pairwise=TKIP
rsn_pairwise=CCMP
EOF
log "hostapd configurado — SSID: ${AP_SSID}"

step "3/4 Configurando dnsmasq"
cat > /etc/dnsmasq.d/sonoro-ap.conf << EOF
interface=wlan0
dhcp-range=192.168.99.10,192.168.99.50,255.255.255.0,24h
domain=local
address=/#/${AP_IP}
EOF
log "dnsmasq configurado — rango DHCP: 192.168.99.10-50"

step "4/4 Creando scripts de control del AP"

# Script para ACTIVAR modo AP
cat > /usr/local/bin/sonoro-ap-start << EOF
#!/bin/bash
# Activar punto de acceso WiFi SONORO
echo "[SONORO] Activando punto de acceso WiFi..."

# Desconectar WiFi normal
nmcli radio wifi off 2>/dev/null || true
sleep 1

# Configurar IP estática en wlan0
ip addr flush dev wlan0
ip addr add ${AP_IP}/24 dev wlan0
ip link set wlan0 up

# Iniciar hostapd y dnsmasq
systemctl start hostapd --conf=/etc/hostapd/sonoro-ap.conf
systemctl start dnsmasq

echo "[SONORO] Punto de acceso activo: ${AP_SSID} (${AP_IP})"
echo "[SONORO] Portal: http://${AP_IP}:8080"
EOF
chmod +x /usr/local/bin/sonoro-ap-start

# Script para DESACTIVAR modo AP y conectar a WiFi del cliente
cat > /usr/local/bin/sonoro-ap-stop << 'EOF'
#!/bin/bash
# Desactivar punto de acceso y conectar a WiFi del cliente
SSID="$1"
PASS="$2"

echo "[SONORO] Desactivando punto de acceso..."
systemctl stop hostapd dnsmasq 2>/dev/null || true

echo "[SONORO] Reconectando WiFi..."
nmcli radio wifi on
sleep 2

if [ -n "$SSID" ]; then
  echo "[SONORO] Conectando a: $SSID"
  nmcli dev wifi connect "$SSID" password "$PASS" ifname wlan0
  sleep 3
  IP=$(hostname -I | awk '{print $1}')
  echo "[SONORO] Conectado. IP: $IP"
fi
EOF
chmod +x /usr/local/bin/sonoro-ap-stop

log "Scripts de control creados"

# Guardar config del AP en el player dir
cat > "${PLAYER_DIR}/ap-config.json" << EOF
{
  "ap_ssid": "${AP_SSID}",
  "ap_password": "${AP_PASS}",
  "ap_ip": "${AP_IP}",
  "portal_port": 8080
}
EOF
chown "${SONORO_USER}:${SONORO_USER}" "${PLAYER_DIR}/ap-config.json"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✓ WiFi Provisioning configurado${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  AP SSID     : ${AP_SSID}"
echo "  AP Password : ${AP_PASS}"
echo "  AP IP       : ${AP_IP}"
echo "  Portal      : http://${AP_IP}:8080"
echo ""
