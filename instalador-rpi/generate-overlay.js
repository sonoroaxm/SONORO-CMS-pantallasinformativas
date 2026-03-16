// SONORO CMS — Generador de overlay PNG con Montserrat
const { createCanvas, registerFont } = require('canvas');
const fs   = require('fs');
const path = require('path');

const OUTPUT = '/tmp/sonoro-overlay.png';

// Registrar Montserrat
const FONT_DIRS = [
  '/usr/share/fonts/truetype/montserrat',
  '/usr/share/fonts/opentype/montserrat',
  '/usr/share/fonts/montserrat',
];
FONT_DIRS.forEach(dir => {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach(f => {
    const fp = path.join(dir, f);
    if (f.match(/Black/i) && f.match(/\.ttf$/i))
      try { registerFont(fp, { family: 'Montserrat', weight: '900' }); } catch(e){}
    else if (f.match(/Bold/i) && f.match(/\.ttf$/i))
      try { registerFont(fp, { family: 'Montserrat', weight: '700' }); } catch(e){}
    else if (f.match(/Regular/i) && f.match(/\.ttf$/i))
      try { registerFont(fp, { family: 'Montserrat', weight: '400' }); } catch(e){}
  });
});

function hex2rgba(hex, a = 1) {
  hex = (hex || '#FF1B8D').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c+c).join('');
  const r = parseInt(hex.substr(0,2),16);
  const g = parseInt(hex.substr(2,2),16);
  const b = parseInt(hex.substr(4,2),16);
  return `rgba(${r},${g},${b},${a})`;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.lineTo(x+w-r, y); ctx.arcTo(x+w, y, x+w, y+r, r);
  ctx.lineTo(x+w, y+h-r); ctx.arcTo(x+w, y+h, x+w-r, y+h, r);
  ctx.lineTo(x+r, y+h); ctx.arcTo(x, y+h, x, y+h-r, r);
  ctx.lineTo(x, y+r); ctx.arcTo(x, y, x+r, y, r);
  ctx.closePath();
}

function fitText(ctx, text, maxW, startFs, minFs = 18) {
  let fs = startFs;
  ctx.font = `900 ${fs}px Montserrat`;
  while (ctx.measureText(text).width > maxW && fs > minFs) {
    fs -= 2;
    ctx.font = `900 ${fs}px Montserrat`;
  }
  return fs;
}

function generate(d) {
  const W = 1920, H = 1080;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  const pad = 48, gap = 24, R = 28;
  const cw  = (W - pad*2 - gap) / 2;
  const ch  = H - pad*2;
  const l1  = pad, l2 = pad+cw+gap, ty = pad;
  const accent = d.service_color || '#FF1B8D';

  // Fondo semitransparente
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, W, H);

  // ── TARJETA IZQUIERDA ──────────────────────────────────────
  rr(ctx, l1, ty, cw, ch, R);
  ctx.fillStyle = 'rgba(12,12,12,0.93)';
  ctx.fill();

  // Línea acento superior — clip dentro de la tarjeta para respetar esquinas
  ctx.save();
  rr(ctx, l1, ty, cw, ch, R);
  ctx.clip();
  ctx.fillStyle = accent;
  ctx.fillRect(l1, ty, cw, 8);
  ctx.restore();

  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  const cx1 = l1 + cw/2;

  // TURNO ACTUAL — escalar para llenar el ancho
  const fsTA = fitText(ctx, 'TURNO ACTUAL', cw * 0.88, 100);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `900 ${fsTA}px Montserrat`;
  ctx.fillText('TURNO ACTUAL', cx1, ty + ch * 0.13);

  // Número del turno
  const fsN = fitText(ctx, d.token_number, cw * 0.86, 230, 60);
  ctx.fillStyle = accent;
  ctx.font = `900 ${fsN}px Montserrat`;
  ctx.fillText(d.token_number, cx1, ty + ch * 0.47);

  // Ventanilla · Servicio — mismo tamaño que TURNO ACTUAL
  const vcText = (d.counter_name || '') + '  ·  ' + (d.service_name || '');
  const fsVC = fitText(ctx, vcText, cw * 0.88, fsTA);
  ctx.fillStyle = accent;
  ctx.font = `900 ${fsVC}px Montserrat`;
  ctx.fillText(vcText, cx1, ty + ch * 0.79);

  // Badge PRIORITARIO
  if (d.is_priority) {
    ctx.font = `900 26px Montserrat`;
    const bw = ctx.measureText('PRIORITARIO').width + 48;
    const bh = 44, bx = cx1 - bw/2, by = ty + ch*0.91 - bh/2;
    rr(ctx, bx, by, bw, bh, 22);
    ctx.fillStyle = 'rgba(255,204,0,0.15)';
    ctx.fill();
    ctx.strokeStyle = '#FFCC00';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#FFCC00';
    ctx.fillText('PRIORITARIO', cx1, ty + ch*0.91);
  }

  // ── TARJETA DERECHA ────────────────────────────────────────
  rr(ctx, l2, ty, cw, ch, R);
  ctx.fillStyle = 'rgba(12,12,12,0.93)';
  ctx.fill();

  // Línea acento superior gris — clip dentro de la tarjeta
  ctx.save();
  rr(ctx, l2, ty, cw, ch, R);
  ctx.clip();
  ctx.fillStyle = '#555555';
  ctx.fillRect(l2, ty, cw, 8);
  ctx.restore();

  const rx = l2 + 48;

  // PRÓXIMO — mismo tamaño que TURNO ACTUAL
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = '#FFFFFF';
  ctx.font = `900 ${fsTA}px Montserrat`;
  ctx.fillText('PRÓXIMO', l2 + cw/2, ty + ch * 0.11);

  // Cola de turnos
  const queue = d.queue || [];
  if (queue.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = `700 38px Montserrat`;
    ctx.textBaseline = 'middle';
    ctx.fillText('Sin turnos en espera', rx, ty + ch/2);
  } else {
    const itemArea  = ch * 0.80;
    const itemStart = ty + ch * 0.20;
    const itemH     = itemArea / Math.min(queue.length, 4);

    queue.slice(0, 4).forEach((t, i) => {
      const iy  = itemStart + i * itemH;
      const iyC = iy + itemH * 0.5;
      const ic  = t.service_color || '#888888';

      // Separador
      if (i > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(rx, iy);
        ctx.lineTo(l2 + cw - 48, iy);
        ctx.stroke();
      }

      // Número en cola — tamaño proporcional a itemH
      const fsQ = Math.min(Math.floor(itemH * 0.70), 90);
      ctx.fillStyle    = ic;
      ctx.textBaseline = 'middle';
      ctx.textAlign    = 'left';
      ctx.font = `900 ${fsQ}px Montserrat`;
      ctx.fillText(t.display_number, rx, iyC);
      const numW = ctx.measureText(t.display_number).width;

      // Nombre servicio
      const fsSN = Math.min(Math.floor(itemH * 0.38), 46);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `800 ${fsSN}px Montserrat`;
      ctx.fillText(t.service_name, rx + numW + 28, iyC);
    });
  }

  // Logo
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle    = 'rgba(255,140,0,0.6)';
  ctx.font = `900 18px Montserrat`;
  ctx.fillText('SONORO.', W - 30, H - 18);

  // Guardar
  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(OUTPUT, buf);
  console.log('OK:' + OUTPUT);
}

try {
  let raw = process.argv[2] || '{}';
  // Si empieza con / es un archivo
  if (raw.startsWith('/') && require('fs').existsSync(raw)) {
    raw = require('fs').readFileSync(raw, 'utf8');
  }
  const data = JSON.parse(raw);
  generate(data);
} catch(e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
