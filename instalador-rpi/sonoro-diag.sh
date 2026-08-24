#!/bin/bash
# sonoro-diag.sh — Diagnóstico multicapa player RPi5
# Uso: bash /usr/local/bin/sonoro-diag.sh
# Cubre: procesos, DRM/KMS, V4L2 HEVC decoder, integridad HEVC, concat, sistema, red, logs

echo "════════════════════════════════════════════════════════"
echo "  SONORO RPi5 — DIAGNÓSTICO MULTICAPA"
echo "  $(date)"
echo "════════════════════════════════════════════════════════"

echo ""
echo "════ CAPA 1: PROCESOS ════"
FFPID=$(pgrep ffmpeg | head -1)
NODEPID=$(pgrep -f player-rpi5 | head -1)
echo "ffmpeg PID=$FFPID | node (player) PID=$NODEPID"
if [ -n "$FFPID" ]; then
  ps -p $FFPID -o pid,pcpu,pmem,etime,stat --no-headers 2>/dev/null \
    | awk '{printf "  cpu=%-5s mem=%-5s uptime=%-12s state=%s\n",$2,$3,$4,$5}'
  echo "  FDs DRM/V4L2 abiertos por ffmpeg:"
  ls -la /proc/$FFPID/fd 2>/dev/null | grep -E "dri|video|media|concat|playlist" \
    | awk '{print "   "$NF}'
else
  echo "  ffmpeg NO esta corriendo"
fi

echo ""
echo "════ CAPA 2: DRM/KMS ════"
echo "Dispositivos DRM:"
ls -la /dev/dri/ 2>/dev/null
echo "Quien tiene DRM master de card1:"
fuser /dev/dri/card1 2>/dev/null | xargs -I{} ps -p {} -o pid,comm --no-headers 2>/dev/null \
  || echo "  nadie"
echo "Conectores (sysfs):"
for connector in /sys/class/drm/card1-*/; do
  name=$(basename $connector)
  status=$(cat $connector/status 2>/dev/null || echo "?")
  enabled=$(cat $connector/enabled 2>/dev/null || echo "?")
  echo "  $name: status=$status enabled=$enabled"
done 2>/dev/null

echo ""
echo "════ CAPA 3: V4L2 HEVC HW DECODER ════"
echo "Uso de /dev/video19 (rpi-hevc-dec source/sink):"
lsof /dev/video19 2>/dev/null || echo "  nadie"
echo "Uso de /dev/media2 (rpi-hevc-dec topology):"
lsof /dev/media2 2>/dev/null || echo "  nadie"
echo "Pixel format activo en video19:"
v4l2-ctl -d /dev/video19 --get-fmt-video 2>/dev/null \
  | grep -E "Width|Height|Pixel Format" | sed 's/^/  /'
echo "  (Nc12=SAND NV12=correcto para vout_drm; NV12=LINEAR=error drmModeAddFB2)"

echo ""
echo "════ CAPA 4: INTEGRIDAD HEVC (playlist activa) ════"
CONFIG=/home/sonoro/media/last_config.json
if [ -f "$CONFIG" ]; then
  PLID=$(python3 -c "import json,sys; d=json.load(open('$CONFIG')); print(d.get('hdmi0_playlist_id',''))" 2>/dev/null)
  echo "Playlist activa: $PLID"
  DIR=/home/sonoro/media/playlist_${PLID}
  for f in $DIR/*.mp4; do
    [ -f "$f" ] || continue
    name=$(basename $f)
    size=$(ls -lh $f | awk '{print $5}')
    info=$(ffprobe -v error -select_streams v:0 \
      -show_entries stream=width,height,has_b_frames,codec_name,pix_fmt,r_frame_rate,nb_frames \
      -of csv=p=0 $f 2>/dev/null)
    echo "  $name ($size): $info"
  done
  echo ""
  echo "  has_b_frames=2 -> B-frames OK (SAND NV12, sin drmModeAddFB2 error)"
  echo "  has_b_frames=0 -> SIN B-frames (LINEAR NV12, causara error en vout_drm)"
else
  echo "  last_config.json no encontrado"
fi

echo ""
echo "════ CAPA 5: CONCAT FILE ════"
CONCAT=/tmp/sonoro-concat.txt
if [ -f "$CONCAT" ]; then
  cat $CONCAT
  echo "--- Existencia de archivos ---"
  grep "^file" $CONCAT | sed "s/file '//;s/'$//" | while read f; do
    if [ -f "$f" ]; then
      ls -lh "$f" | awk '{print "  OK "$5" "$NF}'
    else
      echo "  FALTA: $f"
    fi
  done
else
  echo "  $CONCAT no existe (player no ha arrancado aun)"
fi

echo ""
echo "════ CAPA 6: SALUD DEL SISTEMA ════"
TEMP=$(awk '{printf "%.1f", $1/1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null)
echo "CPU temp: ${TEMP}C  (limite: 80C)"
echo "Load avg: $(cat /proc/loadavg | awk '{print $1,$2,$3}')"
free -h | grep -E "Mem|Swap"
echo "Disco /home/sonoro/media: $(df -h /home/sonoro/media | tail -1 | awk '{print $3" usado de "$2" ("$5")"}')"
echo "OverlayFS:"
mount | grep -E "overlay|sonoro-sd" | awk '{print "  "$0}'
echo "Throttle flags (0=OK):"
vcgencmd get_throttled 2>/dev/null || echo "  vcgencmd no disponible"

echo ""
echo "════ CAPA 7: RED Y SOCKET.IO ════"
echo "Conexiones activas (hacia VPS):"
ss -tnp 2>/dev/null | grep ESTAB | grep -v "127.0.0\|::1" \
  | awk '{print "  "$1,$4,$5}' | head -5
echo "Tunel SSH inverso (puerto 22207):"
ss -tnp 2>/dev/null | grep 22207 | head -3 || echo "  no activo"

echo ""
echo "════ CAPA 8: LOGS PLAYER (ultimas 30, sin NALU spam) ════"
journalctl -u sonoro-player-rpi5 --no-pager -n 100 2>/dev/null \
  | grep -v "NALU\|offset_len\|alignment_bit\|chroma_log2\|chroma_weight" \
  | tail -30

echo ""
echo "════ CAPA 9: LOGS SYNC (ultimas 10) ════"
journalctl -u sonoro-sync-rpi5 --no-pager -n 10 2>/dev/null | tail -10

echo ""
echo "════ RESUMEN ════"
if pgrep ffmpeg > /dev/null; then
  UPTIME=$(ps -p $(pgrep ffmpeg | head -1) -o etime --no-headers 2>/dev/null | xargs)
  echo "ffmpeg:       CORRIENDO (PID=$(pgrep ffmpeg | head -1), uptime=$UPTIME)"
else
  echo "ffmpeg:       DETENIDO"
fi
echo "player-rpi5:  $(systemctl is-active sonoro-player-rpi5 2>/dev/null)"
echo "sync-rpi5:    $(systemctl is-active sonoro-sync-rpi5 2>/dev/null)"
echo "CPU temp:     ${TEMP}C"
echo "Socket.io:    $(ss -tnp 2>/dev/null | grep -c 'ESTAB.*443.*node') conexion(es) a :443"
echo "════════════════════════════════════════════════════════"
