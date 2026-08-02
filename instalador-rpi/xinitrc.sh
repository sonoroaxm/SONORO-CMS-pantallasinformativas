#!/bin/bash
# SONORO AV — X11 Session Init (kiosk mode)
# Ejecutado por xinit como session script

# Desactivar screensaver y DPMS
xset s off
xset -dpms
xset s noblank

# Desactivar bell
xset b off

# ── Enforcement de outputs HDMI según tier del device ─────────
# Bug S168 #7: RPi5 tier Sencilla usa solo HDMI-1 (unico puerto con CEC).
# Tiers Doble/Pro usan ambos. Se lee tier de /etc/default/sonoro (SONORO_TIER),
# default = 'sencilla' si no existe. Provisioning debe setear tier antes de shipping.
SONORO_TIER="sencilla"
[ -f /etc/default/sonoro ] && . /etc/default/sonoro

case "${SONORO_TIER:-sencilla}" in
  sencilla)
    # HDMI-1 exclusivo. HDMI-2 se ignora aunque este conectado (evita CEC-less HDMI2
    # tomando control de la sesion y facilita alistamiento predictible).
    xrandr --output HDMI-1 --mode 1920x1080 2>/dev/null || xrandr --output HDMI-1 --auto 2>/dev/null || true
    xrandr --output HDMI-A-1 --mode 1920x1080 2>/dev/null || xrandr --output HDMI-A-1 --auto 2>/dev/null || true
    ;;
  doble|pro)
    # Ambos outputs a 1080p; sync-app.js decide mirror vs independent per display_mode.
    for output in $(xrandr --query | grep ' connected' | awk '{print $1}'); do
      xrandr --output "$output" --mode 1920x1080 2>/dev/null || xrandr --output "$output" --auto
    done
    ;;
  *)
    echo "[xinitrc] SONORO_TIER='${SONORO_TIER}' desconocido, fallback multi-output" >&2
    for output in $(xrandr --query | grep ' connected' | awk '{print $1}'); do
      xrandr --output "$output" --mode 1920x1080 2>/dev/null || xrandr --output "$output" --auto
    done
    ;;
esac

# Ocultar cursor después de 1s de inactividad
unclutter -idle 1 -root -noevents &

# Window manager mínimo — sin session manager, sin decoraciones por defecto
openbox --sm-disable &

# Esperar a que openbox esté listo
sleep 0.8

# Señalar que X11 está listo (el player service puede conectarse via ExecStartPre)
touch /tmp/sonoro-x11-ready

# Mantener sesión viva hasta que el WM termine
wait
