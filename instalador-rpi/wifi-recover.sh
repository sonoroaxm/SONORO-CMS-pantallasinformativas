#!/bin/bash
# ============================================================
# SONORO AV — Recuperación automática WiFi tras fallback Hotspot
#
# Cuando NetworkManager pierde el AP conocido y activa el
# Hotspot de emergencia (SCMS-xxxxxx), NM no reintenta la WiFi
# guardada aunque vuelva a estar disponible. Este script corre
# cada 5 min via systemd timer y, si detecta:
#   1) conexión wlan0 activa = Hotspot
#   2) al menos un AP guardado (autoconnect=yes) presente en scan
# entonces baja el Hotspot y activa la WiFi guardada.
#
# Log: /home/sonoro/logs/wifi-recover.log
# ============================================================

LOG="/home/sonoro/logs/wifi-recover.log"
mkdir -p "$(dirname "$LOG")"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# ── ¿wlan0 está en modo Hotspot? ─────────────────────────────
ACTIVE=$(nmcli -t -f NAME,DEVICE connection show --active | awk -F: -v d=wlan0 '$2==d{print $1}')

case "$ACTIVE" in
  ""|Hotspot|SCMS-*)
    : # continuar (sin conexión real o en hotspot)
    ;;
  *)
    exit 0 # ya hay WiFi normal activa
    ;;
esac

# ── Refrescar scan ───────────────────────────────────────────
nmcli device wifi rescan ifname wlan0 >/dev/null 2>&1
sleep 3

# ── SSIDs visibles ahora ─────────────────────────────────────
SCAN=$(nmcli -t -f SSID device wifi list ifname wlan0 2>/dev/null | sort -u)

# ── Conexiones guardadas con autoconnect=yes (excluye Hotspot) ─
mapfile -t SAVED < <(nmcli -t -f NAME,TYPE,AUTOCONNECT connection show \
  | awk -F: '$2=="802-11-wireless" && $3=="yes" && $1!="Hotspot" && $1!~/^SCMS-/ {print $1}')

for NAME in "${SAVED[@]}"; do
  SSID=$(nmcli -t -f 802-11-wireless.ssid connection show "$NAME" 2>/dev/null | cut -d: -f2)
  [ -z "$SSID" ] && SSID="$NAME"
  if echo "$SCAN" | grep -Fxq "$SSID"; then
    log "AP guardado '$SSID' visible — bajando Hotspot y activando '$NAME'"
    nmcli connection down Hotspot >/dev/null 2>&1
    sleep 2
    if nmcli connection up "$NAME" ifname wlan0 >/dev/null 2>>"$LOG"; then
      log "OK: reconectado a '$NAME'"
      # Reiniciar autossh: al cambiar de interfaz suele quedar con socket
      # zombi y tarda minutos en reconectar por su propio backoff.
      if systemctl is-active --quiet sonoro-tunnel.service; then
        systemctl restart sonoro-tunnel.service 2>>"$LOG" \
          && log "sonoro-tunnel reiniciado" \
          || log "WARN: no pudo reiniciar sonoro-tunnel"
      fi
      exit 0
    else
      log "FAIL: no pudo activar '$NAME' — reabriendo Hotspot"
      nmcli connection up Hotspot >/dev/null 2>&1
      exit 1
    fi
  fi
done

# Ningún AP guardado a la vista — no hacer nada
exit 0
