#!/usr/bin/env node
// player-rpi5.js — SONORO CMS player para RPi5 (signage puro, sin overlays).
//
// Lee la playlist ya sincronizada por sync-app.js desde:
//   /home/sonoro/media/last_config.json  (id de la playlist activa)
//   /home/sonoro/media/playlist_<id>/playlist.json  (items con local_path)
//
// Arma /tmp/sonoro-concat.txt y lanza un único proceso ffmpeg con:
//   - hwaccel drm + drm_prime  (HW decoder HEVC del RPi5)
//   - concat demuxer + -stream_loop -1  (gap 0ms entre clips)
//   - vout_drm  (render directo a DRM, sin X11)
//
// F3: buildConcatFile usa directiva 'duration' por item — el player controla
//     la duración de cada pieza independientemente del archivo HEVC.
//
// killFfmpeg(cb): espera el exit real antes de llamar cb — evita que dos
// procesos corran simultáneamente y compitan por el DRM master (EPERM).

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MEDIA_DIR   = '/home/sonoro/media';
const CONCAT_FILE = '/tmp/sonoro-concat.txt';
const POLL_MS     = 5000;
const FFMPEG      = process.env.FFMPEG_BIN || '/usr/bin/ffmpeg';

let currentPlaylistId = null;
let currentSignature  = null;
let ffmpegProc        = null;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function readLastConfig() {
  try {
    const raw = fs.readFileSync(path.join(MEDIA_DIR, 'last_config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readPlaylist(playlistId) {
  try {
    const raw = fs.readFileSync(
      path.join(MEDIA_DIR, `playlist_${playlistId}`, 'playlist.json'),
      'utf8'
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPlayable(item) {
  if (!item.local_path) return false;
  if (!item.local_path.endsWith('.mp4')) return false;
  if (!fs.existsSync(item.local_path)) return false;
  return true;
}

// F3: escribe directiva 'duration' por item para que ffmpeg concat
// respete el duration_ms del playlist, no la duración del archivo HEVC.
function buildConcatFile(items) {
  const lines = [];
  for (const item of items) {
    if (!isPlayable(item)) continue;
    const safe = item.local_path.replace(/'/g, "'\''");
    lines.push(`file '${safe}'`);
    if (item.duration_ms) {
      const durSec = (item.duration_ms / 1000).toFixed(3);
      lines.push(`duration ${durSec}`);
    }
  }
  return lines.join('\n') + '\n';
}

// La firma incluye duration_ms para detectar cambios de duración en playlist.
function playlistSignature(items) {
  return items
    .filter(i => isPlayable(i))
    .map(i => `${i.local_path}:${i.duration_ms || 0}`)
    .join('|');
}

function killFfmpeg(cb) {
  if (!ffmpegProc) { if (cb) cb(); return; }
  const proc = ffmpegProc;
  ffmpegProc = null;
  proc.once('exit', () => { if (cb) cb(); });
  try { proc.kill('SIGTERM'); } catch {}
  // SIGKILL fallback si ffmpeg no responde al SIGTERM en 5s
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
}

function launchFfmpeg() {
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-hwaccel', 'drm', '-hwaccel_output_format', 'drm_prime',
    '-c:v', 'hevc',
    '-re',
    '-f', 'concat', '-safe', '0', '-stream_loop', '-1',
    '-i', CONCAT_FILE,
    '-an', '-f', 'vout_drm', '-'
  ];
  log(`ffmpeg spawn: ${args.slice(0, 12).join(' ')} ...`);
  ffmpegProc = spawn(FFMPEG, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  ffmpegProc.on('exit', (code, sig) => {
    log(`ffmpeg exited code=${code} sig=${sig}`);
    ffmpegProc = null;
    currentSignature = null;
  });
  ffmpegProc.on('error', err => {
    log(`ffmpeg error: ${err.message}`);
    ffmpegProc = null;
    currentSignature = null;
  });
}

function tick() {
  const config = readLastConfig();
  const playlistId = config?.hdmi0_playlist_id || config?.hdmi1_playlist_id;

  if (!playlistId) {
    if (ffmpegProc) { log('Sin playlist activa → detengo ffmpeg'); killFfmpeg(); }
    return;
  }

  const playlist = readPlaylist(playlistId);
  if (!playlist || !playlist.items || !playlist.items.length) {
    if (ffmpegProc) { log(`Playlist ${playlistId} vacía → detengo ffmpeg`); killFfmpeg(); }
    return;
  }

  const sig = playlistSignature(playlist.items);
  if (!sig) {
    if (ffmpegProc) { log('Sin videos con local_path válido → detengo ffmpeg'); killFfmpeg(); }
    return;
  }

  if (sig === currentSignature && ffmpegProc) return;

  log(`Cambio detectado (playlist=${playlistId}, items=${sig.split('|').length}) → rebuild concat + respawn`);
  fs.writeFileSync(CONCAT_FILE, buildConcatFile(playlist.items), 'utf8');
  currentPlaylistId = playlistId;
  currentSignature  = sig;
  killFfmpeg(() => setTimeout(launchFfmpeg, 300));
}

function shutdown(sig) {
  log(`recibido ${sig}, saliendo`);
  killFfmpeg();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

log(`player-rpi5 start | media=${MEDIA_DIR} ffmpeg=${FFMPEG} poll=${POLL_MS}ms`);
tick();
setInterval(tick, POLL_MS);
