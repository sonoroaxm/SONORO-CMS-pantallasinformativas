// LICENSES-V1 — Rutas públicas aprobación email (Fase 2)
// Flujo: correo con link → verify JWT one-shot → login Google (whitelist) → ejecuta approve/reject.
// Sin cookie-parser: cookie de sesión firmada manualmente y parseada en cada request.

'use strict';
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { withTransaction } = require('../db/withTransaction');
const approval = require('../services/licensing-approval');
const mailer   = require('../services/licensing-mailer');

const SESSION_COOKIE = 'lic_approver';
const APP_URL = process.env.CMS_URL || 'https://cms.sonoro.com.co';

// ── Cookie helpers ───────────────────────────────────────────────────────────
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(res, email) {
  const token = jwt.sign({ email, kind: 'approver' }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${8*3600}`);
}
function readSession(req) {
  const c = parseCookies(req)[SESSION_COOKIE];
  if (!c) return null;
  try {
    const payload = jwt.verify(c, process.env.JWT_SECRET);
    if (payload.kind !== 'approver' || !approval.isApprover(payload.email)) return null;
    return payload;
  } catch { return null; }
}

// ── Render helpers ───────────────────────────────────────────────────────────
function page(title, body, color = '#00f5d4') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;background:#0f0f0f;color:#fff;font-family:'Segoe UI',Roboto,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;">
<div style="max-width:520px;padding:32px;background:#1a1a1a;border-radius:12px;border-top:4px solid ${color};">
<h1 style="margin:0 0 16px 0;color:${color};font-size:20px;">${title}</h1>
${body}
</div></body></html>`;
}

// ── GET /api/auth/google/start ───────────────────────────────────────────────
router.get('/auth/google/start', (req, res) => {
  const next = String(req.query.next || '/');
  if (!next.startsWith('/')) return res.status(400).send('next inválido');
  const state = approval.signState({ next });
  res.redirect(approval.buildAuthorizeUrl(state));
});

// ── GET /api/auth/google/callback ────────────────────────────────────────────
router.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(page('Error OAuth', `<p>${error}</p>`, '#ff5a5a'));
  const st = approval.verifyState(String(state || ''));
  if (!st) return res.status(400).send(page('State inválido', '<p>Reintenta el link del correo.</p>', '#ff5a5a'));
  try {
    const tok = await approval.exchangeCode(String(code));
    const info = await approval.fetchUserInfo(tok.access_token);
    if (!approval.isApprover(info.email)) {
      return res.status(403).send(page('No autorizado',
        `<p>La cuenta <b>${info.email}</b> no está en el whitelist.</p>`, '#ff5a5a'));
    }
    setSessionCookie(res, info.email);
    res.redirect(st.next);
  } catch (err) {
    console.error('[oauth callback]', err);
    res.status(500).send(page('Error', `<p>${err.message}</p>`, '#ff5a5a'));
  }
});

// ── Guard común para approve/reject ──────────────────────────────────────────
async function guardApprovalLink(req, res, expectedAction) {
  const orderId = parseInt(req.params.id, 10);
  const token = String(req.query.token || '');
  if (!Number.isInteger(orderId) || !token) {
    res.status(400).send(page('Link inválido', '<p>Falta token u orden.</p>', '#ff5a5a'));
    return null;
  }
  const pool = global.pool;
  const v = await approval.verifyApprovalToken(pool, token, expectedAction);
  if (!v.ok) {
    res.status(400).send(page('Token inválido', `<p>${v.error}</p>`, '#ff5a5a'));
    return null;
  }
  if (v.orderId !== orderId) {
    res.status(400).send(page('Orden no coincide', '<p>El token no pertenece a esta orden.</p>', '#ff5a5a'));
    return null;
  }
  const session = readSession(req);
  if (!session) {
    const next = req.originalUrl;
    res.redirect(`/api/auth/google/start?next=${encodeURIComponent(next)}`);
    return null;
  }
  return { orderId, session, pool };
}

// ── GET /api/orders/:id/approve?token=… ──────────────────────────────────────
router.get('/orders/:id/approve', async (req, res) => {
  const ctx = await guardApprovalLink(req, res, 'approve');
  if (!ctx) return;
  const { orderId, session, pool } = ctx;
  try {
    const result = await withTransaction(pool, async (client) => {
      const o = await client.query(
        `SELECT id, user_id, product, months, currency, amount, unit_price, discount_pct, status,
                approval_token_used_at
           FROM license_orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (!o.rows.length) { const e = new Error('Orden no existe'); e.code = 'NOT_FOUND'; throw e; }
      const order = o.rows[0];
      if (order.approval_token_used_at) { const e = new Error('Token ya consumido'); e.code = 'USED'; throw e; }
      if (!['pending_payment','proof_uploaded'].includes(order.status)) {
        const e = new Error(`Orden en estado ${order.status}`); e.code = 'BAD_STATE'; throw e;
      }
      const lic = await client.query(
        `INSERT INTO licenses
           (user_id, product, months, start_date, end_date, status,
            currency, amount, unit_price, discount_pct,
            is_free_grant, order_id, is_trial, note)
         VALUES ($1, $2, $3, NOW(), NOW() + make_interval(months => $3), 'active',
                 $4, $5, $6, $7,
                 FALSE, $8, FALSE, $9)
         RETURNING id, product, months, end_date, currency, amount`,
        [order.user_id, order.product, order.months,
         order.currency, order.amount, order.unit_price, order.discount_pct,
         order.id, `Aprobada vía email por ${session.email}`]
      );
      const licenseId = lic.rows[0].id;
      await client.query(
        `UPDATE license_orders
            SET status = 'approved', approved_at = NOW(),
                license_id = $1, paid_at = COALESCE(paid_at, NOW()),
                approval_token_used_at = NOW()
          WHERE id = $2`, [licenseId, orderId]);
      await client.query(
        `INSERT INTO license_order_audit (order_id, action, actor_email, metadata)
         VALUES ($1, 'approved', $2, $3)`,
        [orderId, session.email, JSON.stringify({ license_id: licenseId, via: 'email-link' })]);
      return { license: lic.rows[0], user_id: order.user_id };
    });
    // Notificar cliente (fire-and-forget)
    try {
      const u = await pool.query(`SELECT id, email, name FROM users WHERE id = $1`, [result.user_id]);
      if (u.rows[0]) mailer.notifyClientOrderApproved({
        order: { id: orderId }, license: result.license, user: u.rows[0],
      });
    } catch (e) { console.error('[approve mail]', e.message); }
    res.send(page('Orden aprobada',
      `<p style="color:#ccc;">Orden #${orderId} aprobada. Licencia ${result.license.id} activa hasta ${new Date(result.license.end_date).toLocaleDateString('es-CO')}.</p>
       <p style="color:#888;font-size:12px;">Aprobado por ${session.email}.</p>
       <p><a href="${APP_URL}/admin-dashboard.html" style="color:#00c8ff;">Ir al panel admin →</a></p>`));
  } catch (err) {
    const map = { NOT_FOUND: 404, USED: 409, BAD_STATE: 409 };
    const code = map[err.code] || 500;
    console.error('[approve link]', err);
    res.status(code).send(page('No se pudo aprobar', `<p>${err.message}</p>`, '#ff5a5a'));
  }
});

// ── GET /api/orders/:id/reject?token=…&reason=… ──────────────────────────────
router.get('/orders/:id/reject', async (req, res) => {
  const ctx = await guardApprovalLink(req, res, 'reject');
  if (!ctx) return;
  const { orderId, session, pool } = ctx;
  const reason = String(req.query.reason || 'Rechazada por administrador').slice(0, 500);
  try {
    const own = await pool.query(
      `SELECT status, user_id, approval_token_used_at FROM license_orders WHERE id = $1`, [orderId]);
    if (!own.rows.length) return res.status(404).send(page('Orden no existe', '', '#ff5a5a'));
    if (own.rows[0].approval_token_used_at) return res.status(409).send(page('Token ya usado', '', '#ff5a5a'));
    if (!['pending_payment','proof_uploaded'].includes(own.rows[0].status)) {
      return res.status(409).send(page('Estado no rechazable',
        `<p>Orden en estado ${own.rows[0].status}.</p>`, '#ff5a5a'));
    }
    await pool.query(
      `UPDATE license_orders
          SET status = 'rejected', rejected_reason = $1,
              approval_token_used_at = NOW()
        WHERE id = $2`, [reason, orderId]);
    await pool.query(
      `INSERT INTO license_order_audit (order_id, action, actor_email, metadata)
       VALUES ($1, 'rejected', $2, $3)`,
      [orderId, session.email, JSON.stringify({ reason, via: 'email-link' })]);
    try {
      const u = await pool.query(`SELECT id, email, name FROM users WHERE id = $1`, [own.rows[0].user_id]);
      if (u.rows[0]) mailer.notifyClientOrderRejected({
        order: { id: orderId, product: '' }, reason, user: u.rows[0],
      });
    } catch (e) { console.error('[reject mail]', e.message); }
    res.send(page('Orden rechazada',
      `<p style="color:#ccc;">Orden #${orderId} rechazada.</p>
       <p style="color:#888;font-size:12px;">Motivo: ${reason}<br>Por ${session.email}.</p>`, '#ff8c00'));
  } catch (err) {
    console.error('[reject link]', err);
    res.status(500).send(page('Error', `<p>${err.message}</p>`, '#ff5a5a'));
  }
});

module.exports = router;
