#!/bin/bash
# SONORO AV — X11 Session Init (kiosk mode)
# Ejecutado por xinit como session script

# Desactivar screensaver y DPMS
xset s off
xset -dpms
xset s noblank

# Desactivar bell
xset b off

# Forzar resolución 1920x1080 en todos los outputs conectados
for output in $(xrandr --query | grep ' connected' | awk '{print $1}'); do
  xrandr --output "$output" --mode 1920x1080 2>/dev/null || xrandr --output "$output" --auto
done

# Ocultar cursor después de 1s de inactividad
unclutter -idle 1 -root -noevents &

# Window manager mínimo — sin session manager, sin decoraciones por defecto
openbox --sm-disable &

# Esperar a que openbox esté listo
sleep 0.8

# Señalar que X11 está listo (el player service puede conectarse)
touch /tmp/sonoro-x11-ready

# Mantener sesión viva hasta que el WM termine
wait
