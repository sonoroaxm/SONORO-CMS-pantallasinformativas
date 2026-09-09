#!/bin/bash
# sonoro-provision.sh — Pre-activación remota RPi5 (sin portal cautivo).
#
# Contexto (S197d): cuando el técnico ya conectó la RPi al WiFi del cliente
# (o dejamos WiFi pre-cargado) y activamos con curl sin pasar por
# activation-portal.js, quedan huérfanos:
#   - /etc/sonoro/device-secret  (HMAC → sync-app cae a legacy → 401 en CEC)
#   - /etc/sonoro/tunnel-port    (queda default 22000 → tunnel al puerto errado)
#
# Este script replica applySecret() + applyTunnelPort() de activation-portal.js
# desde línea de comandos. Uso:
#   sudo ./sonoro-provision.sh SNR-XXXX-YYYY
#
# Persiste también a /media/root-ro (overlay lower) para sobrevivir reboot.
set -e

CODE="${1:-}"
CMS_URL="${CMS_URL:-https://sonoro.com.co}"

[ -z "$CODE" ] && { echo "uso: sudo $0 <activation-code>" >&2; exit 1; }
[ "$EUID" -ne 0 ] && { echo "requiere sudo" >&2; exit 1; }

DEVICE_ID=$(cat /etc/sonoro-device-id 2>/dev/null | tr -d '\r\n ')
[ -z "$DEVICE_ID" ] && { echo "no /etc/sonoro-device-id" >&2; exit 1; }
MODEL=$(cat /etc/sonoro-model 2>/dev/null | tr -d '\r\n ' || echo "rpi5")

echo "→ Activando device_id=$DEVICE_ID model=$MODEL code=$CODE"
RESP=$(curl -sf -X POST "$CMS_URL/api/activate" \
  -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"device_id\":\"$DEVICE_ID\",\"model\":\"$MODEL\"}") \
  || { echo "ERROR: /api/activate falló" >&2; exit 1; }

SECRET=$(echo "$RESP" | grep -oE '"device_secret":"[a-f0-9]{64}"' | cut -d'"' -f4)
PORT=$(echo "$RESP"   | grep -oE '"tunnel_port":[0-9]+'          | cut -d: -f2)

echo "→ Response: secret=${SECRET:0:8}... tunnel_port=$PORT"

mkdir -p /etc/sonoro

# ── device_secret (HMAC) ────────────────────────────────
if [ -n "$SECRET" ] && [[ "$SECRET" =~ ^[a-f0-9]{64}$ ]]; then
  printf '%s' "$SECRET" > /etc/sonoro/device-secret
  chown sonoro:sonoro /etc/sonoro/device-secret
  chmod 400 /etc/sonoro/device-secret
  echo "✓ /etc/sonoro/device-secret (0400 sonoro:sonoro)"
else
  echo "WARN: response sin device_secret válido — HMAC quedará DISABLED" >&2
fi

# ── tunnel_port ─────────────────────────────────────────
if [ -n "$PORT" ]; then
  echo "TUNNEL_PORT=$PORT" > /etc/sonoro/tunnel-port
  echo "✓ /etc/sonoro/tunnel-port ($PORT)"
fi

# ── persistir overlay lower ─────────────────────────────
if mountpoint -q /media/root-ro; then
  mount -o remount,rw /media/root-ro
  mkdir -p /media/root-ro/etc/sonoro
  [ -f /etc/sonoro/device-secret ] && {
    cp /etc/sonoro/device-secret /media/root-ro/etc/sonoro/device-secret
    chown sonoro:sonoro /media/root-ro/etc/sonoro/device-secret
    chmod 400 /media/root-ro/etc/sonoro/device-secret
  }
  [ -f /etc/sonoro/tunnel-port ] && cp /etc/sonoro/tunnel-port /media/root-ro/etc/sonoro/tunnel-port
  sync
  mount -o remount,ro /media/root-ro
  echo "✓ persistido a overlay lower"
fi

# ── reiniciar servicios ─────────────────────────────────
systemctl restart sonoro-sync-rpi5 2>/dev/null || systemctl restart sonoro-sync 2>/dev/null || true
[ -n "$PORT" ] && systemctl restart sonoro-tunnel 2>/dev/null || true
echo "✓ servicios reiniciados"

sleep 3
echo "---"
journalctl -u sonoro-sync-rpi5 -n 5 --no-pager 2>/dev/null | grep -iE "HMAC|ENABLED|DISABLED" || true
echo "→ done"
