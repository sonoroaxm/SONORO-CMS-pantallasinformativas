// Events v1 — Endpoints públicos para Producción y Teleprompter (validados por token UUID)
// Tabla: events.production_tokens — kind in ('produccion','teleprompter')
// Sin auth — el token UUID es el control de acceso, revocable desde el dashboard del organizador.

'use strict';
const express   = require('express');
const router    = express.Router();
const rateLimit = require('express-rate-limit');

const publicLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes' },
});

// ── DASHBOARD DE PRODUCCIÓN (público con token) ───────────────────────────────
router.get('/:slug/produccion', publicLimiter, async (req, res) => {
  const pool = global.pool;
  const token = req.query.t;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { rows: evRows } = await pool.query(
      `SELECT id, slug, name, timezone, starts_at, ends_at, user_id, config, venue_name
       FROM events.events WHERE slug = $1`,
      [req.params.slug]
    );
    if (!evRows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    const event = evRows[0];

    const { rows: tokRows } = await pool.query(
      `SELECT id FROM events.production_tokens
       WHERE token = $1 AND event_id = $2 AND kind = 'produccion' AND revoked_at IS NULL`,
      [token, event.id]
    );
    if (!tokRows[0]) return res.status(403).json({ error: 'Token inválido o revocado' });

    const { rows: sessions } = await pool.query(
      `SELECT s.id, s.name, s.description, s.session_type, s.venue_zone,
              s.starts_at, s.ends_at, s.capacity, s.requires_registration,
              s.status, s.speaker_name, s.assigned_staff_id, s.observations,
              estf.name AS assigned_staff_name,
              (SELECT COUNT(*) FROM events.registration_sessions rs
                 WHERE rs.session_id = s.id) AS registered_count
       FROM events.event_sessions s
       LEFT JOIN events.event_staff estf ON estf.id = s.assigned_staff_id
       WHERE s.event_id = $1 AND s.status != 'cancelled'
       ORDER BY s.starts_at`,
      [event.id]
    );

    const { rows: counts } = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM events.event_suppliers WHERE event_id = $1) AS suppliers_count,
        (SELECT COUNT(*) FROM events.registrations WHERE event_id = $1 AND status != 'cancelled') AS registrations_count`,
      [event.id]
    );

    res.json({
      event: {
        id: event.id, slug: event.slug, name: event.name,
        timezone: event.timezone, starts_at: event.starts_at, ends_at: event.ends_at,
        venue_name: event.venue_name, config: event.config,
      },
      sessions,
      suppliers_count:     parseInt(counts[0].suppliers_count) || 0,
      registrations_count: parseInt(counts[0].registrations_count) || 0,
    });
  } catch (err) {
    console.error('GET /public/:slug/produccion:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── TELEPROMPTER POR SESIÓN (público con token) ───────────────────────────────
router.get('/:slug/orador/:session_id', publicLimiter, async (req, res) => {
  const pool = global.pool;
  const token = req.query.t;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { rows: evRows } = await pool.query(
      `SELECT id, slug, name, timezone FROM events.events WHERE slug = $1`,
      [req.params.slug]
    );
    if (!evRows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    const event = evRows[0];

    const { rows: sessRows } = await pool.query(
      `SELECT id, name, speaker_name, venue_zone, starts_at, ends_at, status, event_id
       FROM events.event_sessions
       WHERE id = $1 AND event_id = $2`,
      [req.params.session_id, event.id]
    );
    if (!sessRows[0]) return res.status(404).json({ error: 'Sesión no encontrada' });
    const session = sessRows[0];

    const { rows: tokRows } = await pool.query(
      `SELECT id FROM events.production_tokens
       WHERE token = $1 AND event_id = $2 AND session_id = $3
         AND kind = 'teleprompter' AND revoked_at IS NULL`,
      [token, event.id, session.id]
    );
    if (!tokRows[0]) return res.status(403).json({ error: 'Token inválido o revocado' });

    const { rows: nextRows } = await pool.query(
      `SELECT name AS title, starts_at, venue_zone AS room
       FROM events.event_sessions
       WHERE event_id = $1 AND starts_at > $2 AND status != 'cancelled'
       ORDER BY starts_at ASC LIMIT 1`,
      [event.id, session.ends_at]
    );

    res.json({
      event: {
        id: event.id, slug: event.slug, name: event.name, timezone: event.timezone,
      },
      session: {
        id: session.id, title: session.name, speaker_name: session.speaker_name,
        starts_at: session.starts_at, ends_at: session.ends_at,
        room: session.venue_zone, status: session.status,
      },
      next_session: nextRows[0] || null,
    });
  } catch (err) {
    console.error('GET /public/:slug/orador/:session_id:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
