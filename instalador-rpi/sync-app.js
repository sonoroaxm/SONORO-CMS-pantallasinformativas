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
const CMS_URL       = process.env.CMS_URL    || 'https://cms.sonoro.com.co';
const DEVICE_ID     = process.env.DEVICE_ID  || generateDeviceId();
const DISPLAY_MODE  = process.env.DISPLAY_MODE || 'mirror';
const IMAGE_DURATION = parseInt(process.env.IMAGE_DURATION) || 15000;
const QUEUE_FILE      = process.platform === 'win32'
  ? path.join(os.tmpdir(), 'sonoro-queue.json')
  : '/tmp/sonoro-queue.json';
const OVERLAY_PNG     = '/tmp/sonoro-overlay.png';
const OVERLAY_SCRIPT  = process.platform === 'win32' ? null
  : '/home/sonoro/sonoro-player/generate-overlay.js';
const LUA_SCRIPT    = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'SonoroCMS', 'player', 'queue-display.lua')
  : '/home/sonoro/sonoro-player/queue-display.lua';

let hasQueueLicense = false;
let currentConfig   = null;
let stopPlayback0   = false;

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

// ── DETECTAR ORIENTACIÓN EN WINDOWS ─────────────────────────
function detectOrientation() {
  try {
    if (IS_WINDOWS) {
      // Consultar orientación via PowerShell
      const ps = `powershell -NoProfile -Command "(Get-CimInstance -ClassName Win32_DesktopMonitor | Select-Object -First 1).ScreenWidth -lt (Get-CimInstance -ClassName Win32_DesktopMonitor | Select-Object -First 1).ScreenHeight"`;
      const result = execSync(ps, { encoding: 'utf8', windowsHide: true }).trim();
      const isVertical = result === 'True';
      console.log(`🖥️  Orientación: ${isVertical ? 'VERTICAL' : 'HORIZONTAL'}`);
      return isVertical ? 'vertical' : 'horizontal';
    } else {
      const output = execSync(
        `WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 wlr-randr`,
        { encoding: 'utf8' }
      );
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
  try {
    if (IS_WINDOWS) {
      execSync('taskkill /F /IM mpv.exe /T 2>nul', { stdio: 'ignore', windowsHide: true });
    } else {
      execSync('pkill -f mpv || true', { stdio: 'ignore' });
    }
  } catch(e) {}
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
function buildMpvCmd(filePath, extraArgs = []) {
  const baseArgs = [
    '--fullscreen',
    '--no-border',
    '--no-osc',
    '--no-osd-bar',
    '--cursor-autohide=always',
    '--no-audio',
    '--really-quiet',
  ];

  // Agregar script Lua de overlay de turnos si tiene licencia y el archivo existe
  const luaArgs = (hasQueueLicense && fs.existsSync(LUA_SCRIPT))
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
    const allArgs = [
      ...baseArgs,
      '--vo=gpu',
      '--gpu-context=wayland',
      `--fs-screen-name=${process.env.HDMI_SCREEN || 'HDMI-A-1'}`,
      '--hwdec=v4l2m2m',
      ...luaArgs,
      ...extraArgs,
      `"${filePath}"`
    ].join(' ');
    return `WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 mpv ${allArgs}`;
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
function playVideo(filePath) {
  return new Promise((resolve) => {
    console.log(`🎬 Video: ${path.basename(filePath)}`);
    const cmd = buildMpvCmd(filePath);
    exec(cmd, { windowsHide: IS_WINDOWS }, () => resolve());
  });
}

// ── MOSTRAR IMAGEN ───────────────────────────────────────────
function showImage(filePath, durationMs) {
  return new Promise((resolve) => {
    const seconds = Math.ceil(durationMs / 1000);
    console.log(`🖼️  Imagen: ${path.basename(filePath)} (${seconds}s)`);
    const cmd = buildMpvCmd(filePath, [`--image-display-duration=${seconds}`]);

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
async function playbackLoop(playlist, stopFlag) {
  let items = [...playlist.items];
  console.log(`▶️  Loop iniciado: ${playlist.name} (${items.length} items)`);

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  while (!stopFlag()) {
    if (playlist.shuffle_enabled) items = shuffle([...playlist.items]);
    for (const item of items) {
      if (stopFlag()) break;
      if (!fs.existsSync(item.local_path)) { console.warn(`⚠️ No encontrado: ${item.local_path}`); continue; }
      if (item.type === 'video')      await playVideo(item.local_path);
      else if (item.type === 'image') await showImage(item.local_path, item.duration_ms || IMAGE_DURATION);
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
    hasQueueLicense = data.active && (data.license_type === 'cms_queue' || data.license_type === 'queue');
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

async function registerDevice() {
  try {
    const ip = getLocalIP();
    await axios.post(`${CMS_URL}/api/devices/register`, {
      device_id: DEVICE_ID,
      name: process.env.DEVICE_NAME || `SONORO Windows - ${DEVICE_ID}`,
      ip_address: ip,
      display_mode: DISPLAY_MODE
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
    await axios.get(`${CMS_URL}/api/health`, { timeout: 15000 });
    return true;
  } catch(e) {
    try { await axios.get('http://1.1.1.1', { timeout: 8000 }); return true; }
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
  const socket = io(CMS_URL, { reconnection: true, reconnectionDelay: 5000, reconnectionAttempts: Infinity, pingTimeout: 60000, pingInterval: 25000 });
  socket.on('connect', () => {
    console.log('✅ Socket.io conectado');
    globalSocket = socket;
    socket.emit('device_register', { device_id: DEVICE_ID });

    function sendHeartbeat() {
      const { exec: ex } = require('child_process');
      ex(`vcgencmd measure_temp 2>/dev/null`, (err, stdout) => {
        let temp = null;
        const m = (stdout || '').match(/temp=([\d.]+)/);
        if (m) temp = parseFloat(m[1]);
        socket.emit('device_heartbeat', { device_id: DEVICE_ID, status: 'online', temp });
      });
    }
    sendHeartbeat();
    setInterval(sendHeartbeat, 30000);
  });
  socket.on('disconnect', () => console.warn('⚠️ Socket.io desconectado'));
  listenLicenseUpdates(socket);
  // Escuchar turnos llamados si tiene licencia de turnos
  socket.on('token_called', (data) => {
    if (hasQueueLicense) {
      writeQueueToken(data);
    }
  });

  socket.on(`device-config-update-${DEVICE_ID}`, async (newConfig) => {
    console.log('\n⚡ Nueva configuración recibida');
    currentConfig = newConfig;
    saveConfigCache(newConfig);
    killPlayers();
    await startPlayer(newConfig);
  });

  socket.on('logs_request', ({ device_id, lines }) => {
    console.log(`📋 Logs solicitados: ${lines} lineas`);
    const { exec: execSync } = require('child_process');
    execSync(`sudo journalctl -u sonoro-player -n ${lines || 100} --no-pager 2>&1`, (err, stdout) => {
      const logs = stdout || (err ? err.message : 'Sin logs');
      axios.post(`${CMS_URL}/api/devices/${device_id}/logs-result`, { logs })
        .catch(e => console.error('logs upload error:', e.message));
    });
  });

  socket.on('stats_request', ({ device_id }) => {
    console.log('📊 Stats solicitadas');
    const { exec: execSync } = require('child_process');
    execSync(`vcgencmd measure_temp 2>/dev/null; cat /sys/class/thermal/cooling_device0/cur_state 2>/dev/null || echo 'fan:n/a'`, (err, stdout) => {
      let temp = null, fanState = null;
      (stdout || '').split('\n').forEach(line => {
        const tm = line.match(/temp=([\d.]+)/); if (tm) temp = parseFloat(tm[1]);
        const fm = line.match(/^([0-3])$/); if (fm) fanState = parseInt(fm[1]);
        if (line.trim() === 'fan:n/a') fanState = -1;
      });
      const fanLabels = { '-1': 'N/A', 0: 'Apagado', 1: 'Bajo', 2: 'Medio', 3: 'Maximo' };
      const tempStatus = temp === null ? 'unknown' : temp >= 80 ? 'critical' : temp >= 65 ? 'warn' : 'ok';
      axios.post(`${CMS_URL}/api/devices/${device_id}/stats-result`, {
        temp, fan_state: fanState, fan_label: fanLabels[String(fanState)] || 'N/A', temp_status: tempStatus
      }).catch(e => console.error('stats upload error:', e.message));
    });
  });

  socket.on('update_request', ({ device_id, cmsUrl }) => {
    console.log('🔄 Actualizacion solicitada desde:', cmsUrl);
    const url = `${cmsUrl || CMS_URL}/sync-app.js`;
    const dest = '/home/sonoro/sonoro-player/sync-app.js';
    const { exec: execSync } = require('child_process');
    execSync(`wget -q -O ${dest}.new ${url} && mv ${dest}.new ${dest} && echo OK`, (err, stdout) => {
      if (err || !stdout.includes('OK')) {
        axios.post(`${CMS_URL}/api/devices/${device_id}/update-result`, { success: false, error: err?.message || 'Error descargando' })
          .catch(() => {});
        return;
      }
      axios.post(`${CMS_URL}/api/devices/${device_id}/update-result`, { success: true, message: 'sync-app.js actualizado' })
        .catch(() => {});
      console.log('✅ sync-app.js actualizado — reiniciando...');
      setTimeout(() => execSync('sudo systemctl restart sonoro-player', () => {}), 2000);
    });
  });

  socket.on('tv_schedule', ({ device_id, schedules }) => {
    console.log(`📅 Cronograma TV recibido: ${schedules.length} entradas`);
    const TV_SCRIPT = '/home/sonoro/tv-ctl/tv-ctl.sh';
    const DAY_MAP = { mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6', sun: '0' };
    const cronLines = [];
    for (const s of schedules) {
      if (!s.active) continue;
      const [onH, onM]   = (s.time_on  || '08:00').split(':');
      const [offH, offM] = (s.time_off || '22:00').split(':');
      const dayNums = (s.days || []).map(d => DAY_MAP[d]).filter(Boolean).join(',');
      if (!dayNums) continue;
      cronLines.push(`${onM} ${onH} * * ${dayNums} ${TV_SCRIPT} on  >> /home/sonoro/tv-ctl/tv.log 2>&1`);
      cronLines.push(`${offM} ${offH} * * ${dayNums} ${TV_SCRIPT} off >> /home/sonoro/tv-ctl/tv.log 2>&1`);
    }
    const header = '# SONORO TV schedules — no editar manualmente';
    const newCron = cronLines.length ? header + '\n' + cronLines.join('\n') : header;
    const cmd = `(crontab -l 2>/dev/null | grep -v 'tv-ctl\|SONORO TV'; echo '${newCron.replace(/'/g, "\'")}') | crontab -`;
    exec(cmd, (err) => {
      if (err) console.error('📅 Crontab error:', err.message);
      else console.log(`📅 Crontab aplicado: ${cronLines.length} entradas`);
      axios.post(`${CMS_URL}/api/devices/${device_id}/tv-schedule-result`, { success: !err, count: cronLines.length })
        .catch(() => {});
    });
  });

  socket.on('tv_request', ({ device_id, action }) => {
    console.log(`📺 TV ${action} solicitado`);
    const tvScript = '/home/sonoro/tv-ctl/tv-ctl.sh';
    const valid = ['on','off','status','hdmi1','hdmi2','hdmi3','mute','unmute'];
    if (!valid.includes(action)) return;
    exec(`${tvScript} ${action}`, (err, stdout) => {
      const output = (stdout || '').trim();
      const error  = err ? err.message : null;
      console.log(`📺 TV ${action} resultado:`, output || error);
      axios.post(`${CMS_URL}/api/devices/${device_id}/tv-result`, { action, output, error })
        .catch(e => console.error('📺 TV result upload error:', e.message));
    });
  });

  socket.on('screenshot_request', async ({ device_id, filename }) => {
    console.log('📸 Screenshot solicitado para:', device_id);
    const tmpPath = '/tmp/sonoro-screenshot.png';
    exec(`grim ${tmpPath}`, async (err) => {
      if (err) { console.error('📸 grim error:', err.message); return; }
      try {
        const FormData = require('form-data');
        const form = new FormData();
        form.append('screenshot', fs.createReadStream(tmpPath), { filename: filename || `screenshot-${device_id}.png` });
        const uploadUrl = `${CMS_URL}/api/devices/${device_id}/screenshot-upload`;
        console.log('📸 Subiendo a:', uploadUrl);
        const response = await axios.post(uploadUrl, form, { headers: form.getHeaders(), timeout: 30000 });
        console.log('📸 Screenshot subido exitosamente:', response.data);
        try { fs.unlinkSync(tmpPath); } catch(e) {}
      } catch(e) {
        console.error('📸 Error subiendo screenshot:', e.message, e.code);
      }
    });
  });
  return socket;
}

function startHeartbeat() {
  setInterval(async () => {
    try { await axios.get(`${CMS_URL}/api/devices/${DEVICE_ID}/config`, { timeout: 5000 }); }
    catch(e) {}
  }, 30000);
}

// ── INICIAR PLAYER ───────────────────────────────────────────
async function startPlayer(config) {
  killPlayers();
  await new Promise(r => setTimeout(r, 500));
  await showSplash();

  const playlistId = config.hdmi0_playlist_id || config.hdmi1_playlist_id;
  if (!playlistId) { console.warn('⚠️ Sin playlist asignada'); showIdleSplash(); return; }

  const localPlaylist = await syncPlaylist(playlistId);
  if (!localPlaylist || !localPlaylist.items.length) { console.warn('⚠️ Sin contenido'); showIdleSplash(); return; }

  stopPlayback0 = false;
  playbackLoop(localPlaylist, () => stopPlayback0);
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
