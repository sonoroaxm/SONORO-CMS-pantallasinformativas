// LICENSES-V1 — Rutas cliente
// Framework: docs/LICENSES-V1.md §6.1 + §1.6 (trial)
// Fase: 1c-i (cliente + trial). Endpoints admin y aprobación email en fases posteriores.

'use strict';
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const path    = require('path');
const fs      = require('fs');
const {
  PRODUCTS,
  computePrice,
  hasUsedTrial,
  isSecondPlusForProduct,
} = require('../services/licensing');
const mailer   = require('../services/licensing-mailer');
const approval = require('../services/licensing-approval');

const APP_URL = process.env.CMS_URL || 'https://cms.sonoro.com.co';

// JWT auth (idéntico al de events.js — patrón local por-router)
function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
}

// Upload de comprobantes de pago — usa express-fileupload (registrado global en index.js)
const PROOFS_DIR = path.join(__dirname, '../../uploads/payment-proofs');
const PROOF_MAX_BYTES = 5 * 1024 * 1024;
const PROOF_EXT_RE = /\.(pdf|png|jpg|jpeg)$/i;

// ── HEALTH ────────────────────────────────────────────────────────────────────
router.get('/licenses/health', (req, res) => {
  res.json({ module: 'licenses', status: 'ok', phase: '1c-i' });
});

// ── GET /api/licenses/mine ────────────────────────────────────────────────────
// Lista todas las licencias del usuario logueado
router.get('/licenses/mine', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const r = await pool.query(
      `SELECT id, product, months, start_date, end_date, status,
              currency, amount, unit_price, discount_pct,
              is_free_grant, is_trial, trial_days, trial_converted_at,
              device_id, order_id, note, created_at
         FROM licenses
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('GET /licenses/mine', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── POST /api/licenses/trial ──────────────────────────────────────────────────
// Crea trial 30 días para (user, product). 1 por producto de por vida.
router.post('/licenses/trial', auth, async (req, res) => {
  const pool = global.pool;
  const { product } = req.body || {};
  if (!product || !['smart_tv', 'windows'].includes(product)) {
    // Player NO tiene trial (12m grant al activar RPi ≠ trial)
    return res.status(400).json({ error: 'Producto inválido para trial (smart_tv | windows)' });
  }
  try {
    const already = await hasUsedTrial(pool, req.user.id, product);
    if (already) {
      return res.status(409).json({ error: 'Ya usaste el trial de este producto', product });
    }
    // Currency del usuario (default COP)
    const u = await pool.query(`SELECT currency FROM users WHERE id = $1`, [req.user.id]);
    const currency = (u.rows[0] && u.rows[0].currency) || 'COP';

    const ins = await pool.query(
      `INSERT INTO licenses
         (user_id, product, months, start_date, end_date, status, currency,
          amount, unit_price, discount_pct, is_free_grant, is_trial, trial_days,
          created_by, note)
       VALUES ($1, $2, 1, NOW(), NOW() + INTERVAL '30 days', 'active', $3,
               0, 0, 0, TRUE, TRUE, 30, $1, 'trial 30d')
       RETURNING id, product, start_date, end_date, is_trial, trial_days`,
      [req.user.id, product, currency]
    );
    // Notificar cliente trial iniciado (fire-and-forget)
    try {
      const uu = await pool.query(`SELECT id, email, name FROM users WHERE id = $1`, [req.user.id]);
      if (uu.rows[0]) mailer.notifyClientTrialStarted({ license: ins.rows[0], user: uu.rows[0] });
    } catch (e) { console.error('[trial mail]', e.message); }
    res.status(201).json(ins.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      // Colisión con unique partial index (double-submit)
      return res.status(409).json({ error: 'Ya usaste el trial de este producto', product });
    }
    console.error('POST /licenses/trial', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── GET /api/orders/mine ──────────────────────────────────────────────────────
router.get('/orders/mine', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const r = await pool.query(
      `SELECT id, product, months, currency, amount, unit_price, discount_pct,
              status, payment_method, payment_ref, payment_proof_url,
              payment_proof_uploaded_at, paid_at, approved_at, rejected_reason,
              license_id, admin_note, created_at
         FROM license_orders
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('GET /orders/mine', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── POST /api/orders ──────────────────────────────────────────────────────────
// Crea una orden (pending_payment). El cliente sube comprobante después.
router.post('/orders', auth, async (req, res) => {
  const pool = global.pool;
  const { product, months, annual = false } = req.body || {};
  if (!PRODUCTS.includes(product)) {
    return res.status(400).json({ error: 'product inválido' });
  }
  const monthsN = parseInt(months, 10);
  if (!Number.isInteger(monthsN) || monthsN < 1 || monthsN > 36) {
    return res.status(400).json({ error: 'months debe estar entre 1 y 36' });
  }
  try {
    const u = await pool.query(
      `SELECT country_code, currency FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!u.rows.length) return res.status(401).json({ error: 'Usuario no encontrado' });
    const country = u.rows[0].country_code || 'CO';
    const currency = u.rows[0].currency || 'COP';

    const isSecondPlus = await isSecondPlusForProduct(pool, req.user.id, product);
    const price = await computePrice(pool, {
      product,
      currency,
      months: monthsN,
      annual: !!annual,
      isSecondPlus,
    });

    const ins = await pool.query(
      `INSERT INTO license_orders
         (user_id, product, months, country_code, currency,
          amount, unit_price, discount_pct, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_payment')
       RETURNING id, product, months, country_code, currency,
                 amount, unit_price, discount_pct, status, created_at`,
      [req.user.id, product, monthsN, country, currency,
       price.amount, price.unit_price, price.discount_pct]
    );

    // Audit inicial
    await pool.query(
      `INSERT INTO license_order_audit (order_id, action, actor_email, metadata)
       VALUES ($1, 'created', $2, $3)`,
      [ins.rows[0].id, req.user.email || null,
       JSON.stringify({ annual: !!annual, second_plus: isSecondPlus })]
    );

    res.status(201).json(ins.rows[0]);
  } catch (err) {
    console.error('POST /orders', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

// ── POST /api/orders/:id/proof ────────────────────────────────────────────────
// Sube comprobante de pago (multipart). Cambia status a 'proof_uploaded'.
router.post('/orders/:id/proof', auth, async (req, res) => {
  const pool = global.pool;
  const orderId = parseInt(req.params.id, 10);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'id inválido' });

  const file = req.files && req.files.proof;
  if (!file) return res.status(400).json({ error: 'Falta archivo (field: proof)' });
  if (Array.isArray(file)) return res.status(400).json({ error: 'Solo un archivo' });
  if (file.size > PROOF_MAX_BYTES) return res.status(413).json({ error: 'Archivo excede 5MB' });
  if (!PROOF_EXT_RE.test(file.name)) return res.status(415).json({ error: 'Formato inválido (PDF/PNG/JPG)' });

  try {
    const own = await pool.query(
      `SELECT user_id, status FROM license_orders WHERE id = $1`,
      [orderId]
    );
    if (!own.rows.length) return res.status(404).json({ error: 'Orden no existe' });
    if (own.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Orden ajena' });
    }
    if (!['pending_payment', 'proof_uploaded'].includes(own.rows[0].status)) {
      return res.status(409).json({ error: 'Orden no admite comprobante en su estado actual' });
    }

    fs.mkdirSync(PROOFS_DIR, { recursive: true });
    const ext = path.extname(file.name).toLowerCase();
    const fname = `order-${orderId}-${Date.now()}${ext}`;
    const dst = path.join(PROOFS_DIR, fname);
    await file.mv(dst);

    const publicUrl = `/uploads/payment-proofs/${fname}`;
    await pool.query(
      `UPDATE license_orders
          SET payment_proof_url = $1,
              payment_proof_uploaded_at = NOW(),
              status = 'proof_uploaded'
        WHERE id = $2`,
      [publicUrl, orderId]
    );

    await pool.query(
      `INSERT INTO license_order_audit (order_id, action, actor_email, metadata)
       VALUES ($1, 'proof_uploaded', $2, $3)`,
      [orderId, req.user.email || null,
       JSON.stringify({ filename: file.name, size: file.size })]
    );

    // Emitir JWT one-shot approve + reject y enviar mail al admin (fire-and-forget)
    try {
      // Secuencial (no Promise.all): _loadJtis + UPDATE tienen race si corren en paralelo
      const tApprove = await approval.issueApprovalToken(pool, orderId, 'approve');
      const tReject  = await approval.issueApprovalToken(pool, orderId, 'reject');
      const approveUrl = `${APP_URL}/api/orders/${orderId}/approve?token=${encodeURIComponent(tApprove)}`;
      const rejectUrl  = `${APP_URL}/api/orders/${orderId}/reject?token=${encodeURIComponent(tReject)}`;
      const full = await pool.query(
        `SELECT o.id, o.product, o.months, o.currency, o.amount, o.country_code,
                o.payment_proof_url,
                u.email, u.name
           FROM license_orders o JOIN users u ON u.id = o.user_id
          WHERE o.id = $1`, [orderId]);
      const row = full.rows[0];
      if (row) mailer.notifyAdminNewOrder({
        order: row,
        user: { email: row.email, name: row.name },
        approveUrl, rejectUrl,
      });
    } catch (e) { console.error('[proof mail]', e.message); }

    res.json({ id: orderId, status: 'proof_uploaded', payment_proof_url: publicUrl });
  } catch (err) {
    console.error('POST /orders/:id/proof', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── POST /api/orders/:id/cancel ───────────────────────────────────────────────
// Cancelar orden propia solo si está pending_payment o proof_uploaded.
router.post('/orders/:id/cancel', auth, async (req, res) => {
  const pool = global.pool;
  const orderId = parseInt(req.params.id, 10);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'id inválido' });
  try {
    const own = await pool.query(
      `SELECT user_id, status FROM license_orders WHERE id = $1`,
      [orderId]
    );
    if (!own.rows.length) return res.status(404).json({ error: 'Orden no existe' });
    if (own.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Orden ajena' });
    }
    if (!['pending_payment', 'proof_uploaded'].includes(own.rows[0].status)) {
      return res.status(409).json({ error: 'Orden no se puede cancelar en su estado actual' });
    }
    await pool.query(
      `UPDATE license_orders SET status = 'cancelled' WHERE id = $1`,
      [orderId]
    );
    await pool.query(
      `INSERT INTO license_order_audit (order_id, action, actor_email)
       VALUES ($1, 'cancelled_by_user', $2)`,
      [orderId, req.user.email || null]
    );
    res.json({ id: orderId, status: 'cancelled' });
  } catch (err) {
    console.error('POST /orders/:id/cancel', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
