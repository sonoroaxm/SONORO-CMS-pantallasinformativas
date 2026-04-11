#!/bin/bash
# ============================================================
# SONORO AV — Control CEC de TV v3.0 — Dual HDMI
# Uso: tv-ctl.sh [tv1|tv2|all] on|off|status|hdmi1|hdmi2|hdmi3|hdmi4|mute|unmute
#
#   tv1  → /dev/cec0 (salida HDMI-A-1)
#   tv2  → /dev/cec1 (salida HDMI-A-2)
#   all  → ambas (default si no se especifica)
#
# Ejemplos:
#   tv-ctl.sh on             → enciende ambos TVs
#   tv-ctl.sh tv1 off        → apaga solo TV1
#   tv-ctl.sh all status     → estado de ambos
#   tv-ctl.sh tv2 hdmi1      → cambia TV2 a HDMI 1
# ============================================================

LOG="/home/sonoro/tv-ctl/tv.log"

# ── Parsear argumentos ────────────────────────────────────────
if [[ "$1" =~ ^(tv1|tv2|all)$ ]]; then
  TARGET="$1"
  ACTION="$2"
else
  # Retrocompatibilidad: un solo argumento = acción aplicada a todos
  TARGET="all"
  ACTION="$1"
fi

if [ -z "$ACTION" ]; then
  echo "Uso: $0 [tv1|tv2|all] on|off|status|hdmi1|hdmi2|hdmi3|hdmi4|mute|unmute"
  exit 1
fi

# ── Resolver dispositivos según target ───────────────────────
DEVS=()
case "$TARGET" in
  tv1)
    [ -e /dev/cec0 ] && DEVS+=("/dev/cec0") || { echo "ERROR: /dev/cec0 no disponible" | tee -a "$LOG"; exit 1; }
    ;;
  tv2)
    [ -e /dev/cec1 ] && DEVS+=("/dev/cec1") || { echo "ERROR: /dev/cec1 no disponible" | tee -a "$LOG"; exit 1; }
    ;;
  all)
    [ -e /dev/cec0 ] && DEVS+=("/dev/cec0")
    [ -e /dev/cec1 ] && DEVS+=("/dev/cec1")
    if [ ${#DEVS[@]} -eq 0 ]; then
      echo "$(date): ERROR — No se encontró ningún dispositivo CEC (/dev/cec0, /dev/cec1)" | tee -a "$LOG"
      exit 1
    fi
    ;;
esac

# ── Ejecutar acción en un dispositivo CEC ────────────────────
run_action() {
  local DEV="$1"
  local LABEL
  [ "$DEV" = "/dev/cec0" ] && LABEL="TV1" || LABEL="TV2"

  # Registrar como playback source
  cec-ctl -d "$DEV" --playback --osd-name='SONORO-Player' > /dev/null 2>&1
  sleep 0.5

  # Detectar dirección física
  local PHYS
  PHYS=$(cec-ctl -d "$DEV" 2>/dev/null | grep "Physical Address" | grep -v "f.f.f.f" | awk '{print $NF}')
  [ -z "$PHYS" ] || [ "$PHYS" = "f.f.f.f" ] && PHYS="3.0.0.0"

  case "$ACTION" in
    on)
      echo "$(date): $LABEL ON [dev=$DEV addr=$PHYS]" >> "$LOG"
      for i in 1 2 3; do
        cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --image-view-on >> "$LOG" 2>&1
        sleep 3
        local S
        S=$(cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --give-device-power-status 2>/dev/null | grep "pwr-state")
        if echo "$S" | grep -q "on"; then
          echo "$(date): $LABEL ON confirmado (intento $i)" >> "$LOG"
          break
        fi
        echo "$(date): $LABEL intento $i sin respuesta..." >> "$LOG"
        sleep 2
      done
      cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --active-source phys-addr="$PHYS" >> "$LOG" 2>&1
      echo "$LABEL:on"
      ;;
    off)
      echo "$(date): $LABEL OFF [dev=$DEV]" >> "$LOG"
      cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --standby >> "$LOG" 2>&1
      echo "$LABEL:off"
      ;;
    status)
      local RESULT
      RESULT=$(cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --give-device-power-status 2>&1 | grep pwr-state)
      echo "$(date): $LABEL STATUS: $RESULT" >> "$LOG"
      echo "$LABEL:$RESULT"
      ;;
    hdmi1)
      echo "$(date): $LABEL → HDMI1" >> "$LOG"
      cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --active-source phys-addr=1.0.0.0 >> "$LOG" 2>&1
      echo "$LABEL:hdmi1"
      ;;
    hdmi2)
      echo "$(date): $LABEL → HDMI2" >> "$LOG"
      cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --active-source phys-addr=2.0.0.0 >> "$LOG" 2>&1
      echo "$LABEL:hdmi2"
      ;;
    hdmi3)
      echo "$(date): $LABEL → HDMI3" >> "$LOG"
      cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --active-source phys-addr=3.0.0.0 >> "$LOG" 2>&1
      echo "$LABEL:hdmi3"
      ;;
    hdmi4)
      echo "$(date): $LABEL → HDMI4" >> "$LOG"
      cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --active-source phys-addr=4.0.0.0 >> "$LOG" 2>&1
      echo "$LABEL:hdmi4"
      ;;
    mute)
      echo "$(date): $LABEL MUTE" >> "$LOG"
      cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --user-control-pressed ui-cmd=mute >> "$LOG" 2>&1
      cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --user-control-released >> "$LOG" 2>&1
      echo "$LABEL:mute"
      ;;
    unmute)
      echo "$(date): $LABEL UNMUTE" >> "$LOG"
      cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --user-control-pressed ui-cmd=mute >> "$LOG" 2>&1
      cec-ctl -d "$DEV" --to 0 --cec-version-1.4 --user-control-released >> "$LOG" 2>&1
      echo "$LABEL:unmute"
      ;;
    *)
      echo "Acción desconocida: $ACTION"
      exit 1
      ;;
  esac
}

# ── Loop sobre los dispositivos seleccionados ─────────────────
for DEV in "${DEVS[@]}"; do
  run_action "$DEV"
done
