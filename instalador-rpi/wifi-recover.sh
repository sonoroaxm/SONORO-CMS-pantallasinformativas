#!/bin/bash
# SONORO WiFi Recover — sale del Hotspot fallback si aparece un AP guardado.
# S161 (RPi4) + adaptado S172 (RPi5 seguritech01, perfiles netplan-* de Debian 13).
#
# Corre por timer cada 2 min. Si la conexion activa en wlan0 es Hotspot/SCMS-*,
# rescanea y activa el primer perfil autoconnect visible cuyo SSID no sea el
# propio hotspot. Tras exito, reinicia sonoro-tunnel (fix S161b).
set -e

LOG=/home/sonoro/logs/wifi-recover.log
mkdir -p /home/sonoro/logs
ts() { date -Iseconds; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

ACTIVE=$(nmcli -t -f NAME,DEVICE con show --active | awk -F: '$2=="wlan0"{print $1}')
if [ -z "$ACTIVE" ]; then
  log "wlan0 sin conexion activa"
  exit 0
fi

case "$ACTIVE" in
  Hotspot|SCMS-*)
    log "En Hotspot fallback ($ACTIVE) — buscando AP guardado..."
    ;;
  *)
    exit 0
    ;;
esac

nmcli device wifi rescan 2>/dev/null || true
sleep 3
VISIBLE=$(nmcli -t -f SSID device wifi list | sort -u)

CANDIDATE=""
while IFS=: read -r NAME AUTO TYPE; do
  [ "$TYPE" = "802-11-wireless" ] || continue
  [ "$AUTO" = "yes" ] || continue
  case "$NAME" in Hotspot|SCMS-*) continue ;; esac
  # Derivar SSID del NAME:
  #  - perfiles clasicos NM: NAME == SSID
  #  - perfiles netplan-* (Debian 13): NAME == netplan-wlan0-<SSID>
  SSID=$(nmcli -t -g 802-11-wireless.ssid con show "$NAME" 2>/dev/null)
  [ -z "$SSID" ] && SSID=$(echo "$NAME" | sed 's/^netplan-wlan0-//')
  if echo "$VISIBLE" | grep -qxF "$SSID"; then
    CANDIDATE="$NAME"
    log "AP guardado visible: $NAME (SSID=$SSID)"
    break
  fi
done < <(nmcli -t -f NAME,AUTOCONNECT,TYPE con show)

if [ -z "$CANDIDATE" ]; then
  log "Ningun AP guardado visible aun"
  exit 0
fi

log "Bajando $ACTIVE y subiendo $CANDIDATE"
nmcli connection down "$ACTIVE" || true
sleep 2
if nmcli connection up "$CANDIDATE"; then
  log "OK reconectado a $CANDIDATE"
  sleep 5
  log "Reiniciando sonoro-tunnel.service (fix S161b)"
  systemctl restart sonoro-tunnel.service || log "WARN: restart tunnel fallo"
else
  log "ERROR: nmcli up $CANDIDATE fallo — reactivando Hotspot"
  nmcli connection up "$ACTIVE" || true
fi
