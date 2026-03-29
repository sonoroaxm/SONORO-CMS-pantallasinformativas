#!/usr/bin/env node
// ============================================================
// SONORO AV — Portal de Activacion WiFi
// Crea hotspot, sirve pagina de configuracion, activa el RPi
// ============================================================
'use strict';

const http    = require('http');
const fs      = require('fs');
const { exec, execSync } = require('child_process');
const path    = require('path');

const CMS_URL   = process.env.CMS_URL   || 'https://cms.sonoro.com.co';
const DEVICE_ID = process.env.DEVICE_ID || 'rpi4-sonoro-01';
const HOTSPOT_IP = '192.168.4.1';
const PORT       = 8080;
const HOTSPOT_NAME = `SONORO-${DEVICE_ID.replace('rpi4-','').toUpperCase().substring(0,6)}`;

let hotspotActive = false;
let server = null;

// ── UTILIDADES ───────────────────────────────────────────────
function log(msg) { console.log(`[Portal] ${msg}`); }

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function hasInternet() {
  try {
    await run('curl -s --connect-timeout 5 https://cms.sonoro.com.co/api/health');
    return true;
  } catch(e) { return false; }
}

async function getWifiNetworks() {
  try {
    const out = await run("sudo nmcli -t -f SSID,SIGNAL,SECURITY dev wifi list 2>/dev/null | grep -v '^:' | sort -t: -k2 -rn");
    const networks = [];
    const seen = new Set();
    for (const line of out.split('\n')) {
      const parts = line.split(':');
      const ssid = parts[0]?.trim();
      const signal = parseInt(parts[1]) || 0;
      const security = parts[2]?.trim() || '';
      if (ssid && !seen.has(ssid) && ssid !== HOTSPOT_NAME) {
        seen.add(ssid);
        networks.push({ ssid, signal, security });
      }
    }
    return networks.slice(0, 15);
  } catch(e) { return []; }
}

// ── HOTSPOT ──────────────────────────────────────────────────
async function startHotspot() {
  log(`Creando hotspot: ${HOTSPOT_NAME}`);
  try {
    // Verificar si ya existe el hotspot
    try { await run(`sudo nmcli con delete "${HOTSPOT_NAME}" 2>/dev/null`); } catch(e) {}
    
    // Crear hotspot con nmcli
    await run(`sudo nmcli con add type wifi ifname wlan0 con-name "${HOTSPOT_NAME}" autoconnect no ssid "${HOTSPOT_NAME}"`);
    await run(`sudo nmcli con modify "${HOTSPOT_NAME}" 802-11-wireless.mode ap 802-11-wireless.band bg ipv4.method shared`);
    await run(`sudo nmcli con modify "${HOTSPOT_NAME}" ipv4.addresses ${HOTSPOT_IP}/24`);
    await run(`sudo nmcli con up "${HOTSPOT_NAME}"`);
    hotspotActive = true;
    log(`Hotspot activo: ${HOTSPOT_NAME} en ${HOTSPOT_IP}`);
    return true;
  } catch(e) {
    log(`Error creando hotspot: ${e.message}`);
    return false;
  }
}

async function stopHotspot() {
  if (!hotspotActive) return;
  try {
    await run(`sudo nmcli con down "${HOTSPOT_NAME}" 2>/dev/null`);
    await run(`sudo nmcli con delete "${HOTSPOT_NAME}" 2>/dev/null`);
    hotspotActive = false;
    log('Hotspot detenido');
  } catch(e) {}
}

async function connectToWifi(ssid, password) {
  log(`Conectando a WiFi: ${ssid}`);
  try {
    // Detener hotspot primero
    await stopHotspot();
    await new Promise(r => setTimeout(r, 2000));
    
    // Intentar conectar
    if (password) {
      await run(`sudo nmcli dev wifi connect "${ssid}" password "${password}" ifname wlan0`);
    } else {
      await run(`sudo nmcli dev wifi connect "${ssid}" ifname wlan0`);
    }
    
    // Esperar conexion
    await new Promise(r => setTimeout(r, 5000));
    const connected = await hasInternet();
    if (connected) {
      log(`Conectado a ${ssid} con internet`);
      return true;
    }
    log(`Conectado a ${ssid} pero sin internet`);
    return false;
  } catch(e) {
    log(`Error conectando a ${ssid}: ${e.message}`);
    return false;
  }
}

async function activateDevice(code) {
  log(`Activando dispositivo con codigo: ${code}`);
  const https = require('https');
  const http2 = require('http');
  const url = new URL(`${CMS_URL}/api/activate`);
  const body = JSON.stringify({ code, device_id: DEVICE_ID });
  
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http2;
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Respuesta invalida del servidor')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── QR EN TV ─────────────────────────────────────────────────
function showQRonTV(url) {
  try {
    // Generar QR como texto en la consola
    exec(`qrencode -t UTF8 "${url}" 2>/dev/null`, (err, stdout) => {
      if (!err) {
        console.log('\n\n');
        console.log('  ╔══════════════════════════════════════╗');
        console.log('  ║        CONFIGURAR REPRODUCTOR        ║');
        console.log('  ║                                      ║');
        console.log(`  ║  Red WiFi: ${HOTSPOT_NAME.padEnd(26)}║`);
        console.log(`  ║  O visita: ${url.padEnd(26)}║`);
        console.log('  ║                                      ║');
        console.log('  ║  Escanea el QR desde tu celular:     ║');
        console.log('  ╚══════════════════════════════════════╝');
        console.log('');
        console.log(stdout);
      }
    });
  } catch(e) {}
}

// ── HTML DEL PORTAL ──────────────────────────────────────────
function getPortalHTML(networks, step, message, error) {
  const networkOptions = networks.map(n =>
    `<option value="${n.ssid}">${n.ssid} (${n.signal}%)</option>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Configurar SONORO</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f5f5f5; color: #1a1a1a; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #ffffff; border-radius: 20px; padding: 36px 32px;
            max-width: 420px; width: 100%; border: 1px solid #e8e8e8;
            box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .logo { text-align: center; margin-bottom: 24px; }
    .logo span { font-size: 28px; font-weight: 900; background: linear-gradient(135deg, #FF1B8D, #FF6B35);
                 -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .logo p { font-size: 13px; color: #999; margin-top: 4px; }
    h2 { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
    p.sub { font-size: 13px; color: #666; margin-bottom: 24px; line-height: 1.6; }
    label { display: block; font-size: 11px; font-weight: 700; color: #999;
            text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    select, input { width: 100%; padding: 12px 14px; background: #f8f8f8;
                    border: 1.5px solid #e8e8e8; border-radius: 10px; color: #1a1a1a;
                    font-size: 14px; margin-bottom: 16px; }
    select:focus, input:focus { outline: none; border-color: #FF1B8D; background: #fff; }
    button { width: 100%; padding: 14px; background: linear-gradient(135deg, #FF1B8D, #FF6B35);
             border: none; border-radius: 10px; color: white; font-size: 15px;
             font-weight: 700; cursor: pointer; letter-spacing: 0.5px; }
    button:active { opacity: 0.9; }
    .msg { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
    .msg.ok  { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
    .msg.err { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .msg.inf { background: #0a1a2e; color: #60a5fa; border: 1px solid #1e3a5f; }
    .steps { display: flex; gap: 8px; margin-bottom: 24px; }
    .step { flex: 1; height: 4px; border-radius: 2px; background: #e8e8e8; }
    .step.active { background: #FF1B8D; }
    .step.done { background: #4ade80; }
    .device-id { text-align: center; font-size: 11px; color: #bbb; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <span>SONORO.</span>
      <p>Configuracion del reproductor</p>
    </div>
    <div class="steps">
      <div class="step ${step >= 1 ? 'done' : ''} ${step === 0 ? 'active' : ''}"></div>
      <div class="step ${step >= 2 ? 'done' : ''} ${step === 1 ? 'active' : ''}"></div>
      <div class="step ${step === 2 ? 'active' : ''}"></div>
    </div>

    ${error ? `<div class="msg err">${error}</div>` : ''}
    ${message ? `<div class="msg ok">${message}</div>` : ''}

    ${step === 0 ? `
      <h2>Conectar a WiFi</h2>
      <p class="sub">Selecciona la red WiFi donde quedara conectado el reproductor.</p>
      <form method="POST" action="/wifi">
        <label>Red WiFi</label>
        <select name="ssid" required>
          <option value="">-- Seleccionar red --</option>
          ${networkOptions}
          <option value="__manual__">Escribir nombre manualmente</option>
        </select>
        <label>Contrasena WiFi</label>
        <input type="password" name="password" placeholder="Dejar vacio si es red abierta">
        <button type="submit">Conectar</button>
      </form>
    ` : ''}

    ${step === 1 ? `
      <h2>Activar dispositivo</h2>
      <p class="sub">Ingresa el codigo de activacion que generaste en cms.sonoro.com.co</p>
      <form method="POST" action="/activate">
        <label>Codigo de activacion</label>
        <input type="text" name="code" placeholder="SNR-XXXX-XXXX" 
               style="text-transform:uppercase;letter-spacing:2px;font-size:18px;font-weight:700;text-align:center;"
               required autocomplete="off" autocorrect="off" autocapitalize="characters">
        <button type="submit">Activar</button>
      </form>
    ` : ''}

    ${step === 2 ? `
      <div class="msg ok" style="text-align:center;padding:24px;">
        <div style="font-size:32px;margin-bottom:12px;">&#10003;</div>
        <div style="font-size:16px;font-weight:700;margin-bottom:8px;">Reproductor activado</div>
        <div style="font-size:13px;opacity:0.8;">El contenido se descargara en unos segundos y comenzara a reproducirse automaticamente.</div>
      </div>
    ` : ''}

    <div class="device-id">ID: ${DEVICE_ID}</div>
  </div>
  ${step === 0 ? `
  <script>
    document.querySelector('select[name=ssid]').addEventListener('change', function() {
      if (this.value === '__manual__') {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.name = 'ssid'; inp.placeholder = 'Nombre exacto de la red';
        inp.style.cssText = this.style.cssText;
        this.parentNode.replaceChild(inp, this);
        inp.focus();
      }
    });
  </script>` : ''}
</body>
</html>`;
}

// ── SERVIDOR HTTP ─────────────────────────────────────────────
async function startServer() {
  const networks = await getWifiNetworks();
  log(`Redes WiFi encontradas: ${networks.length}`);

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    log(`${req.method} ${url.pathname}`);

    // Redirect captive portal (Android/iOS auto-detect)
    if (req.method === 'GET' && !['/', '/wifi', '/activate', '/status'].includes(url.pathname)) {
      res.writeHead(302, { Location: `http://${HOTSPOT_IP}:${PORT}/` });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const internet = await hasInternet();
      if (internet) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getPortalHTML([], 1, '', ''));
      } else {
        const freshNetworks = await getWifiNetworks();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getPortalHTML(freshNetworks, 0, '', ''));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ device_id: DEVICE_ID, hotspot: HOTSPOT_NAME, ready: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/wifi') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const ssid = params.get('ssid')?.trim();
        const password = params.get('password')?.trim() || '';

        if (!ssid || ssid === '__manual__') {
          const nets = await getWifiNetworks();
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(getPortalHTML(nets, 0, '', 'Por favor selecciona o escribe el nombre de la red'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <style>body{font-family:sans-serif;background:#0f0f0f;color:#f0f0f0;display:flex;align-items:center;
          justify-content:center;height:100vh;text-align:center;}
          .spinner{width:40px;height:40px;border:3px solid #333;border-top:3px solid #FF1B8D;
          border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px;}
          @keyframes spin{to{transform:rotate(360deg);}}</style></head>
          <body><div><div class="spinner"></div>
          <p>Conectando a <b>${ssid}</b>...</p>
          <p style="font-size:12px;color:#666;margin-top:8px;">Esto puede tardar hasta 15 segundos</p>
          </div><script>setTimeout(()=>location.href='/activate-form',12000)</script></body></html>`);

        // Conectar en background
        setTimeout(async () => {
          const ok = await connectToWifi(ssid, password);
          // Reiniciar servidor en nueva IP si conecta
          if (ok && server) {
            server.close();
            await new Promise(r => setTimeout(r, 3000));
            startServerOnNewIP();
          }
        }, 500);
      });
      return;
    }

    if ((req.method === 'GET' && url.pathname === '/activate-form') ||
        (req.method === 'GET' && url.pathname === '/activate')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getPortalHTML([], 1, '', ''));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/activate') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const code = params.get('code')?.trim().toUpperCase();

        if (!code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(getPortalHTML([], 1, '', 'Ingresa el codigo de activacion'));
          return;
        }

        try {
          const result = await activateDevice(code);
          if (result.success) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getPortalHTML([], 2, 'Dispositivo activado correctamente', ''));
            log('Activacion exitosa — cerrando portal en 5s');
            setTimeout(() => {
              if (server) server.close();
              process.exit(0);
            }, 5000);
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getPortalHTML([], 1, '', result.error || 'Codigo invalido o expirado'));
          }
        } catch(e) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(getPortalHTML([], 1, '', 'Error conectando al servidor. Verifica que el WiFi tiene internet.'));
        }
      });
      return;
    }

    res.writeHead(302, { Location: '/' });
    res.end();
  });

  const listenIP = hotspotActive ? HOTSPOT_IP : '0.0.0.0';
  server.listen(PORT, listenIP, () => {
    log(`Servidor portal en http://${listenIP}:${PORT}`);
    if (hotspotActive) {
      showQRonTV(`http://${HOTSPOT_IP}:${PORT}`);
    }
  });
}

async function startServerOnNewIP() {
  server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getPortalHTML([], 1, 'WiFi conectado. Ahora ingresa tu codigo de activacion.', ''));
      return;
    }
    if (req.method === 'POST' && req.url === '/activate') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const code = params.get('code')?.trim().toUpperCase();
        try {
          const result = await activateDevice(code);
          if (result.success) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getPortalHTML([], 2, '', ''));
            setTimeout(() => { if(server) server.close(); process.exit(0); }, 5000);
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getPortalHTML([], 1, '', result.error || 'Codigo invalido'));
          }
        } catch(e) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(getPortalHTML([], 1, '', 'Error: ' + e.message));
        }
      });
      return;
    }
    res.writeHead(302, { Location: '/' });
    res.end();
  });
  server.listen(PORT, '0.0.0.0', () => log(`Servidor en nueva IP, puerto ${PORT}`));
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  log(`Iniciando portal — DEVICE_ID: ${DEVICE_ID}`);

  const internet = await hasInternet();
  log(`Internet disponible: ${internet}`);

  if (!internet) {
    log('Sin internet — creando hotspot WiFi');
    const ok = await startHotspot();
    if (!ok) {
      log('No se pudo crear hotspot — iniciando servidor en todas las interfaces');
    }
    await new Promise(r => setTimeout(r, 3000));
  } else {
    log('Internet disponible — saltando directo al paso de activacion');
  }

  await startServer();
}

// Limpiar al salir
process.on('SIGINT', async () => { await stopHotspot(); process.exit(0); });
process.on('SIGTERM', async () => { await stopHotspot(); process.exit(0); });
process.on('exit', () => { try { execSync(`sudo nmcli con down "${HOTSPOT_NAME}" 2>/dev/null`); } catch(e) {} });

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
