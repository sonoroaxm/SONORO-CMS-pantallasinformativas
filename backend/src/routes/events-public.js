// Events v1 — Rutas públicas (registro de asistentes, lookup QR)
// Sin auth — rate limits propios por endpoint
// P-1: registrations sin checked_in_at | P-3: upsert+insert en withTransaction
// P-4: qr_token UUID permanente | P-5: timezone del evento
// Fase: E1

'use strict';
const express    = require('express');
const router     = express.Router();
const rateLimit  = require('express-rate-limit');
const { withTransaction } = require('../db/withTransaction');
const { sendEventRegistrationEmail, sendEventPendingEmail } = require('../services/email');

const eventPublicReadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes' },
});

const eventRegistrationLimiter = rateLimit({
  windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos de registro, reintenta en un momento' },
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ module: 'events-public', status: 'ok', phase: 'E1' });
});

// ── DATOS DEL EVENTO (para formulario público) ────────────────────────────────
router.get('/:slug', eventPublicReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, status, starts_at, ends_at, timezone,
              venue_name, venue_address, cover_image_url, config
       FROM events.events
       WHERE slug = $1 AND status IN ('published','live')`,
      [req.params.slug]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Evento no encontrado o no disponible' });
    const event = rows[0];

    const { rows: sessions } = await pool.query(
      `SELECT id, name, description, session_type, venue_zone, starts_at, ends_at,
              capacity, requires_registration,
              (SELECT COUNT(*) FROM events.registration_sessions rs WHERE rs.session_id = es.id) AS registered_count
       FROM events.event_sessions es
       WHERE event_id = $1 AND status != 'cancelled'
       ORDER BY starts_at`,
      [event.id]
    );
    event.sessions = sessions;
    res.json(event);
  } catch (err) {
    console.error('❌ GET /api/events/public/:slug:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── REGISTRO PÚBLICO ──────────────────────────────────────────────────────────
router.post('/:slug/register', eventRegistrationLimiter, async (req, res) => {
  const pool = global.pool;
  const {
    name, email, phone, id_number, id_type = 'CC',
    organization, job_title,
    ticket_type = 'general',
    session_ids = [],
    custom_fields = {},
    hp_field = '',
    accepted_terms,
  } = req.body;

  // Anti-bot: honeypot
  if (hp_field !== '') {
    global.io?.emit('registration.honeypot', { ip_hash: hashIp(req.ip), slug: req.params.slug });
    return res.status(400).json({ error: 'Error de validación' });
  }
  // Anti-bot: tiempo mínimo de llenado
  const formStartedAt = req.headers['x-form-started-at'];
  if (formStartedAt && Date.now() - parseInt(formStartedAt) < 3000) {
    return res.status(400).json({ error: 'Formulario enviado demasiado rápido' });
  }

  if (!name?.trim())                           return res.status(400).json({ error: 'El nombre es requerido' });
  if (!email?.trim())                          return res.status(400).json({ error: 'El email es requerido' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email inválido' });
  if (!accepted_terms)                         return res.status(400).json({ error: 'Debes aceptar los términos' });

  try {
    const { rows: evRows } = await pool.query(
      `SELECT id, name, slug, user_id, timezone, starts_at, ends_at, venue_name, config
       FROM events.events WHERE slug = $1 AND status IN ('published','live')`,
      [req.params.slug]
    );
    if (!evRows[0]) return res.status(404).json({ error: 'Evento no encontrado o no disponible' });
    const event = evRows[0];

    // Verificar capacidad máxima (si aplica)
    const maxCap = event.config?.max_capacity;
    if (maxCap) {
      const { rows: cap } = await pool.query(
        `SELECT COUNT(*) FROM events.registrations WHERE event_id = $1 AND status != 'cancelled'`,
        [event.id]
      );
      if (parseInt(cap[0].count) >= maxCap) {
        return res.status(409).json({ error: 'El evento ha alcanzado su capacidad máxima' });
      }
    }

    const cleanEmail   = email.toLowerCase().trim();
    const autoConfirm  = event.config?.auto_confirm === true;

    // P-3: toda la operación en una transacción
    const { registration, isNew } = await withTransaction(pool, async (client) => {
      // Upsert attendee — CRM persistente por tenant (P-2: user_id del organizador)
      const attRes = await client.query(
        `INSERT INTO events.attendees
           (user_id, email, name, phone, id_number, id_type, organization, job_title)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (user_id, email) DO UPDATE SET
           name         = EXCLUDED.name,
           phone        = COALESCE(EXCLUDED.phone,        events.attendees.phone),
           id_number    = COALESCE(EXCLUDED.id_number,    events.attendees.id_number),
           organization = COALESCE(EXCLUDED.organization, events.attendees.organization),
           job_title    = COALESCE(EXCLUDED.job_title,    events.attendees.job_title),
           updated_at   = NOW()
         RETURNING id`,
        [event.user_id, cleanEmail, name.trim(), phone || null,
         id_number || null, id_type, organization || null, job_title || null]
      );
      const attendee_id = attRes.rows[0].id;

      // Insert registration — UNIQUE(event_id, attendee_id) evita doble registro
      // P-1: NO hay checked_in_at — presencia se registra en registration_checkins
      const regRes = await client.query(
        `INSERT INTO events.registrations
           (event_id, attendee_id, user_id, ticket_type, origin, custom_fields, accepted_terms, status)
         VALUES ($1,$2,$3,$4,'web_form',$5,TRUE,$6)
         ON CONFLICT (event_id, attendee_id) DO NOTHING
         RETURNING id, qr_token, ticket_type, status`,
        [event.id, attendee_id, event.user_id, ticket_type, JSON.stringify(custom_fields),
         autoConfirm ? 'confirmed' : 'pending']
      );

      if (!regRes.rows[0]) {
        // Ya registrado — devolver registro existente para manejo 409
        const existing = await client.query(
          `SELECT id, qr_token, ticket_type FROM events.registrations
           WHERE event_id = $1 AND attendee_id = $2`,
          [event.id, attendee_id]
        );
        return { registration: existing.rows[0], isNew: false };
      }

      const reg = regRes.rows[0];

      // Insert sesiones seleccionadas
      for (const sid of session_ids) {
        await client.query(
          `INSERT INTO events.registration_sessions (registration_id, session_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [reg.id, sid]
        );
      }

      return { registration: reg, isNew: true };
    });

    if (!isNew) {
      return res.status(409).json({ error: 'Ya existe un registro para este email en este evento' });
    }

    // Email — async, no bloquea la respuesta
    // auto_confirm=true → correo de confirmación con QR
    // auto_confirm=false → correo de inscripción pendiente (QR llega al confirmar)
    if (autoConfirm) {
      sendEventRegistrationEmail(
        { name: name.trim(), email: cleanEmail },
        event,
        registration
      ).catch(e => console.error('⚠️ Email confirmación evento fallido:', e.message));
    } else {
      sendEventPendingEmail(
        { name: name.trim(), email: cleanEmail },
        event
      ).catch(e => console.error('⚠️ Email inscripción pendiente fallido:', e.message));
    }

    // Telemetría: emit al dashboard de producción (si ya está abierto)
    global.io?.to(`event_${event.id}`).emit('attendee.registered', {
      user_id: event.user_id, event_id: event.id,
      origin: 'web_form', session_count: session_ids.length,
    });

    res.status(201).json({
      registration_id: registration.id,
      qr_token:        registration.qr_token,
      email_sent:      true,
    });
  } catch (err) {
    console.error('❌ POST /api/events/public/:slug/register:', err);
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── LOOKUP POR QR TOKEN ───────────────────────────────────────────────────────
// Política de visibilidad pública: solo nombre, email, ticket, sesiones — sin cédula/teléfono
router.get('/:slug/registration/:qr', eventPublicReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.qr_token, r.ticket_type, r.status, r.created_at,
              a.name, a.email,
              (SELECT json_agg(json_build_object(
                 'id',         s.id,
                 'name',       s.name,
                 'venue_zone', s.venue_zone,
                 'starts_at',  s.starts_at))
               FROM events.registration_sessions rs
               JOIN events.event_sessions s ON s.id = rs.session_id
               WHERE rs.registration_id = r.id) AS sessions
       FROM events.registrations r
       JOIN events.attendees a     ON a.id = r.attendee_id
       JOIN events.events    e     ON e.id = r.event_id
       WHERE r.qr_token = $1 AND e.slug = $2`,
      [req.params.qr, req.params.slug]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Registro no encontrado' });
    const { id, qr_token, ticket_type, status, created_at, name, email, sessions } = rows[0];
    res.json({ id, qr_token, ticket_type, status, created_at, name, email, sessions });
  } catch (err) {
    console.error('❌ GET /api/events/public/:slug/registration/:qr:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

function hashIp(ip) {
  // Simple non-crypto hash para telemetría sin almacenar IP real
  let h = 0;
  for (let i = 0; i < (ip || '').length; i++) h = (Math.imul(31, h) + ip.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16);
}

module.exports = router;
