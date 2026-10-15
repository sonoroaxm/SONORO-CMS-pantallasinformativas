// Events v1 — Generador de certificados PDF
// Modelo canvas-full: productor sube UNA imagen de fondo (canvas).
// El sistema solo overlaya: nombre, evento, sesión, horas, fecha, QR.
// Dos tamaños: letter (11×8.5" apaisado) + half_letter (11×5.5" apaisado).

'use strict';

const PDFDocument = require('pdfkit');
const QRCode      = require('qrcode');
const fs          = require('fs');
const path        = require('path');

// Dimensiones en puntos (72pt = 1in).
// Letter apaisado: 792 × 612. Half letter apaisado: 792 × 396.
const PAGE_SIZES = {
  letter:      { w: 792, h: 612 },
  half_letter: { w: 792, h: 396 },
};

// Zonas overlay por tamaño (todas en % de ancho/alto).
// Mantener en sync con docs/mockups/certificados-v1.html
const ZONES = {
  letter: {
    name:   { xp: 0.15, yp: 0.36, wp: 0.70, hp: 0.14, fontSize: 42, font: 'Helvetica-BoldOblique', color: '#2a2520', align: 'center' },
    event:  { xp: 0.20, yp: 0.54, wp: 0.60, hp: 0.07, fontSize: 16, font: 'Helvetica-Bold',       color: '#2a2520', align: 'center' },
    body:   { xp: 0.18, yp: 0.63, wp: 0.64, hp: 0.11, fontSize: 12, font: 'Helvetica',             color: '#4a3d28', align: 'center' },
    qr:     { xp: 0.07, yp: 0.80, wp: 0.10, hp: 0.14 },
    date:   { xp: 0.40, yp: 0.90, wp: 0.20, hp: 0.05, fontSize: 10, font: 'Helvetica-Oblique',     color: '#4a3d28', align: 'center' },
  },
  half_letter: {
    name:   { xp: 0.15, yp: 0.30, wp: 0.70, hp: 0.18, fontSize: 32, font: 'Helvetica-BoldOblique', color: '#2a2520', align: 'center' },
    event:  { xp: 0.24, yp: 0.50, wp: 0.52, hp: 0.09, fontSize: 13, font: 'Helvetica-Bold',       color: '#2a2520', align: 'center' },
    body:   { xp: 0.24, yp: 0.62, wp: 0.52, hp: 0.12, fontSize: 10, font: 'Helvetica',             color: '#4a3d28', align: 'center' },
    qr:     { xp: 0.04, yp: 0.78, wp: 0.11, hp: 0.17 },
    date:   { xp: 0.38, yp: 0.86, wp: 0.24, hp: 0.06, fontSize: 9,  font: 'Helvetica-Oblique',     color: '#4a3d28', align: 'center' },
  },
};

function formatHours(hoursNum) {
  if (hoursNum == null) return '';
  const n = Number(hoursNum);
  if (Number.isNaN(n)) return '';
  if (Math.abs(n - Math.round(n)) < 0.05) return String(Math.round(n));
  return n.toFixed(1).replace('.', ',');
}

function formatRangeEs(startISO, endISO, tz) {
  const opts = { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz || 'America/Bogota' };
  const s = new Date(startISO);
  const e = endISO ? new Date(endISO) : s;
  const sStr = s.toLocaleDateString('es-CO', opts);
  if (!endISO || s.toDateString() === e.toDateString()) return sStr;
  return `${s.toLocaleDateString('es-CO', { day:'numeric', month:'long', timeZone: tz || 'America/Bogota' })} al ${e.toLocaleDateString('es-CO', opts)}`;
}

function formatDateEs(iso, tz) {
  return new Date(iso).toLocaleDateString('es-CO', { day:'numeric', month:'long', year:'numeric', timeZone: tz || 'America/Bogota' });
}

function renderBody(template, ctx) {
  return template
    .replace(/\{\{nombre\}\}/g,  ctx.nombre  || '')
    .replace(/\{\{evento\}\}/g,  ctx.evento  || '')
    .replace(/\{\{sesion\}\}/g,  ctx.sesion  || '')
    .replace(/\{\{horas\}\}/g,   ctx.horas   || '')
    .replace(/\{\{fecha\}\}/g,   ctx.fecha   || '')
    .replace(/\{\{fechas\}\}/g,  ctx.fechas  || '');
}

/**
 * Genera un PDF de certificado.
 * @param {Object} opts
 * @param {Object} opts.template    - { page_size, canvas_path, body_text, scope }
 * @param {Object} opts.event       - { name, timezone, starts_at, ends_at }
 * @param {Object} opts.registration- { attendee_name, email }
 * @param {Object} [opts.session]   - { name, starts_at, ends_at } si scope=session
 * @param {Number} opts.hoursTotal  - horas totales calculadas
 * @param {String} opts.verifyUrl   - URL completa /verify/:token
 * @param {Date}   opts.issuedAt
 * @param {String} opts.outPath     - path destino del PDF
 * @param {Boolean}[opts.watermark] - si true, estampa "VISTA PREVIA"
 */
async function generateCertificatePdf(opts) {
  const { template, event, registration, session, hoursTotal, verifyUrl, issuedAt, outPath, watermark } = opts;
  const size = PAGE_SIZES[template.page_size] || PAGE_SIZES.letter;
  const zones = ZONES[template.page_size] || ZONES.letter;

  // Prepara contexto para placeholders
  const ctx = {
    nombre: registration.attendee_name || '',
    evento: event.name || '',
    sesion: session?.name || '',
    horas:  formatHours(hoursTotal),
    fecha:  session?.starts_at ? formatDateEs(session.starts_at, event.timezone) : formatDateEs(event.starts_at, event.timezone),
    fechas: formatRangeEs(event.starts_at, event.ends_at, event.timezone),
  };

  // Generar QR como data URL (más simple que buffer, PDFKit soporta data URL vía image)
  let qrPngBuffer = null;
  if (verifyUrl) {
    qrPngBuffer = await QRCode.toBuffer(verifyUrl, { margin: 0, width: 400, errorCorrectionLevel: 'M' });
  }

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [size.w, size.h], margin: 0 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    // 1) Canvas de fondo (si existe)
    if (template.canvas_path && fs.existsSync(template.canvas_path)) {
      try {
        doc.image(template.canvas_path, 0, 0, { width: size.w, height: size.h });
      } catch (e) {
        // Si la imagen está corrupta, dibujamos fondo plano para no fallar
        doc.rect(0, 0, size.w, size.h).fill('#f5f1e8');
      }
    } else {
      // Sin canvas: fondo neutro — útil en vista previa de plantilla sin canvas aún
      doc.rect(0, 0, size.w, size.h).fill('#f5f1e8');
      doc.strokeColor('#b8975f').lineWidth(2).rect(20, 20, size.w - 40, size.h - 60).stroke();
    }

    // 2) Overlays del sistema
    const place = (zone, text, extra) => {
      const x = Math.round(zone.xp * size.w);
      const y = Math.round(zone.yp * size.h);
      const w = Math.round(zone.wp * size.w);
      const h = Math.round(zone.hp * size.h);
      doc.save();
      doc.fillColor(zone.color || '#2a2520');
      try { doc.font(zone.font || 'Helvetica'); } catch (e) { doc.font('Helvetica'); }
      doc.fontSize(zone.fontSize || 12);
      doc.text(text || '', x, y, { width: w, height: h, align: zone.align || 'center', ...(extra || {}) });
      doc.restore();
    };

    place(zones.name, ctx.nombre);

    const eventLine = ctx.sesion ? `${ctx.evento} — ${ctx.sesion}` : ctx.evento;
    place(zones.event, eventLine);

    const body = renderBody(template.body_text || '', ctx);
    place(zones.body, body);

    // Fecha de emisión
    place(zones.date, `Emitido el ${formatDateEs(issuedAt || new Date(), event.timezone)}`);

    // QR
    if (qrPngBuffer) {
      const qx = Math.round(zones.qr.xp * size.w);
      const qy = Math.round(zones.qr.yp * size.h);
      const qw = Math.round(zones.qr.wp * size.w);
      const qh = Math.round(zones.qr.hp * size.h);
      const q  = Math.min(qw, qh);
      doc.rect(qx - 4, qy - 4, q + 8, q + 8).fill('#fff');
      doc.image(qrPngBuffer, qx, qy, { width: q, height: q });
    }

    // Watermark vista previa
    if (watermark) {
      doc.save();
      doc.fillColor('#ef4444');
      doc.opacity(0.25);
      doc.font('Helvetica-Bold').fontSize(80);
      doc.rotate(-25, { origin: [size.w / 2, size.h / 2] });
      doc.text('VISTA PREVIA', 0, size.h / 2 - 50, { width: size.w, align: 'center' });
      doc.restore();
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return outPath;
}

module.exports = {
  generateCertificatePdf,
  PAGE_SIZES,
  ZONES,
};
