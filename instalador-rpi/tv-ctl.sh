#!/bin/bash
# ============================================================
# SONORO AV — Control CEC de TV via HDMI v2.0
# Acciones: on, off, status, hdmi1, hdmi2, hdmi3, mute, unmute
# ============================================================

if [ -e /dev/cec1 ]; then
  DEV="/dev/cec1"
elif [ -e /dev/cec0 ]; then
  DEV="/dev/cec0"
else
  echo "$(date): ERROR — No se encontró /dev/cec0 ni /dev/cec1"
  exit 1
fi

LOG="/home/sonoro/tv-ctl/tv.log"

cec-ctl -d $DEV --playback --osd-name='SONORO-Player' > /dev/null 2>&1
sleep 1

PHYS_ADDR=$(cec-ctl -d $DEV 2>/dev/null | grep "Physical Address" | grep -v "f.f.f.f" | awk '{print $NF}')
if [ -z "$PHYS_ADDR" ] || [ "$PHYS_ADDR" = "f.f.f.f" ]; then
  PHYS_ADDR="3.0.0.0"
fi

case $1 in
  on)
    echo "$(date): TV ON [dev=$DEV addr=$PHYS_ADDR]" >> $LOG
    for i in 1 2 3; do
      cec-ctl -d $DEV --to 0 --cec-version-1.4 --image-view-on >> $LOG 2>&1
      sleep 3
      STATUS=$(cec-ctl -d $DEV --to 0 --cec-version-1.4 --give-device-power-status 2>/dev/null | grep "pwr-state")
      if echo "$STATUS" | grep -q "on"; then
        echo "$(date): TV ON confirmado en intento $i" >> $LOG
        break
      fi
      echo "$(date): Intento $i sin respuesta, reintentando..." >> $LOG
      sleep 2
    done
    cec-ctl -d $DEV --to 0 --cec-version-1.4 --active-source phys-addr=$PHYS_ADDR >> $LOG 2>&1
    echo "on"
    ;;
  off)
    echo "$(date): TV OFF [dev=$DEV]" >> $LOG
    cec-ctl -d $DEV --to 0 --cec-version-1.4 --standby >> $LOG 2>&1
    echo "off"
    ;;
  status)
    RESULT=$(cec-ctl -d $DEV --to 0 --cec-version-1.4 --give-device-power-status 2>&1 | grep pwr-state)
    echo "$(date): TV STATUS: $RESULT" >> $LOG
    echo "$RESULT"
    ;;
  hdmi1)
    echo "$(date): TV HDMI1" >> $LOG
    cec-ctl -d $DEV --to 0 --cec-version-1.4 --active-source phys-addr=1.0.0.0 >> $LOG 2>&1
    echo "hdmi1"
    ;;
  hdmi2)
    echo "$(date): TV HDMI2" >> $LOG
    cec-ctl -d $DEV --to 0 --cec-version-1.4 --active-source phys-addr=2.0.0.0 >> $LOG 2>&1
    echo "hdmi2"
    ;;
  hdmi3)
    echo "$(date): TV HDMI3" >> $LOG
    cec-ctl -d $DEV --to 0 --cec-version-1.4 --active-source phys-addr=3.0.0.0 >> $LOG 2>&1
    echo "hdmi3"
    ;;
  mute)
    echo "$(date): TV MUTE" >> $LOG
    cec-ctl -d $DEV --to 0 --cec-version-1.4 --user-control-pressed ui-cmd=mute >> $LOG 2>&1
    cec-ctl -d $DEV --to 0 --cec-version-1.4 --user-control-released >> $LOG 2>&1
    echo "mute"
    ;;
  unmute)
    echo "$(date): TV UNMUTE" >> $LOG
    cec-ctl -d $DEV --to 0 --cec-version-1.4 --user-control-pressed ui-cmd=mute >> $LOG 2>&1
    cec-ctl -d $DEV --to 0 --cec-version-1.4 --user-control-released >> $LOG 2>&1
    echo "unmute"
    ;;
  *)
    echo "Uso: $0 on|off|status|hdmi1|hdmi2|hdmi3|mute|unmute"
    exit 1
    ;;
esac
