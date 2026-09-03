// LICENSES-V1 — Rutas admin (§6.2) + metrics Monitor (§7)
// Framework: docs/LICENSES-V1.md
// Fase: 1c-ii. Aprobación email JWT/OAuth queda para Fase 2.

'use strict';
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { withTransaction } = require('../db/withTransaction');
const { PRODUCTS, computePrice, isSecondPlusForProduct } = require('../services/licensing');
const mailer = require('../services/licensing-mailer');

// JWT auth + require admin role
function adminAuth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    if (user?.role !== 'admin') return res.status(403).json({ error: 'Requiere rol admin' });
    req.user = user;
    next();
  });
}

router.use(adminAuth);

// ── GET /api/admin/licenses ───────────────────────────────────────────────────
// Filtros: product, status, country, user_id, q (email/nombre)
router.get('/admin/licenses', async (req, res) => {
  const pool = global.pool;
  const { product, status, country, user_id, q } = req.query;
  const where = [];
  const params = [];
  if (product) { params.push(product); where.push(`l.product = $${params.length}`); }
  if (status)  { params.push(status);  where.push(`l.status  = $${params.length}`); }
  if (country) { params.push(country); where.push(`u.country_code = $${params.length}`); }
  if (user_id) { params.push(parseInt(user_id, 10)); where.push(`l.user_id = $${params.length}`); }
  if (q)       { params.push(`%${q}%`); where.push(`(u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`); }
  const sql = `
    SELECT l.id, l.user_id, u.email, u.name, u.country_code,
           l.product, l.months, l.start_date, l.end_date, l.status,
           l.currency, l.amount, l.unit_price, l.discount_pct,
           l.is_free_grant, l.is_trial, l.trial_days, l.trial_converted_at,
           l.device_id, l.order_id, l.note, l.created_at
      FROM licenses l
      JOIN users u ON u.id = l.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY l.created_at DESC
     LIMIT 500`;
  try {
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    console.error('GET /admin/licenses', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── GET /api/admin/orders ─────────────────────────────────────────────────────
router.get('/admin/orders', async (req, res) => {
  const pool = global.pool;
  const { status, user_id, product } = req.query;
  const where = [];
  const params = [];
  if (status)  { params.push(status);  where.push(`o.status  = $${params.length}`); }
  if (product) { params.push(product); where.push(`o.product = $${params.length}`); }
  if (user_id) { params.push(parseInt(user_id, 10)); where.push(`o.user_id = $${params.length}`); }
  const sql = `
    SELECT o.id, o.user_id, u.email, u.name,
           o.product, o.months, o.country_code, o.currency,
           o.amount, o.unit_price, o.discount_pct, o.status,
           o.payment_method, o.payment_ref, o.payment_proof_url,
           o.payment_proof_uploaded_at, o.paid_at, o.approved_at,
           o.rejected_reason, o.license_id, o.admin_note, o.created_at
      FROM license_orders o
      JOIN users u ON u.id = o.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.created_at DESC
     LIMIT 500`;
  try {
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    console.error('GET /admin/orders', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── GET /api/admin/orders/pending ─────────────────────────────────────────────
router.get('/admin/orders/pending', async (req, res) => {
  const pool = global.pool;
  try {
    const r = await pool.query(
      `SELECT o.id, o.user_id, u.email, u.name, u.country_code,
              o.product, o.months, o.currency, o.amount,
              o.status, o.payment_proof_url, o.payment_proof_uploaded_at,
              o.created_at
         FROM license_orders o
         JOIN users u ON u.id = o.user_id
        WHERE o.status IN ('pending_payment','proof_uploaded')
        ORDER BY o.created_at ASC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('GET /admin/orders/pending', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── POST /api/admin/orders/:id/approve ────────────────────────────────────────
// Transaccional: crea licencia + actualiza orden + audit.
router.post('/admin/orders/:id/approve', async (req, res) => {
  const pool = global.pool;
  const orderId = parseInt(req.params.id, 10);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'id inválido' });
  const { device_id = null, admin_note = null } = req.body || {};
  try {
    const result = await withTransaction(pool, async (client) => {
      const o = await client.query(
        `SELECT id, user_id, product, months, currency, amount, unit_price, discount_pct, status
           FROM license_orders WHERE id = $1 FOR UPDATE`,
        [orderId]
      );
      if (!o.rows.length) { const e = new Error('Orden no existe'); e.code = 'NOT_FOUND'; throw e; }
      const order = o.rows[0];
      if (!['pending_payment','proof_uploaded'].includes(order.status)) {
        const e = new Error(`Orden en estado ${order.status}, no aprobable`); e.code = 'BAD_STATE'; throw e;
      }
      const lic = await client.query(
        `INSERT INTO licenses
           (user_id, device_id, product, months, start_date, end_date, status,
            currency, amount, unit_price, discount_pct,
            is_free_grant, order_id, is_trial, created_by, note)
         VALUES ($1, $2, $3, $4, NOW(), NOW() + make_interval(months => $4), 'active',
                 $5, $6, $7, $8,
                 FALSE, $9, FALSE, $10, $11)
         RETURNING id, product, start_date, end_date, currency, amount`,
        [order.user_id, device_id, order.product, order.months,
         order.currency, order.amount, order.unit_price, order.discount_pct,
         order.id, req.user.id, admin_note]
      );
      const licenseId = lic.rows[0].id;
      await client.query(
        `UPDATE license_orders
            SET status = 'approved', approved_by = $1, approved_at = NOW(),
                license_id = $2, admin_note = COALESCE($3, admin_note),
                paid_at = COALESCE(paid_at, NOW())
          WHERE id = $4`,
        [req.user.id, licenseId, admin_note, orderId]
      );
      await client.query(
        `INSERT INTO license_order_audit (order_id, action, actor_email, metadata)
         VALUES ($1, 'approved', $2, $3)`,
        [orderId, req.user.email || null, JSON.stringify({ license_id: licenseId, device_id })]
      );
      return { order_id: orderId, license_id: licenseId, license: lic.rows[0], user_id: order.user_id };
    });
    try {
      const u = await pool.query(`SELECT id, email, name FROM users WHERE id = $1`, [result.user_id]);
      if (u.rows[0]) mailer.notifyClientOrderApproved({
        order: { id: orderId }, license: result.license, user: u.rows[0],
      });
    } catch (e) { console.error('[admin approve mail]', e.message); }
    res.json(result);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'BAD_STATE') return res.status(409).json({ error: err.message });
    console.error('POST /admin/orders/:id/approve', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

// ── POST /api/admin/orders/:id/reject ─────────────────────────────────────────
router.post('/admin/orders/:id/reject', async (req, res) => {
  const pool = global.pool;
  const orderId = parseInt(req.params.id, 10);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'id inválido' });
  const { reason } = req.body || {};
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason requerido' });
  try {
    const own = await pool.query(
      `SELECT status, user_id, product FROM license_orders WHERE id = $1`, [orderId]
    );
    if (!own.rows.length) return res.status(404).json({ error: 'Orden no existe' });
    if (!['pending_payment','proof_uploaded'].includes(own.rows[0].status)) {
      return res.status(409).json({ error: `Orden en estado ${own.rows[0].status}, no rechazable` });
    }
    await pool.query(
      `UPDATE license_orders
          SET status = 'rejected', rejected_reason = $1
        WHERE id = $2`,
      [reason, orderId]
    );
    await pool.query(
      `INSERT INTO license_order_audit (order_id, action, actor_email, metadata)
       VALUES ($1, 'rejected', $2, $3)`,
      [orderId, req.user.email || null, JSON.stringify({ reason })]
    );
    try {
      const u = await pool.query(`SELECT id, email, name FROM users WHERE id = $1`, [own.rows[0].user_id]);
      if (u.rows[0]) mailer.notifyClientOrderRejected({
        order: { id: orderId, product: own.rows[0].product }, reason, user: u.rows[0],
      });
    } catch (e) { console.error('[admin reject mail]', e.message); }
    res.json({ id: orderId, status: 'rejected', rejected_reason: reason });
  } catch (err) {
    console.error('POST /admin/orders/:id/reject', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── POST /api/admin/users/:id/licenses ────────────────────────────────────────
// Emisión manual super-admin (sin flujo orden). Puede ser is_free_grant.
router.post('/admin/users/:id/licenses', async (req, res) => {
  const pool = global.pool;
  const userId = parseInt(req.params.id, 10);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'user id inválido' });
  const { product, months, device_id = null, is_free_grant = false, annual = false, note = null } = req.body || {};
  if (!PRODUCTS.includes(product)) return res.status(400).json({ error: 'product inválido' });
  const monthsN = parseInt(months, 10);
  if (!Number.isInteger(monthsN) || monthsN < 1 || monthsN > 36) {
    return res.status(400).json({ error: 'months entre 1 y 36' });
  }
  try {
    const u = await pool.query(`SELECT currency FROM users WHERE id = $1`, [userId]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuario no existe' });
    const currency = u.rows[0].currency || 'COP';
    let amount = 0, unit_price = 0, discount_pct = 0;
    if (!is_free_grant) {
      const isSecondPlus = await isSecondPlusForProduct(pool, userId, product);
      const p = await computePrice(pool, { product, currency, months: monthsN, annual: !!annual, isSecondPlus });
      amount = p.amount; unit_price = p.unit_price; discount_pct = p.discount_pct;
    }
    const ins = await pool.query(
      `INSERT INTO licenses
         (user_id, device_id, product, months, start_date, end_date, status,
          currency, amount, unit_price, discount_pct,
          is_free_grant, is_trial, created_by, note)
       VALUES ($1, $2, $3, $4, NOW(), NOW() + make_interval(months => $4), 'active',
               $5, $6, $7, $8,
               $9, FALSE, $10, $11)
       RETURNING id, product, months, start_date, end_date, currency, amount, is_free_grant`,
      [userId, device_id, product, monthsN, currency, amount, unit_price, discount_pct,
       !!is_free_grant, req.user.id, note]
    );
    res.status(201).json(ins.rows[0]);
  } catch (err) {
    console.error('POST /admin/users/:id/licenses', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

// ── POST /api/admin/licenses/:id/suspend ──────────────────────────────────────
router.post('/admin/licenses/:id/suspend', async (req, res) => {
  const pool = global.pool;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const r = await pool.query(
      `UPDATE licenses SET status = 'suspended'
        WHERE id = $1 AND status = 'active'
        RETURNING id, status`,
      [id]
    );
    if (!r.rows.length) return res.status(409).json({ error: 'Licencia no existe o no está activa' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('POST /admin/licenses/:id/suspend', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── POST /api/admin/licenses/:id/reactivate ───────────────────────────────────
router.post('/admin/licenses/:id/reactivate', async (req, res) => {
  const pool = global.pool;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const r = await pool.query(
      `UPDATE licenses SET status = 'active'
        WHERE id = $1 AND status = 'suspended' AND end_date > NOW()
        RETURNING id, status, end_date`,
      [id]
    );
    if (!r.rows.length) return res.status(409).json({ error: 'Licencia no suspendida o vencida' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('POST /admin/licenses/:id/reactivate', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── GET /api/admin/metrics/licenses ───────────────────────────────────────────
// Payload Monitor: KPIs + charts + tablas. PDF export en Fase 3 (UI).
router.get('/admin/metrics/licenses', async (req, res) => {
  const pool = global.pool;
  try {
    const kpis = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM licenses WHERE status = 'active')                                                AS active_total,
        (SELECT COUNT(*) FROM licenses WHERE status = 'active' AND is_trial = TRUE)                             AS active_trials,
        (SELECT COUNT(*) FROM licenses WHERE status = 'active' AND end_date <= NOW() + INTERVAL '30 days')      AS expiring_30d,
        (SELECT COUNT(*) FROM license_orders WHERE status IN ('pending_payment','proof_uploaded'))              AS orders_pending,
        (SELECT COALESCE(SUM(amount),0) FROM licenses
          WHERE status = 'active' AND is_trial = FALSE AND is_free_grant = FALSE AND currency = 'COP'
            AND created_at >= date_trunc('month', NOW()))                                                       AS mrr_cop_month,
        (SELECT COALESCE(SUM(amount),0) FROM licenses
          WHERE status = 'active' AND is_trial = FALSE AND is_free_grant = FALSE AND currency = 'USD'
            AND created_at >= date_trunc('month', NOW()))                                                       AS mrr_usd_month,
        (SELECT COUNT(DISTINCT user_id) FROM licenses WHERE status = 'active' AND is_trial = FALSE)             AS paying_users
    `);

    const byProduct = await pool.query(`
      SELECT product, COUNT(*)::int AS n
        FROM licenses WHERE status = 'active'
       GROUP BY product`);

    const byCountry = await pool.query(`
      SELECT u.country_code, COUNT(*)::int AS n
        FROM licenses l JOIN users u ON u.id = l.user_id
       WHERE l.status = 'active'
       GROUP BY u.country_code
       ORDER BY n DESC`);

    const expiringSoon = await pool.query(`
      SELECT l.id, u.email, u.name, l.product, l.end_date,
             CEIL(EXTRACT(EPOCH FROM (l.end_date - NOW()))/86400)::int AS days_left
        FROM licenses l JOIN users u ON u.id = l.user_id
       WHERE l.status = 'active' AND l.end_date <= NOW() + INTERVAL '30 days'
       ORDER BY l.end_date ASC
       LIMIT 100`);

    const recentOrders = await pool.query(`
      SELECT o.id, u.email, o.product, o.months, o.currency, o.amount, o.status, o.created_at
        FROM license_orders o JOIN users u ON u.id = o.user_id
       ORDER BY o.created_at DESC
       LIMIT 25`);

    const k = kpis.rows[0];
    const payingUsers = Number(k.paying_users);
    res.json({
      generated_at: new Date().toISOString(),
      kpis: {
        active_total:     Number(k.active_total),
        active_trials:    Number(k.active_trials),
        expiring_30d:     Number(k.expiring_30d),
        orders_pending:   Number(k.orders_pending),
        mrr_cop_month:    Number(k.mrr_cop_month),
        mrr_usd_month:    Number(k.mrr_usd_month),
        paying_users:     payingUsers,
        goal_25_progress: Math.min(1, payingUsers / 25),
      },
      by_product:  byProduct.rows,
      by_country:  byCountry.rows,
      expiring:    expiringSoon.rows,
      recent_orders: recentOrders.rows,
    });
  } catch (err) {
    console.error('GET /admin/metrics/licenses', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
