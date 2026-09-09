#!/bin/bash
# SONORO RPi5 screenshot — extrae frame del media actualmente en pantalla.
#
# Fix S197d: refactor secuencial (S177) eliminó el concat demuxer, y vout_drm
# escribe a DRM plane (no a /dev/fb0), así que fbcat retorna negro. player-rpi5.js
# escribe el path del media activo en /tmp/sonoro-current.txt cada vez que
# spawn ffmpeg (playlist item o splash idle). Este script lo lee y extrae
# frame con ffmpeg -ss.
#
# Uso: ./sonoro-screenshot.sh   (imprime PNG por stdout)
set -e
MARKER=/tmp/sonoro-current.txt
OUT=/tmp/sonoro-shot.png
[ -f "$MARKER" ] || { echo "no marker file (/tmp/sonoro-current.txt) — player-rpi5 no ha spawneado ffmpeg todavía" >&2; exit 1; }
FILE=$(head -n 1 "$MARKER" | tr -d '\r\n ')
[ -f "$FILE" ] || { echo "no media file: $FILE" >&2; exit 1; }
/usr/bin/ffmpeg -y -hide_banner -loglevel error -ss 1 -i "$FILE" -vframes 1 -vf scale=1280:-1 "$OUT" </dev/null
cat "$OUT"
