// Events v1 — Rutas staff operativo (check-in, redemption, lookup)
// Auth: JWT CMS (organizer) o JWT staff (PIN login desde /auth)
// P-1: check-in en registration_checkins, NO en registrations
// P-3: withTransaction en checkin + redeem
// P-5: event_day siempre AT TIME ZONE events.timezone
// P-6: hot path < 200ms — mínimos joins, FOR UPDATE en check-in
// Fase: E2

'use strict';
const express   = require('express');
const router    = express.Router();
const rateLimit = require('express-rate-limit');
const jwt       = require('jsonwebtoken');
const { withTransaction } = require('../db/withTransaction');

const checkinLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados check-ins, reintenta en un momento' },
});

const redeemLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes' },
});

const staffAuthLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos, reintenta en un momento' },
});

// Acepta JWT CMS (organizer) o JWT staff (generado por /auth)
function authenticateEventStaff(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
    req.staff = decoded;
    next();
  });
}

// ── HEALTH ─────────────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ module: 'events-staff', status: 'ok', phase: 'E2' });
});

// ── LOGIN STAFF POR PIN ────────────────────────────────────────────────────────
// POST /api/events/staff/auth
// Body: { event_id, pin }
// Retorna JWT de 12h con { staff_id, event_id, role, user_id, type:'staff' }
router.post('/auth', staffAuthLimiter, async (req, res) => {
  const pool = global.pool;
  const { event_id, pin } = req.body;
  if (!event_id || !pin) return res.status(400).json({ error: 'event_id y pin requeridos' });

  try {
    const evRes = await pool.query(
      `SELECT id, name, slug, user_id, timezone, starts_at, ends_at
       FROM events.events
       WHERE id = $1 AND status IN ('published','live')`,
      [event_id]
    );
    if (!evRes.rows[0]) return res.status(404).json({ error: 'Evento no encontrado o no disponible' });
    const event = evRes.rows[0];

    const staffRes = await pool.query(
      `SELECT id, name, role FROM events.event_staff
       WHERE event_id = $1 AND pin = $2`,
      [event_id, String(pin).trim()]
    );
    if (!staffRes.rows[0]) return res.status(401).json({ error: 'PIN inválido' });
    const staff = staffRes.rows[0];

    const token = jwt.sign(
      { staff_id: staff.id, event_id: event.id, role: staff.role,
        user_id: event.user_id, type: 'staff' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      token,
      staff: { id: staff.id, name: staff.name, role: staff.role },
      event: { id: event.id, name: event.name, slug: event.slug,
               timezone: event.timezone, starts_at: event.starts_at, ends_at: event.ends_at },
    });
  } catch (err) {
    console.error('❌ POST /api/events/staff/auth:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── STATS DEL DÍA (para panel lateral de la tablet) ───────────────────────────
router.get('/:eventId/stats', authenticateEventStaff, async (req, res) => {
  const pool = global.pool;
  try {
    const evRes = await pool.query(
      `SELECT timezone FROM events.events WHERE id = $1`, [req.params.eventId]
    );
    if (!evRes.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    const { timezone } = evRes.rows[0];
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM events.registrations
          WHERE event_id = $1 AND status != 'cancelled')::int         AS total,
         (SELECT COUNT(*) FROM events.registrations
          WHERE event_id = $1 AND status = 'pending')::int            AS pending,
         (SELECT COUNT(DISTINCT registration_id)
          FROM events.registration_checkins WHERE event_id = $1)::int AS checked_in_total,
         (SELECT COUNT(DISTINCT registration_id)
          FROM events.registration_checkins
          WHERE event_id = $1
            AND event_day = (CURRENT_TIMESTAMP AT TIME ZONE $2)::DATE)::int AS checked_in_today,
         (CURRENT_TIMESTAMP AT TIME ZONE $2)::DATE::text               AS event_day`,
      [req.params.eventId, timezone]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ GET /api/events/staff/:id/stats:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── LOOKUP POR QR (previsualización antes de escanear) ─────────────────────────
// GET /api/events/staff/:eventId/lookup/:qr
router.get('/:eventId/lookup/:qr', authenticateEventStaff, async (req, res) => {
  const pool = global.pool;
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.qr_token, r.ticket_type, r.status,
              a.name, a.email,
              (SELECT json_agg(json_build_object('event_day', c.event_day::text) ORDER BY c.event_day)
               FROM events.registration_checkins c
               WHERE c.registration_id = r.id) AS checkins
       FROM events.registrations r
       JOIN events.attendees a ON a.id = r.attendee_id
       WHERE r.qr_token = $1 AND r.event_id = $2`,
      [req.params.qr, req.params.eventId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'QR no válido para este evento' });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ GET /api/events/staff/:id/lookup/:qr:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── CHECK-IN POR QR ────────────────────────────────────────────────────────────
// POST /api/events/staff/:eventId/checkin
// Body: { qr_token }
// P-6: hot path — target < 200ms
router.post('/:eventId/checkin', checkinLimiter, authenticateEventStaff, async (req, res) => {
  const pool = global.pool;
  const { qr_token } = req.body;
  if (!qr_token?.trim()) return res.status(400).json({ error: 'qr_token requerido' });

  const t0 = Date.now();

  try {
    const result = await withTransaction(pool, async (client) => {
      // 1. Timezone del evento (P-5)
      const evRes = await client.query(
        `SELECT timezone FROM events.events WHERE id = $1`,
        [req.params.eventId]
      );
      if (!evRes.rows[0]) {
        const err = new Error('Evento no encontrado'); err.httpStatus = 404; throw err;
      }
      const { timezone } = evRes.rows[0];

      // 2. Día actual en TZ del evento (P-5)
      const { rows: dayRows } = await client.query(
        `SELECT (CURRENT_TIMESTAMP AT TIME ZONE $1)::DATE AS event_day`, [timezone]
      );
      const event_day = dayRows[0].event_day;

      // 3. Buscar registro — FOR UPDATE serializa escaneos simultáneos del mismo QR (P-6)
      const regRes = await client.query(
        `SELECT r.id, r.status, r.ticket_type, a.name, a.email
         FROM events.registrations r
         JOIN events.attendees a ON a.id = r.attendee_id
         WHERE r.qr_token = $1 AND r.event_id = $2
         FOR UPDATE`,
        [qr_token.trim(), req.params.eventId]
      );
      if (!regRes.rows[0]) {
        const err = new Error('QR no válido para este evento'); err.httpStatus = 404; throw err;
      }
      const reg = regRes.rows[0];

      if (reg.status === 'cancelled') {
        const err = new Error('Esta inscripción fue cancelada');
        err.httpStatus = 409; err.code = 'CANCELLED'; throw err;
      }

      // 4. Verificar check-in del día (P-1 multi-día: una fila por día, no por evento)
      const existsRes = await client.query(
        `SELECT id FROM events.registration_checkins
         WHERE registration_id = $1 AND event_day = $2`,
        [reg.id, event_day]
      );
      if (existsRes.rows[0]) {
        const err = new Error('Ya registró su llegada hoy');
        err.httpStatus = 409; err.code = 'ALREADY_CHECKED_IN'; err.attendee_name = reg.name; throw err;
      }

      // 5. Registrar check-in (P-1: en registration_checkins, no en registrations)
      // checked_in_by = staff UUID si aplica (null para organizer CMS)
      const checkedInBy = req.staff.staff_id || null;
      await client.query(
        `INSERT INTO events.registration_checkins (registration_id, event_id, event_day, checked_in_by)
         VALUES ($1, $2, $3, $4)`,
        [reg.id, req.params.eventId, event_day, checkedInBy]
      );

      // 6. Auto-confirmar si estaba pendiente
      let finalStatus = reg.status;
      if (reg.status === 'pending') {
        await client.query(
          `UPDATE events.registrations SET status = 'confirmed' WHERE id = $1`, [reg.id]
        );
        finalStatus = 'confirmed';
      }

      return { registration_id: reg.id, name: reg.name, email: reg.email,
               ticket_type: reg.ticket_type, status: finalStatus, event_day };
    });

    const ms = Date.now() - t0;

    global.io?.to(`event_${req.params.eventId}`).emit('attendee.checkin', {
      event_id: req.params.eventId, event_day: result.event_day, ms_response: ms,
    });
    global.io?.to(`event_checkin_${req.params.eventId}`).emit('attendee.checkin', {
      name: result.name, ticket_type: result.ticket_type, event_day: result.event_day,
    });

    res.json({ ok: true, ...result, ms });
  } catch (err) {
    if (err.httpStatus) {
      return res.status(err.httpStatus).json({
        error: err.message, code: err.code || null,
        attendee_name: err.attendee_name || null,
      });
    }
    // Backstop: UNIQUE constraint en registration_checkins dispara 23505
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ya registró su llegada hoy', code: 'ALREADY_CHECKED_IN' });
    }
    console.error('❌ POST /api/events/staff/:id/checkin:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── CHECK-OUT (opcional — para re-entrada) ─────────────────────────────────────
// POST /api/events/staff/:eventId/checkout
// Body: { qr_token }
router.post('/:eventId/checkout', authenticateEventStaff, async (req, res) => {
  const pool = global.pool;
  const { qr_token } = req.body;
  if (!qr_token?.trim()) return res.status(400).json({ error: 'qr_token requerido' });

  try {
    const evRes = await pool.query(
      `SELECT timezone FROM events.events WHERE id = $1`, [req.params.eventId]
    );
    if (!evRes.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows: dayRows } = await pool.query(
      `SELECT (CURRENT_TIMESTAMP AT TIME ZONE $1)::DATE AS event_day`, [evRes.rows[0].timezone]
    );
    const event_day = dayRows[0].event_day;

    const { rowCount } = await pool.query(
      `UPDATE events.registration_checkins c
       SET checked_out_at = NOW()
       FROM events.registrations r
       WHERE c.registration_id = r.id
         AND r.qr_token = $1 AND r.event_id = $2
         AND c.event_day = $3 AND c.checked_out_at IS NULL`,
      [qr_token.trim(), req.params.eventId, event_day]
    );
    if (!rowCount) return res.status(404).json({ error: 'Check-in de hoy no encontrado' });
    res.json({ ok: true, event_day });
  } catch (err) {
    console.error('❌ POST /api/events/staff/:id/checkout:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── REDEMPTION DE SERVICIO ─────────────────────────────────────────────────────
// POST /api/events/staff/:eventId/redeem
// Body: { qr_token, service_type }
// P-3: withTransaction | UNIQUE backstop (registration_id, service_type, event_day)
router.post('/:eventId/redeem', redeemLimiter, authenticateEventStaff, async (req, res) => {
  const pool = global.pool;
  const { qr_token, service_type } = req.body;
  if (!qr_token?.trim() || !service_type?.trim()) {
    return res.status(400).json({ error: 'qr_token y service_type requeridos' });
  }

  try {
    const result = await withTransaction(pool, async (client) => {
      const evRes = await client.query(
        `SELECT timezone FROM events.events WHERE id = $1`, [req.params.eventId]
      );
      if (!evRes.rows[0]) {
        const err = new Error('Evento no encontrado'); err.httpStatus = 404; throw err;
      }
      const { rows: dayRows } = await client.query(
        `SELECT (CURRENT_TIMESTAMP AT TIME ZONE $1)::DATE AS event_day`, [evRes.rows[0].timezone]
      );
      const event_day = dayRows[0].event_day;

      const regRes = await client.query(
        `SELECT r.id, r.status, a.name
         FROM events.registrations r
         JOIN events.attendees a ON a.id = r.attendee_id
         WHERE r.qr_token = $1 AND r.event_id = $2
         FOR UPDATE`,
        [qr_token.trim(), req.params.eventId]
      );
      if (!regRes.rows[0]) {
        const err = new Error('QR no válido para este evento'); err.httpStatus = 404; throw err;
      }
      const reg = regRes.rows[0];

      if (reg.status === 'cancelled') {
        const err = new Error('Inscripción cancelada'); err.httpStatus = 409; err.code = 'CANCELLED'; throw err;
      }

      // service_redemptions no tiene event_day — la unicidad del día se valida
      // comparando redeemed_at en la TZ del evento
      const existsRes = await client.query(
        `SELECT id FROM events.service_redemptions
         WHERE registration_id = $1
           AND service_type    = $2
           AND (redeemed_at AT TIME ZONE $3)::DATE = $4`,
        [reg.id, service_type.trim(), evRes.rows[0].timezone, event_day]
      );
      if (existsRes.rows[0]) {
        const err = new Error(`${service_type} ya fue redimido hoy`);
        err.httpStatus = 409; err.code = 'ALREADY_REDEEMED'; throw err;
      }

      const redeemedBy = req.staff.staff_id || null;
      await client.query(
        `INSERT INTO events.service_redemptions
           (registration_id, event_id, user_id, service_type, redeemed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [reg.id, req.params.eventId, req.staff.user_id, service_type.trim(), redeemedBy]
      );

      return { registration_id: reg.id, name: reg.name, service_type: service_type.trim(), event_day };
    });

    global.io?.to(`event_${req.params.eventId}`).emit('service.redeemed', {
      event_id: req.params.eventId, service_type: result.service_type, event_day: result.event_day,
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.httpStatus) {
      if (err.code) {
        global.io?.to(`event_${req.params.eventId}`).emit('service.redeem_rejected', {
          event_id: req.params.eventId, service_type, code: err.code,
        });
      }
      return res.status(err.httpStatus).json({ error: err.message, code: err.code || null });
    }
    if (err.code === '23505') {
      return res.status(409).json({ error: `${service_type} ya fue redimido hoy`, code: 'ALREADY_REDEEMED' });
    }
    console.error('❌ POST /api/events/staff/:id/redeem:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
