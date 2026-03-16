#!/bin/bash
# ============================================================
# SONORO AV — Control CEC de TV via HDMI
# Probado: LG 32SM5J-B con SimpLink
# Requiere en el TV: SimpLink ON + Standby Mode: Receive Only
# ============================================================

# Auto-detectar dispositivo CEC activo
if [ -e /dev/cec1 ]; then
  DEV="/dev/cec1"
elif [ -e /dev/cec0 ]; then
  DEV="/dev/cec0"
else
  echo "$(date): ERROR — No se encontró /dev/cec0 ni /dev/cec1" >> /home/sonoro/tv-ctl/tv.log
  exit 1
fi

LOG="/home/sonoro/tv-ctl/tv.log"

# Re-registrar como Playback Device antes de cada comando
# Necesario cuando el adaptador pierde configuración tras reinicio del player
cec-ctl -d $DEV --playback --osd-name='SONORO-Player' > /dev/null 2>&1
sleep 1

# Obtener dirección física del RPi en el bus CEC
PHYS_ADDR=$(cec-ctl -d $DEV 2>/dev/null | grep "Physical Address" | grep -v "f.f.f.f" | awk '{print $NF}')
if [ -z "$PHYS_ADDR" ] || [ "$PHYS_ADDR" = "f.f.f.f" ]; then
  PHYS_ADDR="3.0.0.0"
fi

case $1 in
  on)
    echo "$(date): TV ON [dev=$DEV addr=$PHYS_ADDR]" >> $LOG
    # Reintentar hasta 3 veces si el TV no responde
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
    ;;
  off)
    echo "$(date): TV OFF [dev=$DEV]" >> $LOG
    cec-ctl -d $DEV --to 0 --cec-version-1.4 --standby >> $LOG 2>&1
    ;;
  status)
    cec-ctl -d $DEV --to 0 --cec-version-1.4 --give-device-power-status 2>&1 | grep pwr-state
    ;;
  *)
    echo "Uso: $0 on|off|status"
    exit 1
    ;;
esac
