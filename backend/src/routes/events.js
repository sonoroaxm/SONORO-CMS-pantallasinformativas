// Events v1 — Rutas autenticadas (organizador / productor)
// P-2: todo filtro incluye user_id | P-3: mutaciones ≥2 tablas usan withTransaction
// Fase: E1

'use strict';
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const { withTransaction } = require('../db/withTransaction');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
}

function buildSlug(name) {
  const base = name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 54);
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

// Parser CSV sin dependencia externa — soporta campos entre comillas
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const parseLine = (line) => {
    const vals = [];
    let cur = '', inQ = false;
    for (const ch of line + ',') {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    return vals;
  };
  const headers = parseLine(lines[0]).map(h => h.toLowerCase());
  return lines.slice(1).map(line => {
    const vals = parseLine(line);
    if (vals.every(v => !v)) return null;
    const row = {};
    headers.forEach((h, i) => row[h] = vals[i] || '');
    return row;
  }).filter(Boolean);
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ module: 'events', status: 'ok', phase: 'E1' });
});

// ── LISTAR EVENTOS ────────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const q = `SELECT e.id, e.name, e.slug, e.status, e.starts_at, e.ends_at, e.timezone,
                      e.venue_name, e.cover_image_url, e.created_at,
                      COUNT(r.id) FILTER (WHERE r.status != 'cancelled') AS registration_count
               FROM events.events e
               LEFT JOIN events.registrations r ON r.event_id = e.id
               ${isAdmin ? '' : 'WHERE e.user_id = $1'}
               GROUP BY e.id ORDER BY e.starts_at DESC`;
    const { rows } = await pool.query(q, isAdmin ? [] : [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /api/events:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── OBTENER EVENTO ────────────────────────────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const params = isAdmin ? [req.params.id] : [req.params.id, req.user.id];
  const where  = isAdmin ? 'e.id = $1' : 'e.id = $1 AND e.user_id = $2';
  try {
    const { rows } = await pool.query(
      `SELECT e.*,
              (SELECT json_agg(s ORDER BY s.starts_at)
               FROM events.event_sessions s WHERE s.event_id = e.id) AS sessions,
              (SELECT COUNT(*)
               FROM events.registrations r WHERE r.event_id = e.id AND r.status != 'cancelled') AS registration_count
       FROM events.events e WHERE ${where}`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ GET /api/events/:id:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── CREAR EVENTO ──────────────────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const pool = global.pool;
  const { name, starts_at, ends_at, timezone = 'America/Bogota',
          venue_name, venue_address, cover_image_url, config = {} } = req.body;
  if (!name?.trim() || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'name, starts_at y ends_at son requeridos' });
  }
  const slug = buildSlug(name);
  try {
    const { rows } = await pool.query(
      `INSERT INTO events.events
         (user_id, name, slug, starts_at, ends_at, timezone, venue_name, venue_address, cover_image_url, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.id, name.trim(), slug, starts_at, ends_at, timezone,
       venue_name || null, venue_address || null, cover_image_url || null, JSON.stringify(config)]
    );
    const event = rows[0];
    global.io?.to(`user_${req.user.id}`).emit('event.created', {
      user_id: req.user.id, event_id: event.id, starts_at: event.starts_at
    });
    res.status(201).json(event);
  } catch (err) {
    console.error('❌ POST /api/events:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Slug duplicado, reintenta' });
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── EDITAR EVENTO ─────────────────────────────────────────────────────────────
router.patch('/:id', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const ALLOWED = ['name', 'status', 'starts_at', 'ends_at', 'timezone',
                   'venue_name', 'venue_address', 'cover_image_url', 'config'];
  const fields = ALLOWED.filter(f => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });

  const params = fields.map(f => f === 'config' ? JSON.stringify(req.body[f]) : req.body[f]);
  const sets   = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  params.push(req.params.id);
  let where = `id = $${params.length}`;
  if (!isAdmin) { params.push(req.user.id); where += ` AND user_id = $${params.length}`; }

  try {
    const { rows } = await pool.query(
      `UPDATE events.events SET ${sets}, updated_at = NOW() WHERE ${where} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    if (req.body.status === 'published') {
      global.io?.to(`user_${rows[0].user_id}`).emit('event.published', {
        user_id: rows[0].user_id, event_id: rows[0].id
      });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ PATCH /api/events/:id:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── CREAR SESIÓN ──────────────────────────────────────────────────────────────
router.post('/:id/sessions', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const { name, description, session_type = 'plenary', venue_zone,
          starts_at, ends_at, capacity, requires_registration = false } = req.body;
  if (!name?.trim() || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'name, starts_at y ends_at son requeridos' });
  }
  const evCheck = await pool.query(
    `SELECT id, user_id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
    isAdmin ? [req.params.id] : [req.params.id, req.user.id]
  );
  if (!evCheck.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO events.event_sessions
         (event_id, user_id, name, description, session_type, venue_zone,
          starts_at, ends_at, capacity, requires_registration)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.params.id, evCheck.rows[0].user_id, name.trim(), description || null,
       session_type, venue_zone || null, starts_at, ends_at, capacity || null, requires_registration]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('❌ POST /api/events/:id/sessions:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── LISTAR SESIONES ───────────────────────────────────────────────────────────
router.get('/:id/sessions', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const params = isAdmin ? [req.params.id] : [req.params.id, req.user.id];
  const join   = isAdmin ? '' : 'JOIN events.events e ON e.id = s.event_id AND e.user_id = $2';
  try {
    const { rows } = await pool.query(
      `SELECT s.* FROM events.event_sessions s ${join}
       WHERE s.event_id = $1 ORDER BY s.starts_at`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /api/events/:id/sessions:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── LISTAR REGISTROS ──────────────────────────────────────────────────────────
router.get('/:id/registrations', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const page   = Math.max(parseInt(req.query.page) || 1, 1);
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = (page - 1) * limit;

  const evCheck = await pool.query(
    `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
    isAdmin ? [req.params.id] : [req.params.id, req.user.id]
  );
  if (!evCheck.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });

  try {
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT r.id, r.qr_token, r.ticket_type, r.status, r.origin, r.created_at,
                a.name, a.email, a.phone, a.id_number, a.organization, a.job_title,
                (SELECT json_agg(sess.name)
                 FROM events.registration_sessions rs
                 JOIN events.event_sessions sess ON sess.id = rs.session_id
                 WHERE rs.registration_id = r.id) AS sessions,
                (SELECT json_agg(json_build_object(
                   'event_day', c.event_day::text,
                   'checked_in_at', c.checked_in_at))
                 FROM events.registration_checkins c
                 WHERE c.registration_id = r.id) AS checkins
         FROM events.registrations r
         JOIN events.attendees a ON a.id = r.attendee_id
         WHERE r.event_id = $1
         ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
        [req.params.id, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM events.registrations WHERE event_id = $1`,
        [req.params.id]
      ),
    ]);
    res.json({ data: dataRes.rows, total: parseInt(countRes.rows[0].count), page, limit });
  } catch (err) {
    console.error('❌ GET /api/events/:id/registrations:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── IMPORTAR CSV ──────────────────────────────────────────────────────────────
// Columnas requeridas: nombre,email  |  Opcionales: telefono,cedula,empresa,cargo,tipo_ticket
router.post('/:id/registrations/import', auth, upload.single('file'), async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  if (!req.file) return res.status(400).json({ error: 'Se requiere archivo CSV (campo: file)' });

  const evCheck = await pool.query(
    `SELECT id, user_id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
    isAdmin ? [req.params.id] : [req.params.id, req.user.id]
  );
  if (!evCheck.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
  const userId = evCheck.rows[0].user_id;

  const rows = parseCSV(req.file.buffer.toString('utf-8'));
  let created = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row   = rows[i];
    const name  = (row.nombre  || row.name  || '').trim();
    const email = (row.email   || '').toLowerCase().trim();
    const phone = row.telefono || row.phone      || null;
    const idNum = row.cedula   || row.id_number  || null;
    const org   = row.empresa  || row.organization || null;
    const job   = row.cargo    || row.job_title  || null;
    const ticket = row.tipo_ticket || row.ticket_type || 'general';

    if (!name || !email) { errors.push({ row: i + 2, error: 'nombre y email requeridos' }); continue; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ row: i + 2, error: `email inválido: ${email}` }); continue;
    }

    try {
      // P-3: withTransaction — upsert attendee + insert registration atómicos
      const inserted = await withTransaction(pool, async (client) => {
        const att = await client.query(
          `INSERT INTO events.attendees (user_id, email, name, phone, id_number, organization, job_title)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (user_id, email) DO UPDATE SET
             name         = EXCLUDED.name,
             phone        = COALESCE(EXCLUDED.phone,        events.attendees.phone),
             id_number    = COALESCE(EXCLUDED.id_number,    events.attendees.id_number),
             organization = COALESCE(EXCLUDED.organization, events.attendees.organization),
             job_title    = COALESCE(EXCLUDED.job_title,    events.attendees.job_title),
             updated_at   = NOW()
           RETURNING id`,
          [userId, email, name, phone, idNum, org, job]
        );
        const ins = await client.query(
          `INSERT INTO events.registrations
             (event_id, attendee_id, user_id, ticket_type, origin, accepted_terms)
           VALUES ($1,$2,$3,$4,'import',TRUE)
           ON CONFLICT (event_id, attendee_id) DO NOTHING`,
          [req.params.id, att.rows[0].id, userId, ticket]
        );
        return ins.rowCount; // 1 = creado, 0 = ya existía
      });
      if (inserted > 0) created++; else skipped++;
    } catch (err) {
      errors.push({ row: i + 2, error: err.message });
    }
  }

  global.io?.to(`user_${req.user.id}`).emit('attendee.imported', {
    user_id: req.user.id, event_id: req.params.id, count: created
  });

  res.json({ total: rows.length, created, skipped, errors });
});

module.exports = router;
