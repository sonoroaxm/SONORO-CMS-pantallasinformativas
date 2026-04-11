SONORO AV CMS — Instalador RPi v4.0
=====================================
Fecha: Abril 2026
Soporte: daniel@sonoro.com.co | cms.sonoro.com.co

═══════════════════════════════════════
  NOVEDADES v4.0 — DUAL HDMI + TURNOS
═══════════════════════════════════════

PANTALLAS:
  - Soporte dual HDMI — dos TVs independientes desde una sola RPi4
  - Modos: single · mirror · dual (lista por pantalla) · videowall
  - Orientación configurable por pantalla (horizontal / vertical)
  - Detección automática de puertos conectados al arrancar
  - Reconexión automática si se desconecta/reconecta un HDMI

SISTEMA DE ATENCIÓN AL CLIENTE (TURNOS):
  - Display de turnos por Chromium — sin limitaciones gráficas
  - Lower third con tickets activos en tiempo real (Socket.io)
  - Overlay fullscreen al llamar turno con animaciones CSS
  - Branding personalizable: tema oscuro/claro, color de marca, logo propio
  - Voz de locución neural (Piper TTS, voz latinoamericana offline)

CONTROL CEC:
  - Control independiente TV1 (HDMI-A-1) y TV2 (HDMI-A-2)
  - Selector en el dashboard: Ambas / TV 1 / TV 2

LICENCIAS:
  - dual_hdmi: habilita modos Dual y Videowall (premium)
  - turnos: módulo de atención al cliente
  - onpremise: instalación en red local Windows
  - analytics: reportes de reproducción

═══════════════════════════════════════
  INSTALACIÓN EN RPi4
═══════════════════════════════════════

Repositorio instalador:
  https://github.com/sonoroaxm/SONORO-CMS-pantallasinformativas/tree/main/instalador-rpi

Requisitos:
  - Raspberry Pi 4 Model B (2GB RAM mínimo)
  - Raspbian OS Lite 64-bit (Debian Bookworm/Trixie)
  - Wayland habilitado (wlroots)
  - Acceso a internet para instalación inicial

Pasos:
  1. En el RPi, descargar el instalador completo:

     git clone https://github.com/sonoroaxm/SONORO-CMS-pantallasinformativas.git
     cd SONORO-CMS-pantallasinformativas/instalador-rpi

  2. Editar las variables al inicio del script (opcional — el script las pide si no se tocan):

     nano sonoro-setup.sh
       DEVICE_ID="rpi4-cliente-01"   ← cambiar al ID del dispositivo
       CMS_URL="https://cms.sonoro.com.co"  ← o IP local si es on-premise

  3. Ejecutar como root:

     sudo bash sonoro-setup.sh

  4. El script instala: Node.js, mpv, Chromium, Piper TTS (voz es_MX),
     crea el servicio systemd, configura tunnel SSH al VPS.

  5. Al finalizar, agrega la clave pública SSH al VPS (el script la muestra):

     echo "ssh-ed25519 AAAA..." >> ~/.ssh/authorized_keys  (en el VPS)

  6. sudo reboot — el dispositivo aparece en el dashboard en ~30 segundos

NOTA: El script copia sync-app.js, activation-portal.js y package.json
desde el mismo directorio — NO ejecutar el .sh solo, siempre clonar la
carpeta completa instalador-rpi/.

Config /boot/firmware/config.txt (agregar antes de ejecutar el instalador):
  hdmi_force_hotplug:0=1
  hdmi_force_hotplug:1=1
  hdmi_mode:0=16
  hdmi_mode:1=16

Hotspot de emergencia (si pierde WiFi):
  Red:    SCMS-[últimos 6 chars del DEVICE_ID en mayúsculas]
  Clave:  sonorocms
  Portal: http://192.168.4.1:8080

═══════════════════════════════════════
  INSTALACIÓN ON-PREMISE (WINDOWS)
═══════════════════════════════════════

Para redes corporativas sin acceso a internet o con política de
datos internos, SONORO CMS ofrece instalación on-premise en Windows.

Requisitos:
  - Windows 10/11 Pro (64-bit)
  - 4GB RAM, 50GB disco libre
  - Red local (no requiere internet)

Paquete: CMSWIN — repo sonoroaxm/CMSWIN
  - Backend Node.js + PostgreSQL como servicio Windows (NSSM)
  - Dashboard web accesible desde cualquier PC en la red
  - Módulo de gestión de turnos funciona 100% en red local
  - Reproductores RPi apuntan a IP local del servidor Windows

Activación:
  - Feature "onpremise" debe estar activo en la licencia del usuario
  - El servidor Windows no requiere DNS/dominio — solo IP local
  - Los RPi se configuran con CMS_URL=http://[IP-SERVIDOR]:3000

═══════════════════════════════════════
  TIPOS DE LICENCIA Y MÓDULOS
═══════════════════════════════════════

Tipo          | Turnos | Analytics | Dual HDMI | On-Premise
--------------+--------+-----------+-----------+-----------
cms           |   -    |     -     |     -     |     -
cms_queue     |   ✓    |     ✓     |     -     |     -
queue         |   ✓    |     -     |     -     |     -
rpi           |   -    |     -     |     -     |     -
windows       |   ✓    |     -     |     -     |     ✓

Dual HDMI se activa manualmente desde el panel admin independiente
del tipo de licencia (add-on premium).

═══════════════════════════════════════
  DIAGNÓSTICO RÁPIDO
═══════════════════════════════════════

VPS:
  pm2 status
  pm2 logs sonoro-backend --lines 20 --nostream | grep -i error
  curl -s https://cms.sonoro.com.co/api/health

RPi:
  sudo systemctl status sonoro-player
  sudo journalctl -u sonoro-player -n 30 --no-pager
  /home/sonoro/tv-ctl/tv-ctl.sh status
  piper --model ~/piper/es_MX-claude-high.onnx --version

SSH remoto al RPi via VPS:
  ssh -i ssh_sonoro.key debian@45.181.156.171
  ssh -p 2222 sonoro@localhost
