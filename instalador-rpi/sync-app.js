require('dotenv').config();
const axios = require('axios');
const { io } = require('socket.io-client');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── DETECCIÓN DE PLATAFORMA ──────────────────────────────────
const IS_WINDOWS = process.platform === 'win32';

// ── RUTAS ────────────────────────────────────────────────────
const APP_DIR    = IS_WINDOWS
  ? path.join(process.env.APPDATA, 'SonoroCMS')
  : '/home/sonoro';
const MEDIA_DIR  = path.join(APP_DIR, 'media');
const PLAYER_DIR = path.join(APP_DIR, 'player');
const MPV_PATH   = IS_WINDOWS
  ? path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'mpv', 'mpv.exe')
  : 'mpv';

// ── CONFIG ───────────────────────────────────────────────────
const CMS_URL        = process.env.CMS_URL    || 'https://cms.sonoro.com.co';
const DEVICE_ID      = process.env.DEVICE_ID  || generateDeviceId();
const IMAGE_DURATION = parseInt(process.env.IMAGE_DURATION) || 15000;
const QUEUE_FILE     = process.platform === 'win32'
  ? path.join(os.tmpdir(), 'sonoro-queue.json')
  : '/tmp/sonoro-queue.json';
const OVERLAY_PNG    = '/tmp/sonoro-overlay.png';
const OVERLAY_SCRIPT = process.platform === 'win32' ? null
  : '/home/sonoro/sonoro-player/generate-overlay.js';
const LUA_SCRIPT     = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'SonoroCMS', 'player', 'queue-display.lua')
  : '/home/sonoro/sonoro-player/queue-display.lua';
const DISPLAY_ENV    = 'DISPLAY=:0 XAUTHORITY=/home/sonoro/.Xauthority';
const HOTPLUG_FILE   = '/home/sonoro/.sonoro-hotplug';

// ── TTS — Piper Neural (offline, ARM64) ──────────────────────
const PIPER_BIN   = '/usr/local/bin/piper';
const PIPER_MODEL = '/home/sonoro/piper/es_MX-claude-high.onnx';
const ttsCache    = new Map();   // clave texto → ruta WAV en /tmp
const TTS_MAX     = 60;          // entradas máximas en caché

let hasQueueLicense   = false;
let currentConfig     = null;
let stopPlayback0     = false;
let stopPlayback1     = false;    // segundo loop para modo dual/mirror
let chromiumQueuePids = [];       // PIDs de instancias Chromium de turnos (una por output)
let playerBusy        = false;    // mutex para evitar startPlayer() concurrente

// ── ESTADO GLOBAL DEL PLAYER ─────────────────────────────────
let currentState = {
  status: 'starting',        // starting | idle | playing | stopped | refreshing
  current_playlist: null,    // { id, name }
  current_item: null,        // { title, type, filename }
  item_index: 0,
  item_total: 0,
  started_at: Date.now(),
};
let globalSocket = null;     // referencia al socket activo para comandos remotos

// ── GENERAR DEVICE ID ÚNICO EN WINDOWS ──────────────────────
function generateDeviceId() {
  try {
    // Usar MAC address como identificador único
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
          const mac = addr.mac.replace(/:/g, '').toLowerCase();
          return `win-${mac}`;
        }
      }
    }
  } catch(e) {}
  return `win-${Date.now()}`;
}

// ── OBTENER IP LOCAL ─────────────────────────────────────────
function getLocalIP() {
  try {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address;
      }
    }
  } catch(e) {}
  return '0.0.0.0';
}

// ── REPORTAR ESTADO AL SERVIDOR ─────────────────────────────
function reportState(socket) {
  const sock = socket || globalSocket;
  if (!sock || !sock.connected) return;
  sock.emit('device_state', {
    device_id:        DEVICE_ID,
    status:           currentState.status,
    current_playlist: currentState.current_playlist,
    current_item:     currentState.current_item,
    item_index:       currentState.item_index,
    item_total:       currentState.item_total,
    uptime_s:         Math.floor((Date.now() - currentState.started_at) / 1000),
    ip:               getLocalIP(),
    platform:         IS_WINDOWS ? 'windows' : 'linux',
    timestamp:        new Date().toISOString(),
  });
}

// ── OBTENER INFO HDMI (solo Linux/RPi) ──────────────────────
function getHdmiInfo() {
  if (IS_WINDOWS) return Promise.resolve([]);
  return new Promise((resolve) => {
    exec(
      `${DISPLAY_ENV} xrandr --query 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const ports = [];
        // Cada línea de output conectado: "HDMI-A-1 connected 1920x1080+0+0 (normal ...) 710mm x 400mm"
        // o "HDMI-A-1 connected (normal ...)" cuando no tiene modo activo
        const lineRe = /^(\S+)\s+(connected|disconnected)(?:\s+(?:primary\s+)?(\d+)x(\d+)\+(\d+)\+(\d+))?/;
        for (const line of stdout.split('\n')) {
          const m = line.match(lineRe);
          if (m && m[2] === 'connected') {
            // Detectar transform (rotate) desde el descriptor de modo
            const rotMatch = line.match(/\((\w+)\s+(\w+)/);
            let transform = 'normal';
            if (line.includes('left')) transform = 'left';
            else if (line.includes('right')) transform = 'right';
            else if (line.includes('inverted')) transform = 'inverted';
            ports.push({
              port:       m[1],
              connected:  true,
              resolution: m[3] ? `${m[3]}x${m[4]}` : null,
              transform,
              w:  m[3] ? parseInt(m[3]) : 0,
              h:  m[4] ? parseInt(m[4]) : 0,
              x:  m[5] ? parseInt(m[5]) : 0,
              y:  m[6] ? parseInt(m[6]) : 0,
            });
          }
        }
        resolve(ports);
      }
    );
  });
}

// ── ESPERAR PANTALLA CONECTADA ───────────────────────────────
// Reintenta xrandr cada 2s hasta detectar al menos una pantalla.
// Una vez encontrada la primera, sigue sondeando 8s más para captar
// si hay una segunda pantalla que tarda más en registrarse en Wayland.
async function waitForDisplay(maxWaitMs = 30000) {
  if (IS_WINDOWS) return [];
  const start = Date.now();
  console.log('🖥️  Esperando pantalla conectada...');
  while (Date.now() - start < maxWaitMs) {
    const ports = await getHdmiInfo();
    const connected = ports.filter(p => p.connected);
    if (connected.length > 0) {
      // Sondear 8s más para captar segundo puerto si aparece más tarde
      let best = connected;
      const stabilizeStart = Date.now();
      while (Date.now() - stabilizeStart < 8000) {
        await new Promise(r => setTimeout(r, 1500));
        const ports2 = await getHdmiInfo();
        const connected2 = ports2.filter(p => p.connected);
        if (connected2.length > best.length) {
          best = connected2;
          console.log(`🔍 Pantalla adicional detectada: ${connected2.map(p => `${p.port}@${p.x},${p.y}`).join(', ')}`);
        }
      }
      console.log(`✅ ${best.length} pantalla(s) detectada(s): ${best.map(p => `${p.port}@${p.x},${p.y}`).join(', ')}`);
      return best;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.warn('⚠️ Sin pantalla en 30s — usando fallback HDMI-A-1');
  return [{ port: 'HDMI-A-1', connected: true, resolution: '1920x1080', transform: 'normal', w: 1920, h: 1080, x: 0, y: 0 }];
}

// ── CONFIGURAR SALIDAS X11 ────────────────────────────────────
// Aplica la topología de pantallas con xrandr según el modo y orientaciones.
// Llamar antes de lanzar mpv o Chromium.
// X11: rotaciones válidas: normal | left | right | inverted
// Detecta la mejor resolución disponible para un output y la aplica.
// Prioridad: 1920x1080 → 1280x720 → 1280x1024 → --auto (preferred del monitor)
// Reintenta hasta 3 veces (1500ms entre intentos) si EDID aún no llegó — TVs antiguos
// pueden tardar hasta 4-5s en entregar EDID tras reconexión HDMI en caliente.
async function xrandrSetOutput(port, rotation, extraFlags = '') {
  const preferred = ['1920x1080', '1280x720', '1280x1024'];
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let modesRaw = '';
    try {
      modesRaw = execSync(`${DISPLAY_ENV} xrandr --query 2>/dev/null`, { encoding: 'utf8' });
    } catch(e) {}

    // Extraer modos disponibles para este output específico
    const lines = modesRaw.split('\n');
    let inPort = false;
    const available = [];
    for (const line of lines) {
      if (line.startsWith(port + ' ')) { inPort = true; continue; }
      if (inPort) {
        if (line.match(/^\S/)) break; // siguiente output — salir
        const m = line.match(/^\s+(\d+x\d+)/);
        if (m) available.push(m[1]);
      }
    }

    // Verificar si hay algún modo preferido disponible
    const found = preferred.find(res => available.includes(res));
    if (found) {
      try {
        execSync(`${DISPLAY_ENV} xrandr --output ${port} --mode ${found} --rotate ${rotation} ${extraFlags}`, { stdio: 'ignore' });
        console.log(`🖥️  ${port}: ${found} (${rotation})${attempt > 0 ? ` [EDID intento ${attempt + 1}]` : ''}`);
        return;
      } catch(e) {}
    }

    // Sin modos preferidos — si quedan reintentos, esperar EDID del TV
    if (attempt < maxRetries) {
      console.log(`🔍 ${port}: esperando EDID (intento ${attempt + 1}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, 1500));
      // Forzar re-lectura del EDID
      try { execSync(`${DISPLAY_ENV} xrandr --auto 2>/dev/null`, { stdio: 'ignore' }); } catch(e) {}
    }
  }

  // Fallback final: dejar que el monitor elija su preferida
  try {
    execSync(`${DISPLAY_ENV} xrandr --output ${port} --auto --rotate ${rotation} ${extraFlags}`, { stdio: 'ignore' });
  } catch(e) {}
  console.log(`🖥️  ${port}: auto (${rotation}) [fallback tras ${maxRetries} intentos EDID]`);
}

async function configureOutputs(mode, ports, config) {
  if (IS_WINDOWS) return;
  const rotMap = { horizontal: 'normal', landscape: 'normal', vertical: 'left', portrait: 'left' };
  const rot = (k) => rotMap[config[k] || 'horizontal'] || 'normal';

  if (ports.length === 1) {
    const r0 = rot('orientation_hdmi0');
    try {
      await xrandrSetOutput(ports[0].port, r0, '--pos 0x0');
      console.log(`🖥️  X11: single — ${ports[0].port} (${r0})`);
    } catch(e) { console.warn('⚠️ xrandr single:', e.message); }
    return;
  }

  // 2 pantallas — port0 siempre en 0x0, port1 a la derecha
  const p0 = ports[0].port, p1 = ports[1].port;
  const r0 = rot('orientation_hdmi0'), r1 = rot('orientation_hdmi1');

  if (mode === 'tile-h' || mode === 'videowall') {
    const layout    = config.videowall_position || 'horizontal';
    const hdmi0slot = parseInt(config.videowall_cols || '1') || 1;
    const w0 = (r0 === 'left' || r0 === 'right') ? 1080 : 1920;
    const h0 = (r0 === 'left' || r0 === 'right') ? 1920 : 1080;
    const w1 = (r1 === 'left' || r1 === 'right') ? 1080 : 1920;
    const h1 = (r1 === 'left' || r1 === 'right') ? 1920 : 1080;
    let x0, y0, x1, y1, canvas;
    if (layout === 'horizontal') {
      x0 = hdmi0slot === 1 ? 0 : w1; y0 = 0;
      x1 = hdmi0slot === 1 ? w0 : 0; y1 = 0;
      canvas = `${w0 + w1}×${Math.max(h0, h1)}`;
    } else {
      x0 = 0; y0 = hdmi0slot === 1 ? 0 : h1;
      x1 = 0; y1 = hdmi0slot === 1 ? h0 : 0;
      canvas = `${Math.max(w0, w1)}×${h0 + h1}`;
    }
    try {
      await xrandrSetOutput(p0, r0, `--pos ${x0}x${y0}`);
      await xrandrSetOutput(p1, r1, `--pos ${x1}x${y1}`);
      console.log(`🖥️  X11: tiling ${layout} — canvas ${canvas} | ${p0}@${x0},${y0} / ${p1}@${x1},${y1}`);
    } catch(e) { console.warn('⚠️ xrandr tiling:', e.message); }

  } else if (mode === 'tile-v') {
    try {
      await xrandrSetOutput(p0, r0, '--pos 0x0');
      await xrandrSetOutput(p1, r1, `--below ${p0}`);
      console.log(`🖥️  X11: tile-v — ${p0}@0,0 / ${p1} below`);
    } catch(e) { console.warn('⚠️ xrandr tile-v:', e.message); }

  } else {
    // mirror / independent / queue — extendido lado a lado, port0 primario
    try {
      await xrandrSetOutput(p0, r0, '--pos 0x0 --primary');
      await xrandrSetOutput(p1, r1, `--right-of ${p0}`);
      console.log(`🖥️  X11: ${mode} — ${p0}(primario)@0,0 + ${p1}@right-of`);
    } catch(e) { console.warn('⚠️ xrandr dual:', e.message); }
  }
}

// ── OBSERVAR HOTPLUG HDMI ───────────────────────────────────
// udev escribe /home/sonoro/.sonoro-hotplug cuando detecta cambio DRM.
// Debounce de 4s para evitar el bucle de muerte: matar procesos genera
// más eventos DRM que vuelven a disparar el watcher.
function watchHdmiHotplug() {
  if (IS_WINDOWS) return;
  // Crear el archivo de señal si no existe — home del usuario, siempre accesible
  try { if (!fs.existsSync(HOTPLUG_FILE)) fs.writeFileSync(HOTPLUG_FILE, '0'); }
  catch(e) { console.error('❌ No se pudo crear HOTPLUG_FILE:', e.message); return; }

  let debounceTimer = null;

  fs.watchFile(HOTPLUG_FILE, { interval: 500 }, () => {
    // Resetear el timer en cada evento — solo actuar tras 4s de silencio
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      try { fs.writeFileSync(HOTPLUG_FILE, '0'); } catch(e) {}
      console.log('🔌 Hotplug HDMI detectado — redetectando pantallas...');
      if (!currentConfig) return;
      // Detener watcher temporalmente para no disparar con el kill de procesos
      fs.unwatchFile(HOTPLUG_FILE);
      // Activar outputs recién conectados — EDID completo llega después.
      // xrandrSetOutput() reintenta hasta 3 veces si EDID no está listo aún.
      try { execSync(`${DISPLAY_ENV} xrandr --auto 2>/dev/null`, { stdio: 'ignore' }); } catch(e) {}
      await new Promise(r => setTimeout(r, 1000));
      const ports = await getHdmiInfo();
      const connected = ports.filter(p => p.connected);
      if (connected.length > 0) {
        console.log('🔄 Reiniciando player tras hotplug...');
        await startPlayer(currentConfig);
      }
      // Reactivar watcher tras 5s (deja que el kernel se calme)
      setTimeout(() => watchHdmiHotplug(), 5000);
    }, 4000);
  });
  console.log('👁️  Hotplug watcher activo');
}

// ── OBTENER USO DE DISCO ─────────────────────────────────────
function getDiskUsage() {
  return new Promise((resolve) => {
    const cmd = IS_WINDOWS
      ? `powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free | ConvertTo-Json"`
      : `df -h / /home 2>/dev/null`;
    exec(cmd, { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      if (IS_WINDOWS) {
        try {
          const drives = JSON.parse(stdout);
          const arr = Array.isArray(drives) ? drives : [drives];
          return resolve(arr.map(d => ({
            filesystem: d.Name + ':',
            size: Math.round((d.Used + d.Free) / 1073741824) + 'G',
            used: Math.round(d.Used / 1073741824) + 'G',
            available: Math.round(d.Free / 1073741824) + 'G',
            use_pct: d.Used + d.Free > 0 ? Math.round(d.Used / (d.Used + d.Free) * 100) + '%' : '0%',
            mount: d.Name + ':',
          })));
        } catch(e) { return resolve([]); }
      }
      const lines = stdout.trim().split('\n').slice(1);
      resolve(lines.map(l => {
        const p = l.split(/\s+/);
        return { filesystem: p[0], size: p[1], used: p[2], available: p[3], use_pct: p[4], mount: p[5] };
      }));
    });
  });
}

// ── OBTENER INFO DE RED ──────────────────────────────────────
function getNetworkInfo() {
  return new Promise((resolve) => {
    if (IS_WINDOWS) {
      const ifaces = os.networkInterfaces();
      const result = [];
      for (const [name, addrs] of Object.entries(ifaces)) {
        for (const addr of addrs) {
          if (addr.family === 'IPv4' && !addr.internal) {
            result.push({ iface: name, ip: addr.address, mac: addr.mac });
          }
        }
      }
      return resolve({ interfaces: result, ssid: null, signal: null });
    }
    // Linux: ip + iwconfig
    exec(
      `ip -4 addr show 2>/dev/null | grep -E 'inet |^[0-9]' | grep -v '127.0.0.1'; iwgetid -r 2>/dev/null; iwconfig 2>/dev/null | grep 'Signal level'`,
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => {
        const lines = (stdout || '').split('\n');
        const ifaces = [];
        let ssid = null;
        let signal = null;
        for (const line of lines) {
          const ipMatch = line.match(/inet\s+([\d.]+).*\s(\S+)$/);
          if (ipMatch) ifaces.push({ iface: ipMatch[2], ip: ipMatch[1] });
          const ssidMatch = line.match(/^(.+)$/);
          if (ssidMatch && !line.includes('inet') && !line.includes('Signal') && line.trim().length > 0 && !ssid) {
            ssid = line.trim() || null;
          }
          const sigMatch = line.match(/Signal level[=:](-?\d+)/);
          if (sigMatch) signal = parseInt(sigMatch[1]);
        }
        resolve({ interfaces: ifaces, ssid, signal });
      }
    );
  });
}

// ── DETECTAR ORIENTACIÓN ─────────────────────────────────────
// Usa la orientación del primer puerto conectado (o config si está disponible)
function detectOrientation() {
  try {
    if (IS_WINDOWS) {
      const ps = `powershell -NoProfile -Command "(Get-CimInstance -ClassName Win32_DesktopMonitor | Select-Object -First 1).ScreenWidth -lt (Get-CimInstance -ClassName Win32_DesktopMonitor | Select-Object -First 1).ScreenHeight"`;
      const result = execSync(ps, { encoding: 'utf8', windowsHide: true }).trim();
      const isVertical = result === 'True';
      console.log(`🖥️  Orientación: ${isVertical ? 'VERTICAL' : 'HORIZONTAL'}`);
      return isVertical ? 'vertical' : 'horizontal';
    } else {
      const output = execSync(`${DISPLAY_ENV} xrandr --query 2>/dev/null`, { encoding: 'utf8' });
      // La rotación ACTUAL aparece ANTES del paréntesis en la línea "connected".
      // El texto "(normal left inverted right...)" lista rotaciones disponibles — ignorarlo.
      for (const line of output.split('\n')) {
        if (!line.includes(' connected ')) continue;
        const beforeParen = line.split('(')[0];
        if (beforeParen.includes(' left') || beforeParen.includes(' right')) return 'vertical';
      }
      return 'horizontal';
    }
  } catch(e) {
    console.warn('⚠️ No se pudo detectar orientación, usando horizontal');
    return 'horizontal';
  }
}

// ── MATAR REPRODUCTORES ──────────────────────────────────────
function killPlayers() {
  stopPlayback0 = true;
  stopPlayback1 = true;
  try {
    if (IS_WINDOWS) {
      execSync('taskkill /F /IM mpv.exe /T 2>nul', { stdio: 'ignore', windowsHide: true });
    } else {
      execSync('pkill -f mpv || true', { stdio: 'ignore' });
    }
  } catch(e) {}
  // Matar todas las instancias Chromium de turnos
  for (const pid of chromiumQueuePids) {
    try { process.kill(pid, 'SIGTERM'); } catch(e) {}
  }
  chromiumQueuePids = [];
  // Limpieza por nombre por si quedaron huérfanos
  try { execSync('pkill -f "chromium.*sonoro-queue" || true', { stdio: 'ignore' }); } catch(e) {}
  console.log('🔴 Players detenidos');
}

// ── OCULTAR CURSOR ───────────────────────────────────────────
function hideCursor() {
  if (IS_WINDOWS) {
    // Mover cursor fuera de pantalla via PowerShell
    try {
      exec(`powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(9999, 9999)"`,
        { windowsHide: true }
      );
      // Ocultar cursor cada 5 segundos
      setInterval(() => {
        exec(`powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(9999, 9999)"`,
          { windowsHide: true }
        );
      }, 5000);
    } catch(e) {}
  } else {
    // unclutter (lanzado en xinitrc.sh) oculta el cursor automáticamente tras 1s de inactividad.
    // No se necesita acción adicional desde Node.js.
  }
  console.log('🖱️  Cursor ocultado');
}

// ── CONSTRUCCIÓN DEL COMANDO MPV ─────────────────────────────
// screenTarget: objeto de puerto { port, x, y, w, h } o null (canvas completo / pantalla única)
// useLua: si true incluye el script Lua de overlay de turnos (modo legado)
function buildMpvCmd(filePath, extraArgs = [], screenTarget = null, useLua = false) {
  const baseArgs = [
    '--fullscreen',
    '--no-border',
    '--no-osc',
    '--no-osd-bar',
    '--cursor-autohide=always',
    '--no-audio',
    '--really-quiet',
  ];

  // Script Lua solo en modo legado (sin Chromium queue display)
  const luaArgs = (useLua && hasQueueLicense && fs.existsSync(LUA_SCRIPT))
    ? [`--script="${LUA_SCRIPT}"`, `--script-opts=queue_file=${QUEUE_FILE}`]
    : [];

  if (IS_WINDOWS) {
    const allArgs = [
      ...baseArgs,
      '--ontop',
      '--force-window=yes',
      '--taskbar-progress=no',
      ...luaArgs,
      ...extraArgs,
      `"${filePath}"`
    ].join(' ');
    return `"${MPV_PATH}" ${allArgs}`;
  } else {
    // En X11, --geometry=+X+Y posiciona la ventana en las coordenadas absolutas del output.
    // --fullscreen luego fullscreeniza en el monitor que contiene esa posición.
    const geomArgs = (screenTarget && typeof screenTarget === 'object')
      ? [`--geometry=+${screenTarget.x}+${screenTarget.y}`]
      : [];
    const allArgs = [
      ...baseArgs,
      '--vo=gpu',
      ...geomArgs,
      '--hwdec=v4l2m2m-copy',
      '--profile=fast',
      ...luaArgs,
      ...extraArgs,
      `"${filePath}"`
    ].join(' ');
    return `${DISPLAY_ENV} mpv ${allArgs}`;
  }
}

// ── SPLASH IDLE ──────────────────────────────────────────────
function showIdleSplash() {
  console.log('🎨 Mostrando splash idle...');
  const orientation  = detectOrientation();
  const splashFile   = orientation === 'vertical'
    ? path.join(MEDIA_DIR, 'splashverticalcms.png')
    : path.join(MEDIA_DIR, 'splashhorizontalcms.png');

  if (!fs.existsSync(splashFile)) {
    console.warn('⚠️ Splash no encontrado');
    return;
  }

  const cmd = buildMpvCmd(splashFile, ['--loop=inf']);
  exec(cmd, { windowsHide: IS_WINDOWS });
  console.log('✅ Splash idle mostrando');
}

// ── SPLASH DE ARRANQUE ───────────────────────────────────────
// ports: array de objetos de puerto para mostrar splash en cada output.
// Si no se pasa, muestra en el output por defecto (sin geometría).
function showSplash(ports = []) {
  return new Promise((resolve) => {
    const orientation = detectOrientation();
    const splashFile  = orientation === 'vertical'
      ? path.join(MEDIA_DIR, 'splashverticalcms.png')
      : path.join(MEDIA_DIR, 'splashhorizontalcms.png');

    if (!fs.existsSync(splashFile)) return resolve();

    console.log(`🎨 Splash de arranque ${orientation} (${ports.length || 1} pantalla(s))...`);

    // Lanzar un mpv por port para cubrir todos los outputs
    const targets = ports.length > 0 ? ports : [null];
    const children = targets.map(port => {
      const cmd = buildMpvCmd(splashFile, ['--image-display-duration=3'], port);
      return exec(cmd, { windowsHide: IS_WINDOWS });
    });

    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        children.forEach(c => { try { c.kill(); } catch(e) {} });
        resolve();
      }
    };
    // Resolver cuando el primer mpv termina (o tras 4s)
    children[0]?.on('exit', done);
    setTimeout(done, 4000);
  });
}

// ── REPRODUCIR VIDEO ─────────────────────────────────────────
function playVideo(filePath, screenTarget = null) {
  return new Promise((resolve) => {
    const label = screenTarget ? ` [${screenTarget.port || screenTarget}]` : '';
    console.log(`🎬 Video: ${path.basename(filePath)}${label}`);
    const cmd = buildMpvCmd(filePath, [], screenTarget);
    exec(cmd, { windowsHide: IS_WINDOWS }, () => resolve());
  });
}

// ── MOSTRAR IMAGEN ───────────────────────────────────────────
function showImage(filePath, durationMs, screenTarget = null) {
  return new Promise((resolve) => {
    const seconds = Math.ceil(durationMs / 1000);
    const label = screenTarget ? ` [${screenTarget.port || screenTarget}]` : '';
    console.log(`🖼️  Imagen: ${path.basename(filePath)} (${seconds}s)${label}`);
    const cmd = buildMpvCmd(filePath, [`--image-display-duration=${seconds}`], screenTarget);

    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    const child = exec(cmd, { windowsHide: IS_WINDOWS }, () => done());
    const killTimer = setTimeout(() => {
      try { child.kill(); } catch(e) {}
      setTimeout(done, 200);
    }, durationMs + 1000);
    child.on('exit', () => { clearTimeout(killTimer); done(); });
  });
}

// ── LOOP DE REPRODUCCIÓN ─────────────────────────────────────
// screenTarget: objeto de puerto { port, x, y } o null (canvas completo)
// updateState: si true actualiza currentState (solo el loop primario debe hacerlo)
async function playbackLoop(playlist, stopFlag, screenTarget = null, updateState = true) {
  let items = [...playlist.items];
  const label = screenTarget ? (screenTarget.port || screenTarget) : 'all';
  console.log(`▶️  Loop iniciado: ${playlist.name} (${items.length} items) [${label}]`);

  if (updateState) {
    currentState.current_playlist = { id: playlist.id, name: playlist.name };
    currentState.item_total = items.length;
    currentState.status = 'playing';
    reportState();
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  while (!stopFlag()) {
    if (playlist.shuffle_enabled) items = shuffle([...playlist.items]);
    let idx = 0;
    for (const item of items) {
      if (stopFlag()) break;
      if (!fs.existsSync(item.local_path)) { console.warn(`⚠️ No encontrado: ${item.local_path}`); continue; }

      // ── Actualizar estado del item actual ──
      currentState.current_item = {
        title:    item.title || path.basename(item.local_path),
        type:     item.type,
        filename: path.basename(item.local_path),
      };
      currentState.item_index = idx + 1;
      reportState();

      if (item.type === 'video')      await playVideo(item.local_path, screenTarget);
      else if (item.type === 'image') await showImage(item.local_path, item.duration_ms || IMAGE_DURATION, screenTarget);
      idx++;
    }
    if (!playlist.repeat_enabled) break;
  }
  console.log('⏹️  Loop terminado');
}

// ── CACHE ────────────────────────────────────────────────────
function loadCachedPlaylist(playlistId) {
  try {
    const jsonPath = path.join(MEDIA_DIR, `playlist_${playlistId}`, 'playlist.json');
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      console.log(`📦 Playlist cacheada: ${data.name} (${data.items.length} items)`);
      return data;
    }
  } catch(e) {}
  return null;
}

function loadCachedConfig() {
  try {
    const configPath = path.join(MEDIA_DIR, 'last_config.json');
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch(e) {}
  return null;
}

function saveConfigCache(config) {
  try { fs.writeFileSync(path.join(MEDIA_DIR, 'last_config.json'), JSON.stringify(config, null, 2)); } catch(e) {}
}

// ── SINCRONIZAR PLAYLIST ─────────────────────────────────────
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? require('https') : require('http');
    protocol.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
  });
}

async function syncPlaylist(playlistId) {
  if (!playlistId) return null;
  console.log(`\n🔄 Sincronizando playlist ${playlistId}...`);
  try {
    const response = await axios.get(`${CMS_URL}/api/player/playlist/${playlistId}`, { timeout: 8000 });
    const playlist = response.data;
    if (!playlist.items || !playlist.items.length) { console.warn('⚠️ Playlist vacía'); return null; }
    const playlistDir = path.join(MEDIA_DIR, `playlist_${playlistId}`);
    if (!fs.existsSync(playlistDir)) fs.mkdirSync(playlistDir, { recursive: true });
    const localItems = [];
    for (const item of playlist.items) {
      const ext = path.extname(item.file_path) || (item.type === 'video' ? '.mp4' : '.jpg');
      const localPath = path.join(playlistDir, `${item.content_id}${ext}`);
      if (!fs.existsSync(localPath)) {
        console.log(`📥 Descargando: ${item.title}`);
        try { await downloadFile(`${CMS_URL}${item.file_path}`, localPath); console.log(`✅ Descargado: ${item.title}`); }
        catch(err) { console.error(`❌ Error descargando: ${err.message}`); continue; }
      }
      localItems.push({ ...item, local_path: localPath, duration_ms: item.duration_ms || IMAGE_DURATION });
    }
    const localPlaylist = { ...playlist, items: localItems, synced_at: new Date().toISOString() };
    fs.writeFileSync(path.join(playlistDir, 'playlist.json'), JSON.stringify(localPlaylist, null, 2));
    console.log(`✅ Playlist lista: ${playlist.name} (${localItems.length} items)`);
    return localPlaylist;
  } catch(err) {
    console.error('❌ Error sincronizando:', err.message);
    return loadCachedPlaylist(playlistId);
  }
}

// ── REGISTRAR DISPOSITIVO ────────────────────────────────────
async function checkQueueLicense() {
  try {
    const res = await axios.get(`${CMS_URL}/api/devices/${DEVICE_ID}/license`, { timeout: 5000 });
    const data = res.data;
    // Verificar por features.turnos (nuevo) o por license_type (legacy)
    const byFeature = data.features?.turnos === true;
    const byLicense = data.active && (data.license_type === 'cms_queue' || data.license_type === 'queue' || data.license_type === 'windows');
    hasQueueLicense = byFeature || byLicense;
    console.log(`🎟️  Licencia de turnos: ${hasQueueLicense ? 'ACTIVA' : 'no incluida'}`);
  } catch (err) {
    console.warn('⚠️ No se pudo verificar licencia de turnos:', err.message);
    hasQueueLicense = false;
  }
}

async function writeQueueToken(tokenData) {
  try {
    // Consultar próximos turnos en cola
    let queue = [];
    try {
      const res = await axios.get(
        `${CMS_URL}/api/queue/branches/${tokenData.branch_id}/queue?status=waiting&limit=5`,
        { timeout: 3000 }
      );
      queue = (res.data || []).filter(t => t.token_id !== tokenData.token_id).slice(0, 4);
    } catch(e) {}

    const payload = { ...tokenData, queue };

    // En Linux: generar PNG con el diseño del overlay
    if (OVERLAY_SCRIPT && fs.existsSync(OVERLAY_SCRIPT)) {
      const { execSync } = require('child_process');
      try {
        // Pasar datos via archivo temporal para evitar problemas con caracteres especiales
        const tmpJson = QUEUE_FILE + '.gen';
        fs.writeFileSync(tmpJson, JSON.stringify(payload));
        execSync(`node "${OVERLAY_SCRIPT}" "${tmpJson}"`, { timeout: 10000 });
        try { fs.unlinkSync(tmpJson); } catch(e) {}
        console.log(`🎨 Overlay PNG generado: ${tokenData.token_number} (${queue.length} en cola)`);
      } catch(e) {
        console.error('❌ Error generando overlay PNG:', e.message);
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(payload));
      }
    } else {
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(payload));
      console.log(`📺 Turno escrito para overlay: ${tokenData.token_number} (${queue.length} en cola)`);
    }
  } catch (e) {
    console.error('❌ Error en writeQueueToken:', e.message);
  }
}

// ── TTS — PIPER NEURAL ────────────────────────────────────────
// Construye el texto de la locución a partir del evento token_called.
// Separa las letras del número con espacios para que el TTS las lea
// individualmente (A-14 → "A - uno cuatro").
function buildTtsText(data) {
  const rawNum  = (data.token_number || '').toString();
  // Insertar espacios entre cada carácter: "A-14" → "A - 1 4"
  const spellNum = rawNum.split('').join(' ');
  const svc = data.service_name  || '';
  const ctr = data.counter_name  || '';
  if (data.is_priority) {
    return `Atención prioritaria. Turno ${spellNum}. ${svc}. Pase a ${ctr}.`;
  }
  return `Turno ${spellNum}. ${svc}. Pase a ${ctr}.`;
}

// Genera un archivo WAV con Piper (usa stdin para evitar inyección de shell).
// Devuelve la ruta al archivo generado.
function generatePiperAudio(text) {
  return new Promise((resolve, reject) => {
    const tmpFile = `/tmp/sonoro-tts-${Date.now()}.wav`;
    const piper   = spawn(PIPER_BIN, [
      '--model',       PIPER_MODEL,
      '--output_file', tmpFile,
    ]);
    piper.stdin.write(text, 'utf8');
    piper.stdin.end();
    let errOut = '';
    piper.stderr.on('data', d => { errOut += d; });
    piper.on('close', code => {
      if (code === 0) resolve(tmpFile);
      else reject(new Error(`Piper exit ${code}: ${errOut.slice(0, 200)}`));
    });
    piper.on('error', err => reject(new Error(`Piper no disponible: ${err.message}`)));
  });
}

// Punto de entrada: genera (o recupera del caché) el WAV y lo reproduce.
// La reproducción es no bloqueante — el proceso principal continúa.
async function speakTurno(data) {
  if (IS_WINDOWS) return;   // TTS solo en RPi/Linux
  const text = buildTtsText(data);
  try {
    let wavFile;
    if (ttsCache.has(text)) {
      wavFile = ttsCache.get(text);
      console.log(`🔊 TTS (caché): ${data.token_number}`);
    } else {
      wavFile = await generatePiperAudio(text);
      ttsCache.set(text, wavFile);
      console.log(`🔊 TTS generado: ${data.token_number}`);
      // Evitar crecimiento indefinido — eliminar la entrada más antigua
      if (ttsCache.size > TTS_MAX) {
        const oldKey  = ttsCache.keys().next().value;
        const oldFile = ttsCache.get(oldKey);
        ttsCache.delete(oldKey);
        fs.unlink(oldFile, () => {});
      }
    }
    // Reproducir con aplay sin invocar shell — no bloquea el event loop
    spawn('aplay', ['-q', wavFile], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    console.warn('⚠️  TTS error:', e.message);
  }
}

async function registerDevice() {
  try {
    const ip = getLocalIP();
    await axios.post(`${CMS_URL}/api/devices/register`, {
      device_id: DEVICE_ID,
      name: process.env.DEVICE_NAME || `SONORO Windows - ${DEVICE_ID}`,
      ip_address: ip
    });
    console.log(`✅ Dispositivo registrado: ${DEVICE_ID} (${ip})`);
  } catch(err) { console.error('❌ Error registrando:', err.message); }
}

async function getDeviceConfig() {
  try {
    const response = await axios.get(`${CMS_URL}/api/devices/${DEVICE_ID}/config`, { timeout: 5000 });
    saveConfigCache(response.data);
    return response.data;
  } catch(err) { return null; }
}

// ── VERIFICAR RED ────────────────────────────────────────────
async function hasNetwork() {
  try {
    await axios.get(`${CMS_URL}/api/health`, { timeout: 5000 });
    return true;
  } catch(e) {
    try { await axios.get('http://1.1.1.1', { timeout: 3000 }); return true; }
    catch(e2) { return false; }
  }
}

// ── VERIFICAR ACTIVACIÓN ─────────────────────────────────────
async function isActivated() {
  try {
    const response = await axios.get(`${CMS_URL}/api/devices/${DEVICE_ID}/config`, { timeout: 5000 });
    if (response.data.needs_activation) return false;
    return true;
  } catch(e) {
    if (e.response?.status === 404 && e.response?.data?.needs_activation) return false;
    return null;
  }
}

// ── VERIFICAR LICENCIA ───────────────────────────────────────
async function checkLicense() {
  try {
    const response = await axios.get(`${CMS_URL}/api/devices/${DEVICE_ID}/license`, { timeout: 5000 });
    const data = response.data;
    if (data.status === 'expired' || data.status === 'suspended') {
      console.warn(`⚠️ Licencia ${data.status}`);
      return false;
    }
    return true;
  } catch(e) { return null; }
}

// ── PORTAL DE ACTIVACIÓN (Windows) ──────────────────────────
async function launchActivationPortal() {
  console.log('\n📱 Iniciando portal de activación en http://localhost:8080 ...');

  // Abrir el portal web en el navegador por defecto
  showIdleSplash();

  const portalPath = path.join(PLAYER_DIR, 'activation-portal.js');
  const portal = spawn('node', [portalPath], { detached: false, stdio: 'inherit' });

  // Abrir navegador automáticamente
  setTimeout(() => {
    if (IS_WINDOWS) {
      exec('start http://localhost:8080', { windowsHide: true });
    } else {
      exec('xdg-open http://localhost:8080');
    }
  }, 2000);

  portal.on('close', (code) => {
    console.log(`Portal cerrado (${code}). Reiniciando player...`);
    main();
  });
}

// ── SOCKET.IO ────────────────────────────────────────────────
function listenLicenseUpdates(socket) {
  socket.on(`license-updated-${DEVICE_ID}`, (data) => {
    console.log(`⚡ Licencia actualizada: ${data.status}`);
    if (data.status === 'active') {
      console.log('✅ Licencia renovada — reiniciando player');
      killPlayers();
      main();
    } else {
      killPlayers();
      showIdleSplash();
    }
  });
}

function connectSocket() {
  console.log(`🔌 Conectando a ${CMS_URL}...`);
  const socket = io(CMS_URL, { reconnection: true, reconnectionDelay: 5000, reconnectionAttempts: Infinity });

  globalSocket = socket;

  socket.on('connect', () => {
    console.log('✅ Socket.io conectado');
    // Registrar device en el servidor para recibir comandos dirigidos
    socket.emit('device_register', { device_id: DEVICE_ID });
    // Reportar estado inicial
    reportState(socket);
  });

  socket.on('disconnect', () => console.warn('⚠️ Socket.io desconectado'));

  listenLicenseUpdates(socket);

  // ── Turnos (módulo de atención) ──────────────────────────
  // El visual lo maneja Chromium queue-display.html via su propio Socket.io.
  // La RPi solo se encarga de la locución de voz.
  socket.on('token_called', (data) => {
    if (hasQueueLicense) speakTurno(data);
  });

  // ── Actualización de config desde dashboard ──────────────
  socket.on(`device-config-update-${DEVICE_ID}`, async (newConfig) => {
    console.log('\n⚡ Nueva configuración recibida');
    currentConfig = newConfig;
    saveConfigCache(newConfig);
    killPlayers();
    await startPlayer(newConfig);
  });

  // ════════════════════════════════════════════════════════
  // COMANDOS REMOTOS — enviados desde admin dashboard o cmd
  // ════════════════════════════════════════════════════════

  // 1. Forzar re-sync y recarga de playlist (sin reboot)
  socket.on('cmd_refresh_playlist', async () => {
    console.log('⚡ [CMD] refresh_playlist');
    currentState.status = 'refreshing';
    reportState(socket);
    killPlayers();
    if (currentConfig) {
      // Limpiar cache de ambas playlists para forzar descarga nueva
      const ids = [currentConfig.hdmi0_playlist_id, currentConfig.hdmi1_playlist_id].filter(Boolean);
      for (const playlistId of ids) {
        const cacheDir = path.join(MEDIA_DIR, `playlist_${playlistId}`);
        if (fs.existsSync(cacheDir)) {
          try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch(e) {}
        }
      }
      await startPlayer(currentConfig);
    } else {
      currentState.status = 'idle';
      showIdleSplash();
    }
    socket.emit('cmd_result', { command: 'refresh_playlist', success: true, device_id: DEVICE_ID });
  });

  // 2. Detener reproducción (mostrar splash)
  socket.on('cmd_stop', () => {
    console.log('⚡ [CMD] stop');
    currentState.status = 'stopped';
    currentState.current_item = null;
    killPlayers();
    showIdleSplash();
    reportState(socket);
    socket.emit('cmd_result', { command: 'stop', success: true, device_id: DEVICE_ID });
  });

  // 3. Reanudar reproducción
  socket.on('cmd_resume', async () => {
    console.log('⚡ [CMD] resume');
    if (currentConfig) {
      await startPlayer(currentConfig);
    } else {
      currentState.status = 'idle';
      showIdleSplash();
    }
    socket.emit('cmd_result', { command: 'resume', success: true, device_id: DEVICE_ID });
  });

  // 4. Solicitar estado inmediato
  socket.on('cmd_get_status', () => {
    console.log('⚡ [CMD] get_status');
    reportState(socket);
  });

  // 5. Info HDMI detallada (puertos, resolución, orientación)
  socket.on('cmd_get_hdmi', async () => {
    console.log('⚡ [CMD] get_hdmi');
    const hdmi = await getHdmiInfo();
    socket.emit('device_hdmi', { device_id: DEVICE_ID, ports: hdmi, timestamp: new Date().toISOString() });
  });

  // 6. Info de disco
  socket.on('cmd_get_disk', async () => {
    console.log('⚡ [CMD] get_disk');
    const disk = await getDiskUsage();
    socket.emit('device_disk', { device_id: DEVICE_ID, disk, timestamp: new Date().toISOString() });
  });

  // 7. Info de red (IP, WiFi SSID, señal)
  socket.on('cmd_get_network', async () => {
    console.log('⚡ [CMD] get_network');
    const net = await getNetworkInfo();
    socket.emit('device_network', { device_id: DEVICE_ID, ...net, timestamp: new Date().toISOString() });
  });

  // 8. Control de volumen del sistema
  socket.on('cmd_set_volume', ({ volume }) => {
    console.log(`⚡ [CMD] set_volume → ${volume}%`);
    const vol = Math.max(0, Math.min(100, parseInt(volume) || 50));
    if (!IS_WINDOWS) {
      exec(`pactl set-sink-volume @DEFAULT_SINK@ ${vol}% 2>/dev/null || amixer sset Master ${vol}% 2>/dev/null`, { stdio: 'ignore' });
    } else {
      exec(`powershell -NoProfile -WindowStyle Hidden -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]0xAD)" 2>nul`, { windowsHide: true });
    }
    socket.emit('cmd_result', { command: 'set_volume', success: true, volume: vol, device_id: DEVICE_ID });
  });

  // 9. Info completa del sistema RPi (CPU, RAM, temperatura)
  socket.on('cmd_get_sysinfo', () => {
    console.log('⚡ [CMD] get_sysinfo');
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    let temp = null;
    if (!IS_WINDOWS) {
      try {
        const t = require('child_process').execSync('vcgencmd measure_temp 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
        const m = t.match(/temp=([\d.]+)/);
        if (m) temp = parseFloat(m[1]);
      } catch(e) {}
    }
    socket.emit('device_sysinfo', {
      device_id: DEVICE_ID,
      cpu: { cores: cpus.length, model: cpus[0]?.model, speed_mhz: cpus[0]?.speed },
      memory: {
        total_mb:   Math.round(totalMem / 1048576),
        free_mb:    Math.round(freeMem  / 1048576),
        used_mb:    Math.round((totalMem - freeMem) / 1048576),
        use_pct:    ((totalMem - freeMem) / totalMem * 100).toFixed(1),
      },
      temp_celsius: temp,
      platform: IS_WINDOWS ? 'windows' : 'linux',
      node_version: process.version,
      uptime_s: Math.floor((Date.now() - currentState.started_at) / 1000),
      os_uptime_s: Math.floor(os.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // 10. Listar archivos de media descargados en la RPi
  socket.on('cmd_list_media', () => {
    console.log('⚡ [CMD] list_media');
    try {
      const files = [];
      if (fs.existsSync(MEDIA_DIR)) {
        const entries = fs.readdirSync(MEDIA_DIR, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subDir = path.join(MEDIA_DIR, entry.name);
            const subFiles = fs.readdirSync(subDir).map(f => {
              const fp = path.join(subDir, f);
              const st = fs.statSync(fp);
              return { name: f, size_bytes: st.size, dir: entry.name };
            });
            files.push(...subFiles);
          }
        }
      }
      socket.emit('device_media_list', { device_id: DEVICE_ID, files, total: files.length, timestamp: new Date().toISOString() });
    } catch(e) {
      socket.emit('device_media_list', { device_id: DEVICE_ID, files: [], error: e.message });
    }
  });

  // 11. Control CEC — TV1, TV2 o ambos
  // target: 'tv1' (cec0) | 'tv2' (cec1) | 'all' (ambos, default)
  socket.on('tv_request', ({ device_id, action, target }) => {
    if (IS_WINDOWS) return;
    const TV_SCRIPT   = '/home/sonoro/tv-ctl/tv-ctl.sh';
    const VALID_ACT   = ['on','off','status','hdmi1','hdmi2','hdmi3','hdmi4','mute','unmute'];
    const VALID_TGT   = ['tv1','tv2','all'];
    if (!VALID_ACT.includes(action)) return;
    const t = VALID_TGT.includes(target) ? target : 'all';
    console.log(`📺 TV ${action} → ${t}`);
    exec(`${TV_SCRIPT} ${t} ${action}`, (err, stdout) => {
      const output = (stdout || '').trim();
      const error  = err ? err.message : null;
      console.log(`📺 TV resultado (${t}):`, output || error);
      axios.post(`${CMS_URL}/api/devices/${device_id}/tv-result`, { action, target: t, output, error })
        .catch(e => console.error('📺 TV result error:', e.message));
    });
  });

  // 12. Screenshot — X11: scrot → base64 → screenshot_result socket event
  socket.on('screenshot_request', ({ device_id }) => {
    if (IS_WINDOWS) return;
    const tmpPath = `/tmp/screenshot-${DEVICE_ID}-${Date.now()}.png`;
    console.log(`📸 Screenshot solicitado → ${tmpPath}`);
    exec(`${DISPLAY_ENV} scrot ${tmpPath}`, (err) => {
      if (err) {
        console.error('❌ Screenshot error (scrot):', err.message);
        socket.emit('screenshot_result', { device_id, success: false, error: err.message });
        return;
      }
      try {
        const image = fs.readFileSync(tmpPath).toString('base64');
        socket.emit('screenshot_result', { device_id, success: true, image });
        console.log(`📸 Screenshot enviado (${Math.round(image.length / 1024)}KB base64)`);
      } catch(e) {
        socket.emit('screenshot_result', { device_id, success: false, error: e.message });
      } finally {
        try { fs.unlinkSync(tmpPath); } catch(e) {}
      }
    });
  });

  return socket;
}

function startHeartbeat() {
  setInterval(async () => {
    // Ping HTTP para mantener el device actualizado en BD
    try { await axios.get(`${CMS_URL}/api/devices/${DEVICE_ID}/config`, { timeout: 5000 }); }
    catch(e) {}
    // Reportar estado completo via socket
    reportState();
  }, 30000);
}

// ── LANZAR CHROMIUM QUEUE DISPLAY ───────────────────────────
// En X11 se usa --window-position=X,Y para posicionar cada instancia
// en las coordenadas absolutas del output objetivo. --kiosk fullscreeniza
// en el monitor que contiene ese punto — comportamiento determinista.
// Se lanza una instancia por cada output conectado con user-data-dir separado.
function launchQueueDisplay(branchId, ports) {
  if (IS_WINDOWS || !branchId || !ports?.length) return;
  const url = `${CMS_URL}/queue-display.html?device=${DEVICE_ID}&branch=${branchId}`;
  ports.forEach((port, idx) => {
    const w = port.w || 1920;
    const h = port.h || 1080;
    const x = port.x || 0;
    const y = port.y || 0;
    const userDataDir = `/tmp/chromium-sonoro-queue-${idx}`;
    // Escribir preferencias antes de lanzar para deshabilitar traducción y popups
    try {
      const prefDir = `${userDataDir}/Default`;
      fs.mkdirSync(prefDir, { recursive: true });
      fs.writeFileSync(`${prefDir}/Preferences`, JSON.stringify({
        translate: { enabled: false },
        browser: { show_home_button: false, translate_enabled: false },
        translate_whitelists: {},
        net: { network_prediction_options: 2 },
      }));
    } catch(e) {}
    const proc = exec([
      DISPLAY_ENV,
      'chromium',
      '--kiosk',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-session-crashed-bubble',
      '--noerrdialogs',
      '--disable-features=TranslateUI,Translate',
      '--disable-translate',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-gpu-rasterization',
      '--lang=es-CO',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-position=${x},${y}`,
      `--window-size=${w},${h}`,
      `--user-data-dir=${userDataDir}`,
      `"${url}"`
    ].join(' '));
    if (proc.pid) {
      chromiumQueuePids.push(proc.pid);
      console.log(`🌐 Queue Display [${port.port}] PID ${proc.pid} → pos ${x},${y} ${w}x${h}`);
    }
  });
}

// ── INICIAR PLAYER ───────────────────────────────────────────
async function startPlayer(config) {
  if (playerBusy) { console.log('⏭️  startPlayer ignorado — ya en ejecución'); return; }
  playerBusy = true;
  try {
    killPlayers();
    await new Promise(r => setTimeout(r, 500));

    // ── 1. Detectar pantallas conectadas ──────────────────────
    const connectedPorts = IS_WINDOWS ? [] : await waitForDisplay();
    const mode = config.display_mode || 'single';
    const hasDualPorts = connectedPorts.length >= 2;
    const port0 = connectedPorts[0] || { port: 'HDMI-A-1', x: 0,    y: 0, w: 1920, h: 1080 };
    const port1 = connectedPorts[1] || { port: 'HDMI-A-2', x: 1920, y: 0, w: 1920, h: 1080 };

    // ── 2. Configurar outputs xrandr ──────────────────────────
    if (!IS_WINDOWS) {
      const effectiveMode = hasDualPorts ? mode : 'single';
      await configureOutputs(effectiveMode, connectedPorts, config);
      await new Promise(r => setTimeout(r, 800));
      // Re-leer posiciones DESPUÉS de xrandr — configureOutputs() las modifica
      const refreshed = await getHdmiInfo();
      if (refreshed.length > 0) {
        connectedPorts.length = 0;
        refreshed.forEach(p => connectedPorts.push(p));
      }
    }
    const p0 = connectedPorts[0] || port0;
    const p1 = connectedPorts[1] || port1;

    await showSplash(connectedPorts);

    // ── 3. COLA ────────────────────────────────────────────────
    // queue_enabled: habilita/deshabilita por dispositivo (default true)
    // queue_output:  'all' → todos los outputs | 'hdmi0' → solo port0 | 'hdmi1' → solo port1
    const branchId    = config.branch_id;
    const queueEnabled = config.queue_enabled !== false; // default true
    const queueOutput  = config.queue_output || 'all';

    if (hasQueueLicense && branchId && queueEnabled) {
      // Seleccionar outputs según queue_output
      let queuePorts = connectedPorts.length ? connectedPorts : [p0];
      if (queueOutput === 'hdmi0') {
        queuePorts = [p0];
      } else if (queueOutput === 'hdmi1') {
        queuePorts = hasDualPorts ? [p1] : [p0]; // si no hay p1, usar p0
      }
      console.log(`🎟️  Modo queue activo → lanzando Chromium en ${queuePorts.length} output(s) [queue_output=${queueOutput}]`);
      launchQueueDisplay(branchId, queuePorts);

      // Si queue solo en un output y hay otro disponible → playlist en el segundo
      if (queueOutput === 'hdmi0' && hasDualPorts) {
        const playlistId = config.hdmi1_playlist_id || config.hdmi0_playlist_id;
        const playlist   = playlistId ? await syncPlaylist(playlistId) : null;
        if (playlist?.items.length) {
          stopPlayback1 = false;
          playbackLoop(playlist, () => stopPlayback1, p1);
        }
      } else if (queueOutput === 'hdmi1' && hasDualPorts) {
        const playlistId = config.hdmi0_playlist_id || config.hdmi1_playlist_id;
        const playlist   = playlistId ? await syncPlaylist(playlistId) : null;
        if (playlist?.items.length) {
          stopPlayback0 = false;
          playbackLoop(playlist, () => stopPlayback0, p0);
        }
      }
      return;
    }

    // ── 4. Modos de reproducción de video (sin queue) ─────────
    const effectiveMode = hasDualPorts ? mode : 'single';

    // tile-h / tile-v / videowall — mpv en canvas extendido, sin geometría fija
    if (effectiveMode === 'tile-h' || effectiveMode === 'tile-v' || effectiveMode === 'videowall') {
      const playlistId = config.hdmi0_playlist_id || config.hdmi1_playlist_id;
      const playlist   = playlistId ? await syncPlaylist(playlistId) : null;
      if (!playlist?.items.length) {
        console.warn('⚠️ Sin contenido para modo tile/videowall');
        currentState.status = 'idle'; reportState(); showIdleSplash(); return;
      }
      stopPlayback0 = false;
      playbackLoop(playlist, () => stopPlayback0, null, true); // null → canvas completo
      return;
    }

    // mirror — dos mpv independientes, misma playlist
    if (effectiveMode === 'mirror' && hasDualPorts) {
      const playlistId = config.hdmi0_playlist_id || config.hdmi1_playlist_id;
      const playlist   = playlistId ? await syncPlaylist(playlistId) : null;
      if (!playlist?.items.length) {
        console.warn('⚠️ Sin contenido para modo mirror');
        currentState.status = 'idle'; reportState(); showIdleSplash(); return;
      }
      stopPlayback0 = false;
      stopPlayback1 = false;
      playbackLoop(playlist, () => stopPlayback0, p0, true);   // primario: actualiza estado
      playbackLoop(playlist, () => stopPlayback1, p1, false);  // espejo: silencioso
      return;
    }

    // independent — playlist distinta por salida
    if (effectiveMode === 'independent' && hasDualPorts) {
      const [pl0, pl1] = await Promise.all([
        config.hdmi0_playlist_id ? syncPlaylist(config.hdmi0_playlist_id) : Promise.resolve(null),
        config.hdmi1_playlist_id ? syncPlaylist(config.hdmi1_playlist_id) : Promise.resolve(null),
      ]);
      if (!pl0 && !pl1) {
        console.warn('⚠️ Sin playlists para modo independent');
        currentState.status = 'idle'; reportState(); showIdleSplash(); return;
      }
      stopPlayback0 = false;
      stopPlayback1 = false;
      if (pl0) playbackLoop(pl0, () => stopPlayback0, p0, true);
      else console.warn(`⚠️ Sin playlist para ${p0.port}`);
      if (pl1) playbackLoop(pl1, () => stopPlayback1, p1, false);
      else console.warn(`⚠️ Sin playlist para ${p1.port}`);
      return;
    }

    // single (o fallback) — mpv en port0
    const playlistId = config.hdmi0_playlist_id || config.hdmi1_playlist_id;
    const playlist   = playlistId ? await syncPlaylist(playlistId) : null;
    if (!playlist?.items.length) {
      console.warn('⚠️ Sin contenido');
      currentState.status = 'idle'; reportState(); showIdleSplash(); return;
    }
    stopPlayback0 = false;
    playbackLoop(playlist, () => stopPlayback0, p0, true);

  } finally {
    playerBusy = false;
  }
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  console.log('\n🎬 SONORO AV Player v4.1 — X11/Openbox Edition');
  console.log(`📡 CMS: ${CMS_URL}`);
  console.log(`🖥️  Device: ${DEVICE_ID}`);
  console.log(`💻 Plataforma: ${IS_WINDOWS ? 'Windows' : 'Linux'}\n`);

  // Crear directorios si no existen
  [APP_DIR, MEDIA_DIR, PLAYER_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  // Verificar que mpv está instalado
  if (IS_WINDOWS && !fs.existsSync(MPV_PATH)) {
    console.error(`❌ mpv no encontrado en: ${MPV_PATH}`);
    console.error('   Descárgalo desde https://mpv.io/installation/');
    process.exit(1);
  }

  // 1. Verificar red
  const network = await hasNetwork();
  if (!network) {
    console.warn('⚠️ Sin conexión a internet');
    // En Windows no hay AP — mostrar splash y esperar
    showIdleSplash();
    console.log('⏳ Esperando conexión...');
    setTimeout(main, 30000);
    return;
  }

  // 2. Verificar activación
  const activated = await isActivated();
  if (activated === false) {
    await launchActivationPortal();
    return;
  }

  // 3. Verificar licencia
  const licenseOk = await checkLicense();
  if (licenseOk === false) {
    showIdleSplash();
    console.warn('⏳ Licencia vencida — esperando renovación...');
    connectSocket();
    return;
  }

  // 4. Registrar y obtener config
  await registerDevice();
  currentConfig = await getDeviceConfig();
  await checkQueueLicense();
  if (!currentConfig) currentConfig = loadCachedConfig();

  const socket = connectSocket();

  // Si tiene licencia de turnos, unirse a la sala del branch para recibir eventos
  if (hasQueueLicense && currentConfig) {
    const branchId = currentConfig.branch_id || currentConfig.hdmi0_branch_id;
    if (branchId) {
      socket.on('connect', () => {
        socket.emit('join_branch', branchId);
        console.log(`🎟️  Unido a sala de turnos: branch_${branchId}`);
      });
    }
  }

  startHeartbeat();
  hideCursor();
  watchHdmiHotplug();  // observar reconexiones HDMI en caliente

  if (currentConfig) {
    await startPlayer(currentConfig);
  } else {
    console.warn('⏳ Sin configuración — esperando asignación de playlist...');
    showIdleSplash();
  }
}

process.on('SIGTERM', () => { killPlayers(); process.exit(0); });
process.on('SIGINT',  () => { killPlayers(); process.exit(0); });

main().catch(console.error);
