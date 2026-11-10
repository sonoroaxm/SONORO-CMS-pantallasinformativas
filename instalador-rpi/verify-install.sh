#!/usr/bin/env bash
# verify-install.sh — Post-install gate (CORE-INVENTORY §14bis)
# Corre en el RPi tras sonoro-setup.sh. Exit 0 = productivo; exit 1 = bloquea.
# Toda regla aquí responde a una regresión histórica documentada en HOTFIX-LOG.

set -u
PASS=0; FAIL=0; WARN=0
PLAYER=/home/sonoro/sonoro-player/player-rpi5.js
TUNNEL_UNIT=/etc/systemd/system/sonoro-tunnel.service
PLAYER_UNIT=/etc/systemd/system/sonoro-player-rpi5.service
SYNC_UNIT=/etc/systemd/system/sonoro-sync-rpi5.service
MARKER=/home/sonoro/.installed-from

ok()   { echo "  [OK]   $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
warn() { echo "  [WARN] $1"; WARN=$((WARN+1)); }

check_file() { [ -f "$1" ] || { bad "falta archivo: $1"; return 1; }; return 0; }
grep_must()    { grep -q -- "$2" "$1" && ok   "$3"; } # grep-must-match
grep_must_not(){ grep -q -- "$2" "$1" && bad  "$3" || ok "$3"; }

echo "== verify-install.sh (§14bis CORE-INVENTORY) =="
echo

echo "[1] Player RPi5 — Bug B8 (HOTFIX filas 1/57/58/80)"
if check_file "$PLAYER"; then
  grep_must_not "$PLAYER" "stream_loop -1" "player NO usa concat/stream_loop (post-S178)"
  grep_must     "$PLAYER" "vout_drm"       "player usa vout_drm (secuencial S178)"
fi
echo

echo "[2] Tunnel unit — port hardcoded (HOTFIX fila 79)"
if check_file "$TUNNEL_UNIT"; then
  grep_must_not "$TUNNEL_UNIT" "2222:localhost:22"        "tunnel NO hardcodea -R 2222"
  grep_must     "$TUNNEL_UNIT" 'EnvironmentFile=.*tunnel' "tunnel lee port desde EnvironmentFile (S185g)"
  grep -q "sonoro-player.service" "$TUNNEL_UNIT" && ! grep -q "sonoro-player-rpi5.service" "$TUNNEL_UNIT" \
    && warn "After= referencia unit obsoleta 'sonoro-player.service'" \
    || ok "After= limpio"
fi
echo

echo "[3] Player unit — Requires vs Wants (S185h)"
if check_file "$PLAYER_UNIT"; then
  grep_must_not "$PLAYER_UNIT" "Requires=sonoro-sync" "player usa Wants= (no Requires=) para sync"
  grep_must     "$PLAYER_UNIT" "Wants=sonoro-sync"    "Wants=sonoro-sync-rpi5 presente"
fi
echo

echo "[4] Marker .installed-from (§14bis.3)"
if [ -f "$MARKER" ]; then
  grep_must "$MARKER" "^commit=" "marker tiene commit de origen"
  grep_must "$MARKER" "^branch=main" "marker declara branch=main"
else
  bad "falta $MARKER (post-install no lo generó)"
fi
echo

echo "[5] Services activos"
for u in sonoro-tunnel sonoro-sync-rpi5 sonoro-player-rpi5; do
  if systemctl is-enabled --quiet "$u" 2>/dev/null; then ok "$u enabled"
  else bad "$u NO enabled"; fi
done
echo

echo "== Resumen: $PASS OK · $WARN WARN · $FAIL FAIL =="
[ "$FAIL" -eq 0 ] || { echo "BLOQUEADO — remediar antes de producción."; exit 1; }
echo "LISTO para producción."
exit 0
