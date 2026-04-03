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

const CMS_URL        = process.env.CMS_URL   || 'https://cms.sonoro.com.co';
const DEVICE_ID      = process.env.DEVICE_ID || 'rpi4-sonoro-01';
const RECONNECT_MODE = process.env.RECONNECT_MODE === 'true';
const HOTSPOT_IP = '192.168.4.1';
const PORT       = 8080;
const _devSuffix = DEVICE_ID.replace(/^rpi4-/,'').replace(/[^a-zA-Z0-9]/g,'-').toUpperCase().slice(-6);
const HOTSPOT_NAME = `SCMS-${_devSuffix}`;

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
    await run(`sudo nmcli con modify "${HOTSPOT_NAME}" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "sonorocms"`);
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

async function applyStaticIP(ip, netmask, gateway, dns) {
  log(`Configurando IP estatica: ${ip}`);
  const prefix = netmaskToPrefix(netmask || '255.255.255.0');
  const dnsVal = dns || '8.8.8.8';
  try {
    await run(`sudo nmcli con mod "$(sudo nmcli -t -f NAME con show --active | head -1)" ipv4.method manual ipv4.addresses "${ip}/${prefix}" ipv4.gateway "${gateway}" ipv4.dns "${dnsVal}"`);
    log(`IP estatica configurada: ${ip}/${prefix}`);
  } catch(e) {
    // Si falla con la conexion activa, configurar en dhcpcd.conf
    const conf = `\ninterface wlan0\nstatic ip_address=${ip}/${prefix}\nstatic routers=${gateway}\nstatic domain_name_servers=${dnsVal}\n`;
    require('fs').appendFileSync('/etc/dhcpcd.conf', conf);
    log('IP estatica configurada via dhcpcd.conf');
  }
}

function netmaskToPrefix(netmask) {
  try {
    return netmask.split('.').reduce((acc, octet) => {
      return acc + parseInt(octet).toString(2).split('').filter(b => b === '1').length;
    }, 0);
  } catch(e) { return 24; }
}

async function applyProxy(proxy) {
  log(`Configurando proxy: ${proxy}`);
  const envLine = `\nhttp_proxy="${proxy}"\nhttps_proxy="${proxy}"\nno_proxy="localhost,127.0.0.1"\n`;
  require('fs').appendFileSync('/etc/environment', envLine);
  // Configurar para el player
  const playerEnv = `/home/sonoro/sonoro-player/.env`;
  const envContent = require('fs').readFileSync(playerEnv, 'utf8');
  if (!envContent.includes('HTTPS_PROXY')) {
    require('fs').appendFileSync(playerEnv, `\nHTTPS_PROXY=${proxy}\nHTTP_PROXY=${proxy}\n`);
  }
  log('Proxy configurado');
}

async function connectToWifi(ssid, password) {
  log(`Conectando a WiFi: ${ssid}`);
  try {
    // Detener hotspot primero
    await stopHotspot();
    await new Promise(r => setTimeout(r, 2000));
    
    // Intentar conectar
    try { await run('sudo nmcli dev wifi rescan ifname wlan0 2>/dev/null'); } catch(e) {}
    await new Promise(r => setTimeout(r, 2000));
    // Verificar si ya esta conectado a esta red
    const currentSSID = await run("nmcli -t -f active,ssid dev wifi | grep '^yes' | cut -d: -f2").catch(() => '');
    if (currentSSID.trim() === ssid) {
      log(`Ya conectado a ${ssid} — continuando`);
      return true;
    }
    // Eliminar perfil anterior si existe
    try { await run(`sudo nmcli con delete "${ssid}" 2>/dev/null`); } catch(e) {}
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
function getLocalIP() {
  try {
    const out = require('child_process').execSync(
      "ip route get 1 2>/dev/null | awk '{print $7; exit}'"
    ).toString().trim();
    return out || HOTSPOT_IP;
  } catch(e) { return HOTSPOT_IP; }
}

function showQRonTV(url) {
  const QR_PATH = '/tmp/sonoro-qr.png';
  const WAYLAND = 'WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000';
  exec('pkill -f mpv || true', () => {
    setTimeout(() => {
      exec('qrencode -o ' + QR_PATH + ' -s 12 -m 3 "' + url + '" 2>/dev/null', (err) => {
        if (err) { console.error('[Portal] Error generando QR:', err.message); return; }
        const cmd = WAYLAND + ' mpv --fullscreen --no-audio --loop=inf '
          + '--osd-msg1="Escanea el QR o visita: ' + url + '" '
          + '--osd-font-size=40 --osd-duration=999999 ' + QR_PATH;
        exec(cmd, { windowsHide: false });
        console.log('[Portal] QR mostrado en TV: ' + url);
      });
    }, 1000);
  });
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
           background: #0f0f0f; color: #f0f0f0; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #1a1a1a; border-radius: 16px; padding: 32px 28px;
            max-width: 420px; width: 100%; border: 1px solid #2a2a2a; }
    .logo { text-align: center; margin-bottom: 24px; }
    .logo span { font-size: 28px; font-weight: 900; background: linear-gradient(135deg, #FF1B8D, #FF6B35);
                 -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .logo p { font-size: 13px; color: #888; margin-top: 4px; }
    h2 { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
    p.sub { font-size: 13px; color: #888; margin-bottom: 24px; line-height: 1.6; }
    label { display: block; font-size: 12px; font-weight: 600; color: #888;
            text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    select, input { width: 100%; padding: 12px 14px; background: #111;
                    border: 1px solid #333; border-radius: 10px; color: #f0f0f0;
                    font-size: 14px; margin-bottom: 16px; }
    select:focus, input:focus { outline: none; border-color: #FF1B8D; }
    button { width: 100%; padding: 14px; background: linear-gradient(135deg, #FF1B8D, #FF6B35);
             border: none; border-radius: 10px; color: white; font-size: 15px;
             font-weight: 700; cursor: pointer; letter-spacing: 0.5px; }
    button:active { opacity: 0.9; }
    .msg { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
    .msg.ok  { background: #0a2e14; color: #4ade80; border: 1px solid #166534; }
    .msg.err { background: #2e0a0a; color: #f87171; border: 1px solid #991b1b; }
    .msg.inf { background: #0a1a2e; color: #60a5fa; border: 1px solid #1e3a5f; }
    .steps { display: flex; gap: 8px; margin-bottom: 24px; }
    .step { flex: 1; height: 4px; border-radius: 2px; background: #333; }
    .step.active { background: #FF1B8D; }
    .step.done { background: #4ade80; }
    .device-id { text-align: center; font-size: 11px; color: #555; margin-top: 20px; }
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
        <details style="margin-bottom:16px;">
          <summary style="font-size:12px;color:#999;cursor:pointer;padding:8px 0;">
            Configuracion de red avanzada (IP estatica / Proxy)
          </summary>
          <div style="margin-top:12px;padding:12px;background:#f8f8f8;border-radius:8px;border:1px solid #e8e8e8;">
            <p style="font-size:11px;color:#999;margin-bottom:12px;">Solo para redes corporativas. Dejar vacio para usar DHCP automatico.</p>
            <label>Direccion IP estatica</label>
            <input type="text" name="static_ip" placeholder="Ej: 192.168.1.100">
            <label>Mascara de subred</label>
            <input type="text" name="netmask" placeholder="Ej: 255.255.255.0">
            <label>Gateway (puerta de enlace)</label>
            <input type="text" name="gateway" placeholder="Ej: 192.168.1.1">
            <label>DNS primario</label>
            <input type="text" name="dns" placeholder="Ej: 8.8.8.8">
            <label>Proxy HTTP (opcional)</label>
            <input type="text" name="proxy" placeholder="Ej: http://proxy.empresa.com:8080">
          </div>
        </details>
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
      const freshNetworks = await getWifiNetworks();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getPortalHTML(freshNetworks, 0, '', ''));
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

        // Aplicar configuracion de red avanzada si se proporcionó
        const staticIP  = params.get('static_ip')?.trim();
        const netmask   = params.get('netmask')?.trim();
        const gateway   = params.get('gateway')?.trim();
        const dns       = params.get('dns')?.trim();
        const proxy     = params.get('proxy')?.trim();

        if (staticIP && gateway) {
          await applyStaticIP(staticIP, netmask, gateway, dns).catch(e => log('Static IP error: ' + e.message));
        }
        if (proxy) {
          await applyProxy(proxy).catch(e => log('Proxy error: ' + e.message));
        }

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
    if (!RECONNECT_MODE) {
      if (hotspotActive) {
        showQRonTV(`http://${HOTSPOT_IP}:${PORT}`);
      } else {
        const localIP = getLocalIP();
        if (localIP) showQRonTV(`http://${localIP}:${PORT}`);
      }
    } else {
      log('Modo reconexion — sin QR en pantalla');
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
  log(`Iniciando portal — DEVICE_ID: ${DEVICE_ID} — Modo: ${RECONNECT_MODE ? 'RECONEXION' : 'ACTIVACION'}`);

  const internet = await hasInternet();
  log(`Internet disponible: ${internet}`);

  if (!internet) {
    log('Sin internet — creando hotspot WiFi');
    const ok = await startHotspot();
    if (!ok) {
      log('No se pudo crear hotspot — iniciando servidor en todas las interfaces');
    }
    await new Promise(r => setTimeout(r, 3000));
    // En modo reconexion NO mostrar QR en TV — hotspot silencioso
    if (!RECONNECT_MODE) {
      const localIP = getLocalIP() || HOTSPOT_IP;
      showQRonTV(`http://${localIP}:${PORT}`);
    } else {
      log('Modo reconexion — hotspot silencioso activo: ' + HOTSPOT_NAME + ' / sonorocms');
    }
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
