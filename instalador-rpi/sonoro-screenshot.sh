#!/bin/bash
# SONORO RPi5 screenshot — extrae frame del video actual del concat demuxer.
# Uso: ./sonoro-screenshot.sh   (imprime PNG por stdout)
set -e
CONCAT=/tmp/sonoro-concat.txt
OUT=/tmp/sonoro-shot.png
[ -f "$CONCAT" ] || { echo "no concat file" >&2; exit 1; }
FILE=$(awk -F"'" 'NR==1{print $2}' "$CONCAT")
[ -f "$FILE" ] || { echo "no media file: $FILE" >&2; exit 1; }
/usr/bin/ffmpeg -y -hide_banner -loglevel error -ss 1 -i "$FILE" -vframes 1 -vf scale=1280:-1 "$OUT" </dev/null
cat "$OUT"
