============================================================
SONORO AV — Preparación RPi4 v3.4
============================================================

ARCHIVOS:
  sonoro-setup.sh       → Instalación principal (Node, PM2, systemd, CEC)
  sonoro-wifi-setup.sh  → Configuración WiFi provisioning (hostapd)
  sync-app.js           → Player principal
  activation-portal.js  → Portal de activación
  queue-display.lua     → Overlay de turnos para mpv (licencia cms_queue)
  generate-overlay.js   → Generador de overlay PNG para turnos
  tv-ctl.sh             → Control CEC encendido/apagado TV via HDMI
  package.json          → Dependencias npm del player

ORDEN DE EJECUCIÓN EN LA RPi:
  1. sudo bash sonoro-setup.sh
  2. sudo bash sonoro-wifi-setup.sh
  3. sudo reboot

============================================================
CONTROL CEC — ENCENDIDO/APAGADO DEL TV VIA HDMI
============================================================

El script tv-ctl.sh se instala automáticamente en /home/sonoro/tv-ctl/
Auto-detecta el puerto CEC activo (/dev/cec0 o /dev/cec1).

Uso manual:
  /home/sonoro/tv-ctl/tv-ctl.sh on      → Encender TV
  /home/sonoro/tv-ctl/tv-ctl.sh off     → Apagar TV (standby)
  /home/sonoro/tv-ctl/tv-ctl.sh status  → Ver estado (on/standby)

Logs en: /home/sonoro/tv-ctl/tv.log

------------------------------------------------------------
COMPATIBILIDAD POR MARCA
------------------------------------------------------------

LG Signage (series SM, UL, SE, UH, SR, UM)
  Encendido : SI
  Apagado   : SI
  Configuración en el TV:
    Menu → General → SIMPLINK (HDMI-CEC) → ON
    Menu → General → Standby Mode → Receive Only  ← OBLIGATORIO
  Probado con: LG 32SM5J-B

Samsung (Tizen consumer y Signage — Anynet+)
  Encendido : SI
  Apagado   : SI
  Configuración en el TV:
    Settings → General → External Device Manager → Anynet+ (HDMI-CEC) → ON
    Anynet+ → Auto Turn Off → ON  ← OBLIGATORIO para el apagado

Philips (EasyLink)
  Encendido : SI
  Apagado   : SI
  Configuración en el TV:
    Settings → EasyLink → ON

Sony Bravia (Bravia Sync)
  Encendido : SI
  Apagado   : SI
  Configuración en el TV:
    Settings → Bravia Sync → ON
    Device Auto Power Off → ON

LG TV doméstico (webOS consumer)
  Encendido : SI
  Apagado   : NO — limitación de firmware LG consumer
  Configuración en el TV:
    Menu → General → SIMPLINK (HDMI-CEC) → ON
  ALTERNATIVA APAGADO: usar el timer integrado del TV
    Menu → General → Timers → Off Time → configurar horario

TCL (Roku TV / Google TV)
  Encendido : SI (mayoría de modelos)
  Apagado   : VARIABLE — depende del modelo específico
  Configuración en el TV:
    Settings → System → Control other devices (CEC) → ON
  ALTERNATIVA APAGADO: timer integrado del TV

Hisense (VIDAA / Google TV)
  Encendido : SI (mayoría de modelos)
  Apagado   : VARIABLE — funcionalidad CEC limitada reportada
  Configuración en el TV:
    Settings → Device Preferences → CEC → ON
  ALTERNATIVA APAGADO: timer integrado del TV

Hyundai / Caixun (Android TV económico)
  Encendido : VARIABLE — probar caso por caso
  Apagado   : VARIABLE — sin documentación oficial de CEC
  ALTERNATIVA APAGADO: timer integrado del TV

------------------------------------------------------------
NOTA IMPORTANTE PARA EL CLIENTE
------------------------------------------------------------

Para las marcas que no soportan apagado via CEC (LG doméstico,
TCL, Hisense, Hyundai, Caixun), la alternativa más confiable
es el TIMER INTEGRADO DEL TV:

  Todos los TVs modernos tienen una función de programación
  de encendido/apagado en su menú de configuración.
  Configure el horario directamente en el TV y el RPi
  continuará reproduciendo contenido independientemente.

  Esta solución no requiere ningún cable adicional ni
  configuración extra en el RPi.

------------------------------------------------------------
DIAGNÓSTICO CEC (si el TV no responde)
------------------------------------------------------------

1. Verificar que el cable HDMI soporte CEC (pin 13 activo):
   ls -la /dev/cec*
   → Debe aparecer /dev/cec0 o /dev/cec1

2. Ver topología de red CEC:
   cec-ctl -d /dev/cec1 -s -S
   → Debe mostrar el TV en 0.0.0.0

3. Si la topología está vacía:
   → Verificar que CEC/SimpLink/Anynet+ esté activo en el TV
   → Probar con otro cable HDMI (cables baratos no tienen pin 13)
   → No usar splitters HDMI sin CEC passthrough

============================================================
FLUJO DE ACTIVACIÓN (cliente)
============================================================

Con cable ethernet:
  → RPi arranca → muestra QR en pantalla
  → Cliente abre URL desde celular → ingresa código SNR-XXXX-XXXX
  → Listo

Sin cable (solo WiFi):
  → RPi arranca → activa WiFi "SONORO-Setup"
  → Cliente conecta celular a "SONORO-Setup"
  → Cliente abre URL → selecciona su WiFi + ingresa código
  → RPi se conecta al WiFi del cliente → Listo

============================================================
