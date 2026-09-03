// LICENSES-V1 — Mailer (Fase 2)
// Reusa SMTP config del monolito (SMTP_HOST/PORT/USER/PASS/FROM).
// Independiente de services/email.js para desacoplar el ciclo de licencias.

'use strict';
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'mail.sonoro.com.co',
  port: parseInt(process.env.SMTP_PORT, 10) || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'cms@sonoro.com.co',
    pass: process.env.SMTP_PASS,
  },
});

const FROM = process.env.SMTP_FROM || 'SONORO CMS <cms@sonoro.com.co>';
const APP_URL = process.env.CMS_URL || 'https://cms.sonoro.com.co';
const APPROVER = (process.env.LICENSE_APPROVAL_WHITELIST || 'sonoroaxm@gmail.com')
  .split(',')[0].trim();

const BRAND = `
  <div style="background:linear-gradient(135deg,#FF1B8D,#FF8C00,#FFC800);padding:2px;border-radius:10px;">
    <div style="background:#0f0f0f;border-radius:8px;padding:20px 24px;">
      <div style="color:#fff;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
`;
const BRAND_END = `</div></div></div>`;

const money = (n, cur) => cur === 'USD'
  ? `USD $${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
  : `$${Number(n).toLocaleString('es-CO')} COP`;

async function safeSend(opts) {
  try {
    await transporter.sendMail(opts);
    console.log(`[licensing-mailer] sent to ${opts.to}: ${opts.subject}`);
  } catch (err) {
    console.error(`[licensing-mailer] send failed to ${opts.to}: ${err.message}`);
  }
}

// ── 1. Admin: nueva orden con proof lista para aprobar ────────────────────────
async function notifyAdminNewOrder({ order, user, approveUrl, rejectUrl }) {
  const html = `${BRAND}
    <h2 style="margin:0 0 12px 0;color:#FF1B8D;">Nueva orden de licencia</h2>
    <p style="color:#ccc;font-size:14px;line-height:1.6;">
      El cliente <b style="color:#fff;">${user.email}</b> subió comprobante de pago.
    </p>
    <table style="width:100%;color:#ddd;font-size:13px;margin:16px 0;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#888;">Producto</td><td style="padding:6px 0;"><b>${order.product}</b></td></tr>
      <tr><td style="padding:6px 0;color:#888;">Meses</td><td style="padding:6px 0;">${order.months}</td></tr>
      <tr><td style="padding:6px 0;color:#888;">Total</td><td style="padding:6px 0;"><b>${money(order.amount, order.currency)}</b></td></tr>
      <tr><td style="padding:6px 0;color:#888;">País</td><td style="padding:6px 0;">${order.country_code}</td></tr>
      <tr><td style="padding:6px 0;color:#888;">Orden #</td><td style="padding:6px 0;">${order.id}</td></tr>
    </table>
    ${order.payment_proof_url ? `<p style="margin:12px 0;"><a href="${APP_URL}${order.payment_proof_url}" style="color:#00c8ff;font-size:13px;">Ver comprobante →</a></p>` : ''}
    <div style="margin:28px 0 8px 0;">
      <a href="${approveUrl}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;margin-right:8px;">Aprobar</a>
      <a href="${rejectUrl}" style="display:inline-block;padding:14px 28px;background:#333;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;">Rechazar</a>
    </div>
    <p style="color:#666;font-size:11px;margin-top:20px;">
      Enlaces válidos 24h · uso único · requieren login con tu cuenta Google
    </p>
  ${BRAND_END}`;

  return safeSend({
    from: FROM, to: APPROVER,
    subject: `[Licencias] Orden #${order.id} · ${order.product} · ${money(order.amount, order.currency)}`,
    html,
  });
}

// ── 2. Cliente: orden aprobada ────────────────────────────────────────────────
async function notifyClientOrderApproved({ order, license, user }) {
  const html = `${BRAND}
    <h2 style="margin:0 0 12px 0;color:#00f5d4;">Licencia activada</h2>
    <p style="color:#ccc;font-size:14px;line-height:1.6;">
      Hola ${user.name || user.email}, tu orden fue aprobada y la licencia ya está activa.
    </p>
    <table style="width:100%;color:#ddd;font-size:13px;margin:16px 0;">
      <tr><td style="padding:6px 0;color:#888;">Producto</td><td><b>${license.product}</b></td></tr>
      <tr><td style="padding:6px 0;color:#888;">Duración</td><td>${license.months} meses</td></tr>
      <tr><td style="padding:6px 0;color:#888;">Vence</td><td>${new Date(license.end_date).toLocaleDateString('es-CO')}</td></tr>
    </table>
    <a href="${APP_URL}/dashboard.html" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;margin-top:12px;">Ir al panel →</a>
  ${BRAND_END}`;

  return safeSend({
    from: FROM, to: user.email,
    subject: `Tu licencia ${license.product} está activa`,
    html,
  });
}

// ── 3. Cliente: orden rechazada ───────────────────────────────────────────────
async function notifyClientOrderRejected({ order, reason, user }) {
  const html = `${BRAND}
    <h2 style="margin:0 0 12px 0;color:#ff5a5a;">Orden rechazada</h2>
    <p style="color:#ccc;font-size:14px;line-height:1.6;">
      Hola ${user.name || user.email}, tu orden #${order.id} de ${order.product} fue rechazada.
    </p>
    <div style="background:#1a1a1a;border-left:3px solid #ff5a5a;padding:12px 16px;margin:16px 0;color:#ddd;font-size:13px;">
      ${reason}
    </div>
    <p style="color:#aaa;font-size:13px;">Puedes crear una nueva orden desde tu panel o responder este correo si necesitas ayuda.</p>
  ${BRAND_END}`;

  return safeSend({ from: FROM, to: user.email, subject: `Orden #${order.id} rechazada`, html });
}

// ── 4. Cliente: trial iniciado ────────────────────────────────────────────────
async function notifyClientTrialStarted({ license, user }) {
  const html = `${BRAND}
    <h2 style="margin:0 0 12px 0;color:#00f5d4;">Prueba de 30 días activada</h2>
    <p style="color:#ccc;font-size:14px;line-height:1.6;">
      Tu prueba de ${license.product} está activa hasta el
      <b style="color:#fff;">${new Date(license.end_date).toLocaleDateString('es-CO')}</b>.
    </p>
    <p style="color:#aaa;font-size:13px;">Sin tarjeta, sin compromiso. Al vencer puedes comprar desde tu panel.</p>
    <a href="${APP_URL}/dashboard.html" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;margin-top:12px;">Empezar →</a>
  ${BRAND_END}`;

  return safeSend({ from: FROM, to: user.email, subject: `Prueba SONORO ${license.product} activa (30 días)`, html });
}

// ── 5. Cliente: licencia por vencer (30d/7d) ──────────────────────────────────
async function notifyClientLicenseExpiring({ license, user, daysLeft }) {
  const urgent = daysLeft <= 7;
  const color = urgent ? '#ff5a5a' : '#ff8c00';
  const html = `${BRAND}
    <h2 style="margin:0 0 12px 0;color:${color};">Tu licencia vence en ${daysLeft} días</h2>
    <p style="color:#ccc;font-size:14px;line-height:1.6;">
      La licencia <b style="color:#fff;">${license.product}</b> vence el
      <b>${new Date(license.end_date).toLocaleDateString('es-CO')}</b>.
    </p>
    <p style="color:#aaa;font-size:13px;">Renueva desde tu panel para evitar interrupción del servicio.</p>
    <a href="${APP_URL}/dashboard.html" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;margin-top:12px;">Renovar →</a>
  ${BRAND_END}`;

  return safeSend({ from: FROM, to: user.email, subject: `Tu licencia ${license.product} vence en ${daysLeft} días`, html });
}

module.exports = {
  notifyAdminNewOrder,
  notifyClientOrderApproved,
  notifyClientOrderRejected,
  notifyClientTrialStarted,
  notifyClientLicenseExpiring,
};
