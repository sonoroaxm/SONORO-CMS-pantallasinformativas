require('dotenv').config();
const axios = require('axios');
const { io } = require('socket.io-client');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CMS_URL = process.env.CMS_URL || 'http://192.168.1.4:5000';
const DEVICE_ID = process.env.DEVICE_ID || 'rpi4-sonoro-01';
const DISPLAY_MODE = process.env.DISPLAY_MODE || 'mirror';
const MEDIA_DIR = '/home/sonoro/media';
const PLAYER_DIR = '/home/sonoro/player';
const WAYLAND_DISPLAY = 'wayland-0';
const XDG_RUNTIME_DIR = '/run/user/1000';
const IMAGE_DURATION = parseInt(process.env.IMAGE_DURATION) || 15000;

const SCREENS = {
  'HDMI-A-2': { x: 0,    y: 0, w: 1920, h: 1080 },
  'HDMI-A-1': { x: 1920, y: 0, w: 1024, h: 768  },
};

let currentConfig = null;
let stopPlayback0 = false;
let stopPlayback1 = false;

function getLocalIP() {
  try { return execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8' }).trim(); }
  catch (e) { return '0.0.0.0'; }
}

function loadCachedPlaylist(playlistId) {
  try {
    const jsonPath = path.join(MEDIA_DIR, `playlist_${playlistId}`, 'playlist.json');
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      console.log(`📦 Usando playlist cacheada: ${data.name} (${data.items.length} items)`);
      return data;
    }
  } catch (e) { console.error('❌ Error cargando cache:', e.message); }
  return null;
}

function loadCachedConfig() {
  try {
    const configPath = path.join(MEDIA_DIR, 'last_config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log('📦 Usando configuración cacheada localmente');
      return config;
    }
  } catch (e) {}
  return null;
}

function saveConfigCache(config) {
  try { fs.writeFileSync(path.join(MEDIA_DIR, 'last_config.json'), JSON.stringify(config, null, 2)); }
  catch (e) {}
}

async function registerDevice() {
  try {
    const ip = getLocalIP();
    await axios.post(`${CMS_URL}/api/devices/register`, {
      device_id: DEVICE_ID, name: `SONORO Player - ${DEVICE_ID}`,
      ip_address: ip, display_mode: DISPLAY_MODE
    });
    console.log(`✅ Dispositivo registrado: ${DEVICE_ID} (${ip})`);
  } catch (err) { console.error('❌ Error registrando dispositivo:', err.message); }
}

async function getDeviceConfig() {
  try {
    const response = await axios.get(`${CMS_URL}/api/devices/${DEVICE_ID}/config`, { timeout: 5000 });
    const config = response.data;
    saveConfigCache(config);
    return config;
  } catch (err) { console.error('❌ Error obteniendo config:', err.message); return null; }
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    require('http').get(url, (response) => {
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
    if (!playlist.items || playlist.items.length === 0) { console.warn('⚠️ Playlist vacía'); return null; }
    const playlistDir = path.join(MEDIA_DIR, `playlist_${playlistId}`);
    if (!fs.existsSync(playlistDir)) fs.mkdirSync(playlistDir, { recursive: true });
    const localItems = [];
    for (const item of playlist.items) {
      const ext = path.extname(item.file_path) || (item.type === 'video' ? '.mp4' : '.jpg');
      const localFilename = `${item.content_id}${ext}`;
      const localPath = path.join(playlistDir, localFilename);
      if (!fs.existsSync(localPath)) {
        console.log(`📥 Descargando: ${item.title}`);
        try { await downloadFile(`${CMS_URL}${item.file_path}`, localPath); console.log(`✅ Descargado: ${item.title}`); }
        catch (err) { console.error(`❌ Error descargando ${item.title}:`, err.message); continue; }
      } else { console.log(`✅ Ya existe: ${item.title}`); }
      localItems.push({ ...item, local_path: localPath, duration_ms: item.duration_ms || IMAGE_DURATION });
    }
    const localPlaylist = { ...playlist, items: localItems, synced_at: new Date().toISOString() };
    fs.writeFileSync(path.join(playlistDir, 'playlist.json'), JSON.stringify(localPlaylist, null, 2));
    console.log(`✅ Playlist sincronizada: ${playlist.name} (${localItems.length} items)`);
    return localPlaylist;
  } catch (err) {
    console.error('❌ Error sincronizando con CMS:', err.message);
    return loadCachedPlaylist(playlistId);
  }
}

function startBackground() {
  try { execSync('pkill -f swaybg || true', { stdio: 'ignore' }); } catch (e) {}
  setTimeout(() => {
    exec(`WAYLAND_DISPLAY=${WAYLAND_DISPLAY} XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR} swaybg -c 000000 -m solid_color`);
    console.log('✅ Fondo negro iniciado');
  }, 300);
}

function killPlayers() {
  stopPlayback0 = true;
  stopPlayback1 = true;
  try { execSync('pkill -f mpv || true', { stdio: 'ignore' }); } catch (e) {}
  try { execSync('pkill -f swayimg || true', { stdio: 'ignore' }); } catch (e) {}
  console.log('🔴 Players detenidos');
}

function hideCursor() {
  const cmd = `WAYLAND_DISPLAY=${WAYLAND_DISPLAY} XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR} wlrctl pointer move 1921 1081`;
  exec(cmd);
  setInterval(() => { exec(cmd); }, 5000);
  console.log('🖱️  Cursor oculto (fuera de pantalla)');
}

function detectOrientation() {
  try {
    const output = execSync(
      `WAYLAND_DISPLAY=${WAYLAND_DISPLAY} XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR} wlr-randr`,
      { encoding: 'utf8' }
    );
    const match = output.match(/Transform:\s+(\S+)/);
    const transform = match ? match[1] : 'normal';
    const isVertical = transform === '90' || transform === '270';
    console.log(`🖥️  Orientación detectada: ${isVertical ? 'VERTICAL' : 'HORIZONTAL'} (transform: ${transform})`);
    return isVertical ? 'vertical' : 'horizontal';
  } catch (e) {
    console.warn('⚠️ No se pudo detectar orientación, usando horizontal por defecto');
    return 'horizontal';
  }
}

function showSplash() {
  return new Promise((resolve) => {
    const orientation = detectOrientation();
    const splashFile = orientation === 'vertical'
      ? `${MEDIA_DIR}/splashverticalcms.png`
      : `${MEDIA_DIR}/splashhorizontalcms.png`;

    if (!fs.existsSync(splashFile)) {
      console.warn(`⚠️ Splash no encontrado: ${splashFile}`);
      return resolve();
    }

    console.log(`🎨 Mostrando splash ${orientation}...`);
    const cmd = `WAYLAND_DISPLAY=${WAYLAND_DISPLAY} XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR} mpv --vo=gpu --gpu-context=wayland --fullscreen --fs-screen-name=HDMI-A-2 --no-audio --no-osc --no-osd-bar --cursor-autohide=always --image-display-duration=3 "${splashFile}"`;

    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };

    const child = exec(cmd, () => done());
    const killTimer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (e) {}
      setTimeout(done, 200);
    }, 4000);
    child.on('exit', () => { clearTimeout(killTimer); done(); });
  });
}

// ─────────────────────────────────────────────
// playVideo y showImage aceptan screen opcional
// screen: 'HDMI-A-2' (default) o 'HDMI-A-1'
// ─────────────────────────────────────────────
function playVideo(filePath, screen = 'HDMI-A-2') {
  return new Promise((resolve) => {
    console.log(`🎬 [${screen}] Video: ${path.basename(filePath)}`);
    const cmd = `WAYLAND_DISPLAY=${WAYLAND_DISPLAY} XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR} mpv --vo=gpu --gpu-context=wayland --fullscreen --fs-screen-name=${screen} --no-audio --hwdec=v4l2m2m --no-osc --no-osd-bar --cursor-autohide=always "${filePath}"`;
    exec(cmd, () => resolve());
  });
}

function showImage(filePath, durationMs, screen = 'HDMI-A-2') {
  return new Promise((resolve) => {
    console.log(`🖼️  [${screen}] Imagen: ${path.basename(filePath)} (${durationMs / 1000}s)`);
    const seconds = Math.ceil(durationMs / 1000);
    const cmd = `WAYLAND_DISPLAY=${WAYLAND_DISPLAY} XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR} mpv --vo=gpu --gpu-context=wayland --fullscreen --fs-screen-name=${screen} --no-audio --no-osc --no-osd-bar --cursor-autohide=always --image-display-duration=${seconds} "${filePath}"`;

    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };

    const child = exec(cmd, () => done());
    const killTimer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (e) {}
      setTimeout(done, 200);
    }, durationMs + 1000);
    child.on('exit', () => { clearTimeout(killTimer); done(); });
  });
}

// ─────────────────────────────────────────────
// playbackLoop acepta screen para modo dual
// stopFlag: función que retorna true para parar
// ─────────────────────────────────────────────
async function playbackLoop(playlist, screen, stopFlag) {
  let items = [...playlist.items];
  console.log(`▶️  [${screen}] Loop iniciado con ${items.length} items`);

  function shuffleFY(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  while (!stopFlag()) {
    if (playlist.shuffle_enabled) items = shuffleFY([...playlist.items]);
    for (const item of items) {
      if (stopFlag()) break;
      if (!fs.existsSync(item.local_path)) { console.warn(`⚠️ No encontrado: ${item.local_path}`); continue; }
      if (item.type === 'video') await playVideo(item.local_path, screen);
      else if (item.type === 'image') await showImage(item.local_path, item.duration_ms || IMAGE_DURATION, screen);
    }
    if (!playlist.repeat_enabled) break;
  }
  console.log(`⏹️  [${screen}] Loop terminado`);
}

async function startPlayer(config) {
  startBackground();
  killPlayers();
  await new Promise(r => setTimeout(r, 1000));
  await showSplash();

  const mode = config.display_mode || 'mirror';
  console.log(`\n🎬 Iniciando player - Modo: ${mode.toUpperCase()}`);

  if (mode === 'dual') {
    const id0 = config.hdmi0_playlist_id;
    const id1 = config.hdmi1_playlist_id;
    if (!id0 && !id1) { console.warn('⚠️ Sin playlists asignadas'); return; }
    stopPlayback0 = false;
    stopPlayback1 = false;
    if (id0) {
      const playlist0 = await syncPlaylist(id0);
      if (playlist0 && playlist0.items.length > 0) playbackLoop(playlist0, 'HDMI-A-2', () => stopPlayback0);
    }
    if (id1) {
      const playlist1 = await syncPlaylist(id1);
      if (playlist1 && playlist1.items.length > 0) playbackLoop(playlist1, 'HDMI-A-1', () => stopPlayback1);
    }
  } else {
    const playlistId = config.hdmi0_playlist_id || config.hdmi1_playlist_id;
    if (!playlistId) { console.warn('⚠️ Sin playlist asignada'); return; }
    const localPlaylist = await syncPlaylist(playlistId);
    if (!localPlaylist || localPlaylist.items.length === 0) { console.warn('⚠️ Sin contenido'); return; }
    stopPlayback0 = false;
    playbackLoop(localPlaylist, 'HDMI-A-2', () => stopPlayback0);
  }
}

function connectSocket() {
  console.log(`🔌 Conectando Socket.io a ${CMS_URL}...`);
  const socket = io(CMS_URL, { reconnection: true, reconnectionDelay: 5000, reconnectionAttempts: Infinity });
  socket.on('connect', () => console.log('✅ Socket.io conectado al CMS'));
  socket.on('disconnect', () => console.warn('⚠️ Socket.io desconectado, reconectando...'));
  socket.on(`device-config-update-${DEVICE_ID}`, async (newConfig) => {
    console.log(`\n⚡ Nueva configuración recibida!`);
    currentConfig = newConfig;
    saveConfigCache(newConfig);
    await startPlayer(newConfig);
  });
  return socket;
}

function startHeartbeat() {
  setInterval(async () => {
    try { await axios.get(`${CMS_URL}/api/devices/${DEVICE_ID}/config`, { timeout: 5000 }); }
    catch (err) { console.warn('⚠️ Heartbeat falló:', err.message); }
  }, 30000);
}

async function main() {
  console.log('\n🎬 SONORO AV Player v3.2 - Dual HDMI Ready');
  console.log(`📡 CMS: ${CMS_URL}`);
  console.log(`🖥️  Device: ${DEVICE_ID}`);
  console.log(`🎯 Modo: ${DISPLAY_MODE}`);
  console.log(`📁 Media: ${MEDIA_DIR}\n`);

  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  if (!fs.existsSync(PLAYER_DIR)) fs.mkdirSync(PLAYER_DIR, { recursive: true });

  await registerDevice();
  currentConfig = await getDeviceConfig();

  if (!currentConfig) {
    console.warn('⚠️ CMS no disponible. Buscando configuración local...');
    currentConfig = loadCachedConfig();
  }

  connectSocket();
  startHeartbeat();
  hideCursor();

  if (currentConfig) {
    console.log(`📋 Config: ${currentConfig.display_mode} | hdmi0: ${currentConfig.hdmi0_playlist_id} | hdmi1: ${currentConfig.hdmi1_playlist_id}`);
    await startPlayer(currentConfig);
  } else {
    console.warn('⏳ Sin configuración disponible. Esperando evento del CMS...');
  }
}

process.on('SIGTERM', () => { killPlayers(); process.exit(0); });
process.on('SIGINT', () => { killPlayers(); process.exit(0); });

main().catch(console.error);