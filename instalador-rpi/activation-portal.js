/**
 * ============================================================
 * SONORO AV — Portal de Activación v2
 * /home/sonoro/sonoro-player/activation-portal.js
 * ============================================================
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const { exec, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const app      = express();
const CMS_URL  = process.env.CMS_URL || 'https://cms.sonoro.com.co';
const PORT     = 8080;
const ENV_FILE = path.join(__dirname, '.env');
const AP_CONFIG_FILE = path.join(__dirname, 'ap-config.json');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

function getDeviceId() {
  try {
    const env = fs.readFileSync(ENV_FILE, 'utf8');
    const match = env.match(/DEVICE_ID=(.+)/);
    return match ? match[1].trim() : 'rpi-unknown';
  } catch(e) { return 'rpi-unknown'; }
}

function getAPConfig() {
  try { return JSON.parse(fs.readFileSync(AP_CONFIG_FILE, 'utf8')); }
  catch(e) { return { ap_ssid: 'SONORO-Setup', ap_ip: '192.168.99.1', portal_port: 8080 }; }
}

function isAPMode() {
  const ip = getLocalIP();
  const apConfig = getAPConfig();
  return ip === apConfig.ap_ip;
}

function scanWifi() {
  return new Promise((resolve) => {
    exec('nmcli -t -f SSID,SIGNAL dev wifi list 2>/dev/null', (err, stdout) => {
      if (err) { resolve([]); return; }
      const networks = stdout.split('\n')
        .filter(l => l.trim())
        .map(l => { const p = l.split(':'); return { ssid: p[0], signal: parseInt(p[1]) || 0 }; })
        .filter(n => n.ssid && n.ssid !== '--')
        .sort((a, b) => b.signal - a.signal)
        .slice(0, 10);
      resolve(networks);
    });
  });
}

function showActivationScreen(ip, deviceId, mode) {
  const url = `http://${ip}:${PORT}`;
  const isAP = mode === 'ap';
  const py = `
import subprocess, sys
try:
    from PIL import Image, ImageDraw, ImageFont
    import qrcode
except:
    subprocess.run(['pip3','install','pillow','qrcode','--quiet','--break-system-packages'],capture_output=True)
    from PIL import Image, ImageDraw, ImageFont
    import qrcode

img = Image.new('RGB',(1920,1080),color=(15,15,15))
draw = ImageDraw.Draw(img)
try:
    fL = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',72)
    fB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',40)
    fS = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',28)
except:
    fL=fB=fS=ImageFont.load_default()

draw.text((960,90),'SONORO.',font=fL,fill=(255,27,141),anchor='mm')
draw.text((960,165),'CMS · Pantallas Informativas',font=fS,fill=(100,100,100),anchor='mm')

qr=qrcode.QRCode(version=2,box_size=7,border=2)
qr.add_data('${url}')
qr.make(fit=True)
qi=qr.make_image(fill_color='white',back_color=(15,15,15))
qs=qi.size[0]
img.paste(qi,((1920-qs)//2,240))

draw.text((960,240+qs+36),'${url}',font=fB,fill=(240,240,240),anchor='mm')
${isAP
  ? "draw.text((960,240+qs+90),'1. Conecta tu celular al WiFi: SONORO-Setup',font=fS,fill=(255,140,0),anchor='mm')\ndraw.text((960,240+qs+128),'2. Abre el navegador y entra a la direccion de arriba',font=fS,fill=(136,136,136),anchor='mm')"
  : "draw.text((960,240+qs+90),'Escanea el QR o abre esta direccion desde tu celular',font=fS,fill=(136,136,136),anchor='mm')\ndraw.text((960,240+qs+128),'(conectado a la misma red WiFi o cable)',font=fS,fill=(70,70,70),anchor='mm')"}
draw.text((960,1040),'ID: ${deviceId}',font=fS,fill=(50,50,50),anchor='mm')
img.save('/tmp/sonoro-activation.png')
`;
  try {
    execSync(`python3 -c "${py.replace(/"/g, '\\"')}"`, { timeout: 30000 });
    exec(`WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 mpv --vo=gpu --gpu-context=wayland --fullscreen --fs-screen-name=HDMI-A-2 --no-audio --no-osc --no-osd-bar --loop=inf --image-display-duration=inf /tmp/sonoro-activation.png`);
    console.log(`✅ Pantalla de activación mostrada (${mode})`);
  } catch(e) { console.warn('⚠️ No se pudo mostrar pantalla:', e.message); }
}

// ── PÁGINA PRINCIPAL ─────────────────────────────────────────
app.get('/', async (req, res) => {
  const ip       = getLocalIP();
  const deviceId = getDeviceId();
  const apMode   = isAPMode();
  let wifiNetworks = [];
  if (apMode) wifiNetworks = await scanWifi();

  const CSS = `
    *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f0f;color:#f0f0f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#161616;border:1px solid #2e2e2e;border-radius:20px;padding:36px 28px;width:100%;max-width:400px}
    .logo{font-size:34px;font-weight:900;letter-spacing:-1px;background:linear-gradient(135deg,#FF1B8D,#FF8C00,#FFE566);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:4px}
    .sub{font-size:11px;color:#555;letter-spacing:2px;text-transform:uppercase;margin-bottom:28px}
    .step{display:flex;align-items:flex-start;gap:14px;margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid #2e2e2e}
    .step:last-of-type{border-bottom:none;margin-bottom:0;padding-bottom:0}
    .step-num{width:32px;height:32px;border-radius:50%;flex-shrink:0;background:linear-gradient(135deg,#FF1B8D,#FF8C00);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:white}
    .step-num.done{background:#1a3a1a;color:#00e676;font-size:16px}
    .step-title{font-size:15px;font-weight:700;margin-bottom:6px}
    .step-desc{font-size:13px;color:#888;line-height:1.5}
    label{display:block;font-size:11px;font-weight:700;letter-spacing:1px;color:#666;text-transform:uppercase;margin-bottom:8px;margin-top:14px}
    input,select{width:100%;padding:13px 14px;background:#1e1e1e;border:1px solid #2e2e2e;border-radius:10px;color:#f0f0f0;font-size:15px;font-family:inherit;transition:border-color .2s}
    input:focus,select:focus{outline:none;border-color:#FF1B8D}
    .code-input{font-size:22px;font-weight:800;letter-spacing:4px;text-align:center;text-transform:uppercase}
    .code-input::placeholder{font-size:14px;font-weight:400;letter-spacing:1px;color:#444}
    select option{background:#1e1e1e}
    .btn{width:100%;padding:15px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);border:none;border-radius:10px;color:white;font-size:15px;font-weight:700;cursor:pointer;margin-top:18px;transition:opacity .2s;font-family:inherit}
    .btn:active{opacity:.8}
    .btn:disabled{opacity:.4;cursor:not-allowed}
    .msg{margin-top:14px;padding:13px 16px;border-radius:10px;font-size:13px;font-weight:600;text-align:center;line-height:1.5;display:none}
    .msg.ok{background:rgba(0,230,118,.1);color:#00e676;border:1px solid rgba(0,230,118,.25)}
    .msg.err{background:rgba(255,23,68,.1);color:#ff5252;border:1px solid rgba(255,23,68,.25)}
    .msg.info{background:rgba(255,140,0,.1);color:#FF8C00;border:1px solid rgba(255,140,0,.25)}
    .device-id{margin-top:24px;padding:10px 14px;background:#1a1a1a;border-radius:8px;font-size:11px;color:#444;text-align:center}
  `;

  const apSteps = `
    <div class="step">
      <div class="step-num done">✓</div>
      <div class="step-content">
        <div class="step-title">Conectado a SONORO-Setup</div>
        <div class="step-desc">Tu celular está conectado correctamente.</div>
      </div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-content">
        <div class="step-title">Selecciona tu red WiFi</div>
        <div class="step-desc">La pantalla se conectará a esta red para funcionar.</div>
        <label>Red WiFi</label>
        <select id="wifi-ssid" onchange="checkCustom()">
          <option value="">— Selecciona tu red —</option>
          ${wifiNetworks.map(n => `<option value="${n.ssid}">${n.ssid} (${n.signal}%)</option>`).join('')}
          <option value="__custom__">Otra red (escribir manualmente)</option>
        </select>
        <input type="text" id="wifi-custom" placeholder="Nombre de la red WiFi" style="display:none;margin-top:10px">
        <label>Contraseña WiFi</label>
        <input type="password" id="wifi-pass" placeholder="Contraseña de tu red">
      </div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-content">
        <div class="step-title">Código de activación</div>
        <div class="step-desc">Encuéntralo en <strong style="color:#f0f0f0">cms.sonoro.com.co</strong> → Dispositivos → Generar Código</div>
        <label>Código</label>
        <input type="text" id="code" class="code-input" placeholder="SNR-XXXX-XXXX" maxlength="12" autocomplete="off">
      </div>
    </div>
    <button class="btn" onclick="activateWifi()" id="btn">Conectar y activar</button>
  `;

  const ethSteps = `
    <div class="step">
      <div class="step-num done">✓</div>
      <div class="step-content">
        <div class="step-title">Pantalla conectada a la red</div>
        <div class="step-desc">La pantalla tiene conexión correctamente.</div>
      </div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-content">
        <div class="step-title">Ingresa tu código de activación</div>
        <div class="step-desc">Encuéntralo en <strong style="color:#f0f0f0">cms.sonoro.com.co</strong> → Dispositivos → Generar Código</div>
        <label>Código de activación</label>
        <input type="text" id="code" class="code-input" placeholder="SNR-XXXX-XXXX" maxlength="12" autocomplete="off">
      </div>
    </div>
    <button class="btn" onclick="activate()" id="btn">Activar pantalla</button>
  `;

  const JS = `
    function fmt(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', e => {
        let v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
        if (v.length>3) v=v.slice(0,3)+'-'+v.slice(3);
        if (v.length>8) v=v.slice(0,8)+'-'+v.slice(8);
        e.target.value=v.slice(0,12);
      });
      el.addEventListener('keydown', e => { if(e.key==='Enter') ${apMode ? 'activateWifi' : 'activate'}(); });
    }
    fmt('code');

    function checkCustom() {
      const sel = document.getElementById('wifi-ssid');
      const c = document.getElementById('wifi-custom');
      if (c) c.style.display = sel.value==='__custom__' ? 'block' : 'none';
    }

    function showMsg(t, type) {
      const el = document.getElementById('msg');
      el.textContent = t; el.className = 'msg '+type;
      el.style.display = t ? 'block' : 'none';
    }

    async function activate() {
      const code = (document.getElementById('code')?.value||'').trim();
      if (code.length<12) { showMsg('Ingresa el código completo (SNR-XXXX-XXXX)','err'); return; }
      const btn = document.getElementById('btn');
      btn.disabled=true; btn.textContent='Activando...';
      try {
        const res = await fetch('/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
        const data = await res.json();
        if (data.success) { showMsg('✓ Pantalla activada. Iniciando en unos segundos...','ok'); btn.textContent='✓ Listo'; }
        else { showMsg(data.error||'Código inválido o expirado','err'); btn.disabled=false; btn.textContent='Activar pantalla'; }
      } catch(e) { showMsg('Error de conexión. Verifica que estés en la misma red.','err'); btn.disabled=false; btn.textContent='Activar pantalla'; }
    }

    async function activateWifi() {
      const selEl = document.getElementById('wifi-ssid');
      const ssid = selEl.value==='__custom__' ? document.getElementById('wifi-custom')?.value.trim() : selEl.value;
      const pass = document.getElementById('wifi-pass')?.value||'';
      const code = (document.getElementById('code')?.value||'').trim();
      if (!ssid) { showMsg('Selecciona tu red WiFi','err'); return; }
      if (!pass)  { showMsg('Ingresa la contraseña de tu WiFi','err'); return; }
      if (code.length<12) { showMsg('Ingresa el código completo (SNR-XXXX-XXXX)','err'); return; }
      const btn = document.getElementById('btn');
      btn.disabled=true; btn.textContent='Conectando...';
      showMsg('Conectando a tu red WiFi...','info');
      try {
        await fetch('/activate-wifi',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid,password:pass,code})});
        showMsg('✓ Todo listo. La pantalla se está conectando a tu red y arrancará en unos segundos. Puedes cerrar esta página.','ok');
        btn.textContent='✓ Listo';
      } catch(e) {
        showMsg('✓ Configuración enviada. La pantalla se está conectando a tu red WiFi.','ok');
        btn.textContent='✓ Listo';
      }
    }
  `;

  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0"><title>SONORO. — Activar pantalla</title><style>${CSS}</style></head><body><div class="card"><div class="logo">SONORO.</div><div class="sub">Activación de pantalla</div>${apMode ? apSteps : ethSteps}<div class="msg" id="msg"></div><div class="device-id">ID: ${deviceId}</div></div><script>${JS}</script></body></html>`);
});

// ── ACTIVACIÓN ETHERNET ──────────────────────────────────────
app.post('/activate', async (req, res) => {
  const { code } = req.body;
  const deviceId = getDeviceId();
  const ip = getLocalIP();
  try {
    const r = await axios.post(`${CMS_URL}/api/activate`, {
      code: code.toUpperCase().trim(), device_id: deviceId,
      ip_address: ip, display_mode: process.env.DISPLAY_MODE || 'mirror'
    }, { timeout: 10000 });
    if (r.data.success) {
      console.log(`✅ Activado: ${deviceId}`);
      setTimeout(() => { exec('sudo systemctl restart sonoro-player'); process.exit(0); }, 3000);
      return res.json({ success: true });
    }
    res.json({ success: false, error: r.data.error });
  } catch(e) { res.json({ success: false, error: e.response?.data?.error || 'No se pudo conectar al servidor' }); }
});

// ── ACTIVACIÓN WIFI ──────────────────────────────────────────
app.post('/activate-wifi', async (req, res) => {
  const { ssid, password, code } = req.body;
  const deviceId = getDeviceId();
  res.json({ success: true });

  console.log(`📶 Conectando WiFi: ${ssid}`);
  exec(`/usr/local/bin/sonoro-ap-stop "${ssid}" "${password}"`, { timeout: 30000 }, async (err) => {
    if (err) { console.error('Error WiFi:', err.message); return; }
    await new Promise(r => setTimeout(r, 5000));
    const newIP = getLocalIP();
    try {
      const r = await axios.post(`${CMS_URL}/api/activate`, {
        code: code.toUpperCase().trim(), device_id: deviceId,
        ip_address: newIP, display_mode: process.env.DISPLAY_MODE || 'mirror'
      }, { timeout: 15000 });
      if (r.data.success) {
        console.log(`✅ Activado: ${deviceId}`);
        setTimeout(() => { exec('sudo systemctl restart sonoro-player'); process.exit(0); }, 2000);
      }
    } catch(e) { console.error('Error CMS:', e.message); }
  });
});

// ── INICIO ───────────────────────────────────────────────────
async function start() {
  const ip = getLocalIP();
  const deviceId = getDeviceId();
  const apMode = isAPMode();
  console.log(`\n🌐 SONORO Portal de Activación v2`);
  console.log(`📱 URL: http://${ip}:${PORT}`);
  console.log(`🔌 Modo: ${apMode ? 'AP (SONORO-Setup)' : 'Ethernet/WiFi'}`);
  console.log(`🖥️  Device ID: ${deviceId}\n`);
  app.listen(PORT, '0.0.0.0', () => {
    showActivationScreen(ip, deviceId, apMode ? 'ap' : 'ethernet');
  });
}

start().catch(console.error);
