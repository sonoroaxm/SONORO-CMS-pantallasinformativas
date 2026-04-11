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
const WAYLAND_ENV    = 'WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000';
const HOTPLUG_FILE   = '/tmp/sonoro-hotplug';

// ── TTS — Piper Neural (offline, ARM64) ──────────────────────
const PIPER_BIN   = '/usr/local/bin/piper';
const PIPER_MODEL = '/home/sonoro/piper/es_MX-claude-high.onnx';
const ttsCache    = new Map();   // clave texto → ruta WAV en /tmp
const TTS_MAX     = 60;          // entradas máximas en caché

let hasQueueLicense  = false;
let currentConfig    = null;
let stopPlayback0    = false;
let stopPlayback1    = false;   // segundo loop para modo dual
let chromiumQueuePid = null;    // PID del proceso Chromium de turnos

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
      `${WAYLAND_ENV} wlr-randr 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const ports = [];
        const blocks = stdout.split('\n\n').filter(Boolean);
        for (const block of blocks) {
          const nameMatch     = block.match(/^(\S+)\s/m);
          const resMatch      = block.match(/current\s+(\d+x\d+)/);
          const enabledMatch  = block.match(/Enabled:\s+(yes|no)/i);
          const transformMatch = block.match(/Transform:\s+(\S+)/i);
          if (nameMatch) {
            ports.push({
              port:       nameMatch[1],
              connected:  enabledMatch ? enabledMatch[1] === 'yes' : block.includes('current'),
              resolution: resMatch ? resMatch[1] : null,
              transform:  transformMatch ? transformMatch[1] : 'normal',
            });
          }
        }
        resolve(ports);
      }
    );
  });
}

// ── ESPERAR PANTALLA CONECTADA ───────────────────────────────
// Reintenta wlr-randr cada 2s hasta detectar al menos una pantalla.
// Máximo maxWaitMs (default 30s). Fallback a HDMI-A-1 si no encuentra.
async function waitForDisplay(maxWaitMs = 30000) {
  if (IS_WINDOWS) return [];
  const start = Date.now();
  console.log('🖥️  Esperando pantalla conectada...');
  while (Date.now() - start < maxWaitMs) {
    const ports = await getHdmiInfo();
    const connected = ports.filter(p => p.connected);
    if (connected.length > 0) {
      console.log(`✅ ${connected.length} pantalla(s) detectada(s): ${connected.map(p => p.port).join(', ')}`);
      return connected;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.warn('⚠️ Sin pantalla en 30s — usando fallback HDMI-A-1');
  return [{ port: 'HDMI-A-1', connected: true, resolution: '1920x1080', transform: 'normal' }];
}

// ── CONFIGURAR SALIDAS WAYLAND ───────────────────────────────
// Aplica la topología de pantallas según el modo y orientaciones.
// Llamar antes de lanzar mpv o Chromium.
function configureWaylandOutputs(mode, ports, config) {
  if (IS_WINDOWS) return;
  const transformMap = { horizontal: 'normal', vertical: '90' };

  if (ports.length === 1) {
    const t = transformMap[config.orientation_hdmi0 || 'horizontal'] || 'normal';
    try {
      execSync(`${WAYLAND_ENV} wlr-randr --output ${ports[0].port} --on --transform ${t}`,
        { stdio: 'ignore' });
    } catch(e) { console.warn('⚠️ wlr-randr single:', e.message); }
    return;
  }

  // 2 pantallas
  const t0 = transformMap[config.orientation_hdmi0 || 'horizontal'] || 'normal';
  const t1 = transformMap[config.orientation_hdmi1 || 'horizontal'] || 'normal';

  if (mode === 'videowall') {
    // Superficie extendida: HDMI-A-1 izquierda, HDMI-A-2 derecha
    try {
      execSync(
        `${WAYLAND_ENV} wlr-randr ` +
        `--output HDMI-A-1 --on --pos 0,0    --mode 1920x1080@60 --transform ${t0} ` +
        `--output HDMI-A-2 --on --pos 1920,0 --mode 1920x1080@60 --transform ${t1}`,
        { stdio: 'ignore' }
      );
      console.log('🖥️  Wayland: modo videowall 3840×1080');
    } catch(e) { console.warn('⚠️ wlr-randr videowall:', e.message); }
  } else if (mode === 'dual') {
    // Pantallas independientes extendidas
    try {
      execSync(
        `${WAYLAND_ENV} wlr-randr ` +
        `--output HDMI-A-1 --on --pos 0,0    --mode 1920x1080@60 --transform ${t0} ` +
        `--output HDMI-A-2 --on --pos 1920,0 --mode 1920x1080@60 --transform ${t1}`,
        { stdio: 'ignore' }
      );
      console.log(`🖥️  Wayland: modo dual — A-1 ${t0} / A-2 ${t1}`);
    } catch(e) { console.warn('⚠️ wlr-randr dual:', e.message); }
  } else {
    // mirror / single — dejar al compositor clonar automáticamente
    console.log('🖥️  Wayland: modo mirror (clone automático)');
  }
}

// ── OBSERVAR HOTPLUG HDMI ───────────────────────────────────
// udev escribe /tmp/sonoro-hotplug cuando detecta cambio DRM.
// Este watcher reacciona automáticamente sin intervención manual.
function watchHdmiHotplug() {
  if (IS_WINDOWS) return;
  // Crear el archivo de señal si no existe para poder observarlo
  try { if (!fs.existsSync(HOTPLUG_FILE)) fs.writeFileSync(HOTPLUG_FILE, ''); } catch(e) {}

  fs.watchFile(HOTPLUG_FILE, { interval: 1000 }, async () => {
    try { fs.writeFileSync(HOTPLUG_FILE, ''); } catch(e) {}  // limpiar señal
    console.log('🔌 Hotplug HDMI detectado — redetectando pantallas...');
    await new Promise(r => setTimeout(r, 3000)); // esperar estabilización
    const ports = await getHdmiInfo();
    const connected = ports.filter(p => p.connected);
    if (connected.length > 0 && currentConfig) {
      console.log('🔄 Reiniciando player tras hotplug...');
      killPlayers();
      await startPlayer(currentConfig);
    }
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
      const output = execSync(`${WAYLAND_ENV} wlr-randr`, { encoding: 'utf8' });
      const match = output.match(/Transform:\s+(\S+)/);
      const transform = match ? match[1] : 'normal';
      return (transform === '90' || transform === '270') ? 'vertical' : 'horizontal';
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
  // Matar Chromium de turnos si estaba corriendo
  if (chromiumQueuePid) {
    try { process.kill(chromiumQueuePid, 'SIGTERM'); } catch(e) {}
    chromiumQueuePid = null;
  }
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
    const cmd = `WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 wlrctl pointer move 1921 1081`;
    exec(cmd);
    setInterval(() => { exec(cmd); }, 5000);
  }
  console.log('🖱️  Cursor ocultado');
}

// ── CONSTRUCCIÓN DEL COMANDO MPV ─────────────────────────────
// screenTarget: nombre del puerto Wayland ('HDMI-A-1', 'HDMI-A-2') o null (todas las pantallas)
// useLua: si true incluye el script Lua de overlay de turnos (solo modo legacy)
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

  // Script Lua solo en modo legacy (sin Chromium queue display)
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
    const screenArg = screenTarget ? [`--fs-screen-name=${screenTarget}`] : [];
    const allArgs = [
      ...baseArgs,
      '--vo=gpu',
      '--gpu-context=wayland',
      ...screenArg,
      '--hwdec=v4l2m2m',
      ...luaArgs,
      ...extraArgs,
      `"${filePath}"`
    ].join(' ');
    return `${WAYLAND_ENV} mpv ${allArgs}`;
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
function showSplash() {
  return new Promise((resolve) => {
    const orientation = detectOrientation();
    const splashFile  = orientation === 'vertical'
      ? path.join(MEDIA_DIR, 'splashverticalcms.png')
      : path.join(MEDIA_DIR, 'splashhorizontalcms.png');

    if (!fs.existsSync(splashFile)) return resolve();

    console.log(`🎨 Splash de arranque ${orientation}...`);
    const cmd = buildMpvCmd(splashFile, ['--image-display-duration=3']);

    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    const child = exec(cmd, { windowsHide: IS_WINDOWS }, () => done());
    const killTimer = setTimeout(() => {
      try { child.kill(); } catch(e) {}
      setTimeout(done, 200);
    }, 4000);
    child.on('exit', () => { clearTimeout(killTimer); done(); });
  });
}

// ── REPRODUCIR VIDEO ─────────────────────────────────────────
function playVideo(filePath, screenTarget = null) {
  return new Promise((resolve) => {
    console.log(`🎬 Video: ${path.basename(filePath)}${screenTarget ? ` [${screenTarget}]` : ''}`);
    const cmd = buildMpvCmd(filePath, [], screenTarget);
    exec(cmd, { windowsHide: IS_WINDOWS }, () => resolve());
  });
}

// ── MOSTRAR IMAGEN ───────────────────────────────────────────
function showImage(filePath, durationMs, screenTarget = null) {
  return new Promise((resolve) => {
    const seconds = Math.ceil(durationMs / 1000);
    console.log(`🖼️  Imagen: ${path.basename(filePath)} (${seconds}s)${screenTarget ? ` [${screenTarget}]` : ''}`);
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
// screenTarget: 'HDMI-A-1', 'HDMI-A-2', o null (todas las pantallas)
// updateState: si true actualiza currentState (solo el loop primario debe hacerlo)
async function playbackLoop(playlist, stopFlag, screenTarget = null, updateState = true) {
  let items = [...playlist.items];
  const label = screenTarget || 'all';
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
// Lanza el display web de turnos en la pantalla indicada.
// x,y: posición en el desktop Wayland extendido.
function launchQueueDisplay(branchId, x = 0, y = 0) {
  if (IS_WINDOWS || !branchId) return;
  const url = `${CMS_URL}/queue-display.html?device=${DEVICE_ID}&branch=${branchId}`;
  const proc = exec([
    `${WAYLAND_ENV}`,
    `chromium-browser --kiosk --no-sandbox --disable-infobars`,
    `--disable-session-crashed-bubble --noerrdialogs`,
    `--window-position=${x},${y} --window-size=1920,1080`,
    `--app="${url}"`
  ].join(' '));
  if (proc.pid) {
    chromiumQueuePid = proc.pid;
    console.log(`🌐 Queue Display lanzado (PID ${proc.pid}) en pos ${x},${y} → branch ${branchId}`);
  }
}

// ── INICIAR PLAYER ───────────────────────────────────────────
async function startPlayer(config) {
  killPlayers();
  await new Promise(r => setTimeout(r, 500));

  // ── 1. Detectar pantallas conectadas ──────────────────────
  const connectedPorts = IS_WINDOWS ? [] : await waitForDisplay();
  const mode = config.display_mode || 'single';
  const hasDualPorts = connectedPorts.length >= 2;

  // ── 2. Configurar Wayland según modo y puertos ────────────
  if (!IS_WINDOWS) {
    const effectiveMode = hasDualPorts ? mode : 'single';
    configureWaylandOutputs(effectiveMode, connectedPorts, config);
    await new Promise(r => setTimeout(r, 800)); // esperar estabilización Wayland
  }

  await showSplash();

  // Puerto físico de cada salida (agnóstico: usa el puerto real detectado)
  const port0 = connectedPorts[0]?.port || 'HDMI-A-1';
  const port1 = connectedPorts[1]?.port || 'HDMI-A-2';

  // ── 3. MODO single o mirror ───────────────────────────────
  if (!hasDualPorts || mode === 'single' || mode === 'mirror') {
    const playlistId = config.hdmi0_playlist_id || config.hdmi1_playlist_id;
    if (!playlistId) {
      console.warn('⚠️ Sin playlist asignada');
      currentState.status = 'idle';
      currentState.current_playlist = null;
      currentState.current_item = null;
      reportState();
      showIdleSplash();
      return;
    }
    const playlist = await syncPlaylist(playlistId);
    if (!playlist?.items.length) {
      console.warn('⚠️ Sin contenido');
      currentState.status = 'idle';
      reportState();
      showIdleSplash();
      return;
    }
    // single con 1 puerto: apuntar al puerto real detectado
    // mirror: null → mpv ocupa todas las pantallas disponibles
    const screenTarget = (mode === 'single' || !hasDualPorts) ? port0 : null;
    stopPlayback0 = false;
    playbackLoop(playlist, () => stopPlayback0, screenTarget, true);

    // Queue display en single/mirror: Chromium superpuesto en la misma pantalla
    if (hasQueueLicense) {
      const branchId = config.branch_id || config.hdmi0_branch_id;
      if (branchId) launchQueueDisplay(branchId, 0, 0);
    }
    return;
  }

  // ── 4. MODO dual — playlists distintas por pantalla ───────
  if (mode === 'dual') {
    const [pl0, pl1] = await Promise.all([
      config.hdmi0_playlist_id ? syncPlaylist(config.hdmi0_playlist_id) : Promise.resolve(null),
      config.hdmi1_playlist_id ? syncPlaylist(config.hdmi1_playlist_id) : Promise.resolve(null),
    ]);

    if (!pl0 && !pl1) {
      console.warn('⚠️ Sin playlists para modo dual');
      currentState.status = 'idle';
      reportState();
      showIdleSplash();
      return;
    }

    stopPlayback0 = false;
    stopPlayback1 = false;

    if (pl0) playbackLoop(pl0, () => stopPlayback0, port0, true);
    else console.warn(`⚠️ Sin playlist para ${port0}`);

    if (pl1) playbackLoop(pl1, () => stopPlayback1, port1, false);
    else console.warn(`⚠️ Sin playlist para ${port1}`);

    // Queue display en dual: Chromium en la segunda pantalla (pos 1920,0)
    if (hasQueueLicense) {
      const branchId = config.branch_id || config.hdmi0_branch_id;
      if (branchId) launchQueueDisplay(branchId, 1920, 0);
    }
    return;
  }

  // ── 5. MODO videowall — superficie extendida ──────────────
  if (mode === 'videowall') {
    const playlistId = config.hdmi0_playlist_id || config.hdmi1_playlist_id;
    if (!playlistId) {
      console.warn('⚠️ Sin playlist para videowall');
      currentState.status = 'idle';
      reportState();
      showIdleSplash();
      return;
    }
    const playlist = await syncPlaylist(playlistId);
    if (!playlist?.items.length) {
      console.warn('⚠️ Playlist vacía');
      currentState.status = 'idle';
      reportState();
      showIdleSplash();
      return;
    }
    // null: mpv ocupa todo el canvas extendido 3840×1080
    stopPlayback0 = false;
    playbackLoop(playlist, () => stopPlayback0, null, true);
  }
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  console.log('\n🎬 SONORO AV Player v3.2 — Windows Edition');
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
