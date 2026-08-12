#!/usr/bin/env node
// player-rpi5.js — SONORO CMS player para RPi5 (signage puro, sin overlays).
//
// Lee la playlist ya sincronizada por sync-app.js desde:
//   /home/sonoro/media/last_config.json  (id de la playlist activa)
//   /home/sonoro/media/playlist_<id>/playlist.json  (items con local_path)
//
// Reproduce items en modo secuencial: un proceso ffmpeg por item.
// Cuando ffmpeg termina (natural o por -t), avanza al siguiente item
// y lo spawna inmediatamente — evita el problema de reinit del filter
// graph (auto_scale_0) que ocurre con concat demuxer + V4L2 hwaccel.
//
// killFfmpeg(cb): espera el exit real antes de llamar cb — evita que dos
// procesos corran simultáneamente y compitan por el DRM master (EPERM).

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MEDIA_DIR = '/home/sonoro/media';
const POLL_MS   = 5000;
const FFMPEG    = process.env.FFMPEG_BIN || '/usr/bin/ffmpeg';

let currentSignature = null;
let playableItems    = [];
let currentIdx       = 0;
let ffmpegProc       = null;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function readLastConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, 'last_config.json'), 'utf8'));
  } catch { return null; }
}

function readPlaylist(id) {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(MEDIA_DIR, `playlist_${id}`, 'playlist.json'), 'utf8'));
  } catch { return null; }
}

function isPlayable(item) {
  return item.local_path && item.local_path.endsWith('.mp4') && fs.existsSync(item.local_path);
}

function playlistSignature(items) {
  return items.filter(isPlayable).map(i => `${i.local_path}:${i.duration_ms || 0}`).join('|');
}

function killFfmpeg(cb) {
  if (!ffmpegProc) { if (cb) cb(); return; }
  const proc = ffmpegProc;
  ffmpegProc = null;
  proc.once('exit', () => { if (cb) cb(); });
  try { proc.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
}

function playItem(item) {
  if (!playableItems.length) return;
  const durSec = item.duration_ms ? (item.duration_ms / 1000).toFixed(3) : null;
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-hwaccel', 'drm', '-hwaccel_output_format', 'drm_prime',
    '-c:v', 'hevc', '-re',
    '-fflags', '+genpts',
    ...(durSec ? ['-t', durSec] : []),
    '-i', item.local_path,
    '-map', '0:v:0', '-an', '-f', 'vout_drm', '-'
  ];
  log(`ffmpeg → ${path.basename(item.local_path)} (${durSec || 'full'}s)`);
  ffmpegProc = spawn(FFMPEG, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  ffmpegProc.on('exit', (code, sig) => {
    log(`ffmpeg exited code=${code} sig=${sig}`);
    ffmpegProc = null;
    advanceItem();
  });
  ffmpegProc.on('error', err => {
    log(`ffmpeg error: ${err.message}`);
    ffmpegProc = null;
    setTimeout(advanceItem, 1000);
  });
}

function advanceItem() {
  if (!playableItems.length) return;
  currentIdx = (currentIdx + 1) % playableItems.length;
  playItem(playableItems[currentIdx]);
}

function tick() {
  const config = readLastConfig();
  const playlistId = config?.hdmi0_playlist_id || config?.hdmi1_playlist_id;

  if (!playlistId) {
    if (ffmpegProc) { log('Sin playlist activa → detengo ffmpeg'); killFfmpeg(); }
    playableItems = []; currentSignature = null;
    return;
  }

  const playlist = readPlaylist(playlistId);
  if (!playlist?.items?.length) {
    if (ffmpegProc) { log(`Playlist ${playlistId} vacía → detengo ffmpeg`); killFfmpeg(); }
    playableItems = []; currentSignature = null;
    return;
  }

  const items = playlist.items.filter(isPlayable);
  const sig   = playlistSignature(playlist.items);

  if (!sig) {
    if (ffmpegProc) { log('Sin items con local_path válido → detengo ffmpeg'); killFfmpeg(); }
    playableItems = []; currentSignature = null;
    return;
  }

  if (sig === currentSignature && ffmpegProc) return;

  log(`Cambio detectado (playlist=${playlistId}, items=${items.length}) → restart secuencial`);
  currentSignature = sig;
  playableItems    = items;
  currentIdx       = 0;
  killFfmpeg(() => setTimeout(() => playItem(playableItems[0]), 300));
}

process.on('SIGTERM', () => { log('recibido SIGTERM, saliendo'); killFfmpeg(); process.exit(0); });
process.on('SIGINT',  () => { log('recibido SIGINT, saliendo');  killFfmpeg(); process.exit(0); });

log(`player-rpi5 start | media=${MEDIA_DIR} ffmpeg=${FFMPEG} poll=${POLL_MS}ms`);
tick();
setInterval(tick, POLL_MS);
