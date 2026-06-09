// Events v1 — Rutas autenticadas (organizador / productor)
// P-2: todo filtro incluye user_id | P-3: mutaciones ≥2 tablas usan withTransaction
// Fase: E2

'use strict';
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const { withTransaction } = require('../db/withTransaction');
const { sendEventRegistrationEmail } = require('../services/email');

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

// ── CATÁLOGO DE PROVEEDORES (tenant) ─────────────────────────────────────────
// NOTA: estas rutas deben estar ANTES de /:id para no ser capturadas por ese handler

router.get('/suppliers', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM events.suppliers WHERE user_id = $1 ORDER BY name`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /suppliers:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/suppliers', auth, async (req, res) => {
  const pool = global.pool;
  const { name, category, contact_name, contact_email, contact_phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO events.suppliers (user_id, name, category, contact_name, contact_email, contact_phone, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, name.trim(), category || null, contact_name || null,
       contact_email || null, contact_phone || null, notes || null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ POST /suppliers:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/suppliers/:supId', auth, async (req, res) => {
  const pool = global.pool;
  const { name, category, contact_name, contact_email, contact_phone, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE events.suppliers SET
         name          = COALESCE($1, name),
         category      = COALESCE($2, category),
         contact_name  = COALESCE($3, contact_name),
         contact_email = COALESCE($4, contact_email),
         contact_phone = COALESCE($5, contact_phone),
         notes         = COALESCE($6, notes)
       WHERE id = $7 AND user_id = $8 RETURNING *`,
      [name || null, category || null, contact_name || null,
       contact_email || null, contact_phone || null, notes || null,
       req.params.supId, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ PATCH /suppliers/:supId:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.delete('/suppliers/:supId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM events.event_suppliers WHERE supplier_id = $1`,
      [req.params.supId]
    );
    if (parseInt(rows[0].count) > 0) {
      return res.status(400).json({ error: 'Proveedor en uso por uno o más eventos. Desvincula primero.' });
    }
    await pool.query(
      `DELETE FROM events.suppliers WHERE id = $1 AND user_id = $2`,
      [req.params.supId, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ DELETE /suppliers/:supId:', err);
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
  const hasConfigPatch = req.body.config_patch !== undefined;
  if (!fields.length && !hasConfigPatch) return res.status(400).json({ error: 'Nada que actualizar' });

  const params = fields.map(f => f === 'config' ? JSON.stringify(req.body[f]) : req.body[f]);
  const sets   = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  // config_patch merges into existing config JSONB via ||
  if (hasConfigPatch) {
    params.push(JSON.stringify(req.body.config_patch));
    const pIdx = params.length;
    const configSet = `config = COALESCE(config, '{}'::jsonb) || $${pIdx}::jsonb`;
    const allSets = [sets, configSet].filter(Boolean).join(', ');
    params.push(req.params.id);
    let where = `id = $${params.length}`;
    if (!isAdmin) { params.push(req.user.id); where += ` AND user_id = $${params.length}`; }
    try {
      const { rows } = await pool.query(
        `UPDATE events.events SET ${allSets}, updated_at = NOW() WHERE ${where} RETURNING *`,
        params
      );
      if (!rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
      return res.json(rows[0]);
    } catch (err) {
      console.error('❌ PATCH /api/events/:id (config_patch):', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  }
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
        `SELECT r.id, r.qr_token, r.ticket_type, r.status, r.origin, r.created_at AS registered_at,
                r.custom_fields,
                a.name AS attendee_name, a.email, a.phone, a.id_number, a.organization, a.job_title,
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
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed,
                COUNT(*) FILTER (WHERE status = 'pending')   AS pending
         FROM events.registrations WHERE event_id = $1`,
        [req.params.id]
      ),
    ]);
    const counts = countRes.rows[0];
    res.json({
      registrations: dataRes.rows,
      total:     parseInt(counts.total),
      confirmed: parseInt(counts.confirmed),
      pending:   parseInt(counts.pending),
      page, limit
    });
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

// ── LISTAR STAFF ──────────────────────────────────────────────────────────────
router.get('/:id/staff', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const ev = await pool.query('SELECT id FROM events.events WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!ev.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, role, pin, created_at
       FROM events.event_staff
       WHERE event_id = $1 AND user_id = $2
       ORDER BY role, name`,
      [req.params.id, req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CREAR STAFF ───────────────────────────────────────────────────────────────
const VALID_STAFF_ROLES = ['coordinator','registration','tech','host','security','catering','artistic_entertainment','other'];

router.post('/:id/staff', auth, async (req, res) => {
  const pool = global.pool;
  const { name, email, phone, role, pin } = req.body;
  if (!name || !role) return res.status(400).json({ error: 'name y role son requeridos' });
  if (!VALID_STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'rol inválido' });
  const staffPin = pin ? String(pin).replace(/\D/g, '').slice(0, 6).padStart(6, '0')
                       : String(Math.floor(100000 + Math.random() * 900000));
  try {
    const ev = await pool.query('SELECT id FROM events.events WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!ev.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows } = await pool.query(
      `INSERT INTO events.event_staff (event_id, user_id, name, email, phone, role, pin)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, email, phone, role, pin, created_at`,
      [req.params.id, req.user.id, name.trim(), email||null, phone||null, role, staffPin]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ELIMINAR STAFF ────────────────────────────────────────────────────────────
router.delete('/:id/staff/:staffId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM events.event_staff WHERE id=$1 AND event_id=$2 AND user_id=$3`,
      [req.params.staffId, req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Staff no encontrado' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CONFIRMAR / RECHAZAR REGISTRO ─────────────────────────────────────────────
router.patch('/:id/registrations/:regId/status', auth, async (req, res) => {
  const pool = global.pool;
  const { status } = req.body;
  if (!['confirmed','pending','cancelled'].includes(status)) {
    return res.status(400).json({ error: 'status inválido' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE events.registrations r SET status = $1
       FROM events.events e
       WHERE r.id = $2 AND r.event_id = e.id AND e.user_id = $3
       RETURNING r.id, r.status, r.qr_token, r.ticket_type, r.event_id`,
      [status, req.params.regId, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Registro no encontrado' });

    if (status === 'confirmed') {
      // Enviar correo de confirmación con QR al asistente
      pool.query(
        `SELECT a.name, a.email,
                e.name AS event_name, e.slug, e.starts_at, e.ends_at, e.venue_name, e.timezone
         FROM events.registrations r
         JOIN events.attendees a ON a.id = r.attendee_id
         JOIN events.events    e ON e.id = r.event_id
         WHERE r.id = $1`,
        [req.params.regId]
      ).then(({ rows: d }) => {
        if (!d[0]) return;
        sendEventRegistrationEmail(
          { name: d[0].name, email: d[0].email },
          { name: d[0].event_name, slug: d[0].slug, starts_at: d[0].starts_at, ends_at: d[0].ends_at, venue_name: d[0].venue_name, timezone: d[0].timezone },
          { qr_token: rows[0].qr_token, ticket_type: rows[0].ticket_type }
        ).catch(e => console.error('⚠️ Email confirmación manual fallido:', e.message));
      }).catch(e => console.error('⚠️ Query para email confirmación fallida:', e.message));
    }

    res.json({ id: rows[0].id, status: rows[0].status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STATS EN TIEMPO REAL ──────────────────────────────────────────────────────
router.get('/:id/stats/live', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const evRes = await pool.query(
      `SELECT id, timezone FROM events.events
       WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evRes.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    const { timezone } = evRes.rows[0];

    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM events.registrations
          WHERE event_id = $1 AND status != 'cancelled')::int        AS total,
         (SELECT COUNT(*) FROM events.registrations
          WHERE event_id = $1 AND status = 'confirmed')::int         AS confirmed,
         (SELECT COUNT(*) FROM events.registrations
          WHERE event_id = $1 AND status = 'pending')::int           AS pending,
         (SELECT COUNT(DISTINCT registration_id)
          FROM events.registration_checkins
          WHERE event_id = $1)::int                                   AS checked_in_total,
         (SELECT COUNT(DISTINCT registration_id)
          FROM events.registration_checkins
          WHERE event_id = $1
            AND event_day = (CURRENT_TIMESTAMP AT TIME ZONE $2)::DATE)::int AS checked_in_today,
         (CURRENT_TIMESTAMP AT TIME ZONE $2)::DATE::text              AS event_day`,
      [req.params.id, timezone]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ GET /api/events/:id/stats/live:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── ELIMINAR REGISTRO (permanente) ────────────────────────────────────────────
router.delete('/:id/registrations/:regId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM events.registrations r
       USING events.events e
       WHERE r.id = $1 AND r.event_id = e.id AND e.user_id = $2`,
      [req.params.regId, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Registro no encontrado' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RESOLVER SLUG → EVENTO (autenticado, todos los estados) ──────────────────
router.get('/by-slug/:slug', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, status, starts_at, ends_at, timezone,
              venue_name, venue_address, config, user_id
       FROM events.events
       WHERE slug = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.slug] : [req.params.slug, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ GET /api/events/by-slug/:slug:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── DASHBOARD DE PRODUCCIÓN (snapshot completo) ───────────────────────────────
router.get('/:id/dashboard', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const evRes = await pool.query(
      `SELECT id, name, slug, status, starts_at, ends_at, timezone, venue_name, venue_address, config
       FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evRes.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    const event    = evRes.rows[0];
    const { timezone } = event;

    const [statsRes, sessionsRes, checkinsRes] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT COUNT(*) FROM events.registrations WHERE event_id=$1 AND status!='cancelled')::int AS total,
           (SELECT COUNT(*) FROM events.registrations WHERE event_id=$1 AND status='confirmed')::int  AS confirmed,
           (SELECT COUNT(*) FROM events.registrations WHERE event_id=$1 AND status='pending')::int    AS pending,
           (SELECT COUNT(DISTINCT registration_id) FROM events.registration_checkins
            WHERE event_id=$1)::int AS checked_in_total,
           (SELECT COUNT(DISTINCT registration_id) FROM events.registration_checkins
            WHERE event_id=$1
              AND event_day=(CURRENT_TIMESTAMP AT TIME ZONE $2)::DATE)::int AS checked_in_today,
           (CURRENT_TIMESTAMP AT TIME ZONE $2)::DATE::text AS event_day`,
        [req.params.id, timezone]
      ),
      pool.query(
        `SELECT s.id, s.name, s.session_type, s.venue_zone, s.starts_at, s.ends_at,
                s.capacity, s.status, s.description,
                COUNT(DISTINCT rs.registration_id)::int AS registered_count
         FROM events.event_sessions s
         LEFT JOIN events.registration_sessions rs ON rs.session_id = s.id
         WHERE s.event_id = $1 AND s.status != 'cancelled'
         GROUP BY s.id ORDER BY s.starts_at`,
        [req.params.id]
      ),
      pool.query(
        `SELECT a.name AS attendee_name, c.checked_in_at, c.event_day::text
         FROM events.registration_checkins c
         JOIN events.registrations r ON r.id = c.registration_id
         JOIN events.attendees a ON a.id = r.attendee_id
         WHERE c.event_id = $1
         ORDER BY c.checked_in_at DESC LIMIT 20`,
        [req.params.id]
      ),
    ]);

    res.json({
      event,
      stats:           statsRes.rows[0],
      sessions:        sessionsRes.rows,
      recent_checkins: checkinsRes.rows,
    });
  } catch (err) {
    console.error('❌ GET /api/events/:id/dashboard:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── ÚLTIMOS CHECK-INS (feed tiempo real) ──────────────────────────────────────
router.get('/:id/checkins/recent', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  try {
    const evCheck = await pool.query(
      `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evCheck.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows } = await pool.query(
      `SELECT a.name AS attendee_name, c.checked_in_at, c.event_day::text
       FROM events.registration_checkins c
       JOIN events.registrations r ON r.id = c.registration_id
       JOIN events.attendees a ON a.id = r.attendee_id
       WHERE c.event_id = $1
       ORDER BY c.checked_in_at DESC LIMIT $2`,
      [req.params.id, limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /api/events/:id/checkins/recent:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── ACTUALIZAR ESTADO DE SESIÓN ───────────────────────────────────────────────
router.patch('/:id/sessions/:sessionId/status', auth, async (req, res) => {
  const pool = global.pool;
  const { status } = req.body;
  const VALID = ['scheduled', 'in_progress', 'done', 'cancelled'];
  if (!VALID.includes(status)) return res.status(400).json({ error: 'status inválido' });
  const isAdmin = req.user.role === 'admin';
  try {
    const evCheck = await pool.query(
      `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evCheck.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows } = await pool.query(
      `UPDATE events.event_sessions SET status = $1
       WHERE id = $2 AND event_id = $3
       RETURNING id, name, status, starts_at, ends_at`,
      [status, req.params.sessionId, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Sesión no encontrada' });
    global.io?.to(`event_${req.params.id}`).emit('session.status_changed', {
      session_id: rows[0].id, name: rows[0].name, status, event_id: req.params.id,
    });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ PATCH /api/events/:id/sessions/:sessionId/status:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── BROADCAST A PANTALLAS ─────────────────────────────────────────────────────
router.post('/:id/screen-message', auth, async (req, res) => {
  const pool = global.pool;
  const { message, type = 'info' } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message requerido' });
  const VALID_TYPES = ['info', 'alert', 'custom'];
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'type inválido' });
  const isAdmin = req.user.role === 'admin';
  const evCheck = await pool.query(
    `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
    isAdmin ? [req.params.id] : [req.params.id, req.user.id]
  );
  if (!evCheck.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
  const payload = { event_id: req.params.id, message: message.trim(), type, sent_at: new Date().toISOString() };
  global.io?.to(`event_screen_${req.params.id}`).emit('screen.broadcast', payload);
  global.io?.to(`event_${req.params.id}`).emit('screen.broadcast', payload);
  console.log(`📡 Screen broadcast event_${req.params.id}: [${type}] ${message.slice(0, 60)}`);
  res.json({ ok: true, sent_at: payload.sent_at });
});

// ── PROVEEDORES DEL EVENTO ────────────────────────────────────────────────────
// Schema real: event_suppliers.supplier_id NOT NULL (FK), payment_status, service_description

router.get('/:id/suppliers', auth, async (req, res) => {
  const pool = global.pool;
  const { id } = req.params;
  const isAdmin = req.user.role === 'admin';
  const params = isAdmin ? [id] : [id, req.user.id];
  const ownerFilter = isAdmin ? '' : 'AND es.user_id = $2';
  try {
    const { rows } = await pool.query(
      `SELECT es.id, es.supplier_id, es.service_description, es.contracted_amount,
              es.currency, es.arrival_at, es.departure_at, es.payment_status, es.notes,
              s.name AS supplier_name, s.category, s.contact_name, s.contact_email, s.contact_phone
       FROM events.event_suppliers es
       JOIN events.suppliers s ON s.id = es.supplier_id
       WHERE es.event_id = $1 ${ownerFilter}
       ORDER BY s.name`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /:id/suppliers:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/:id/suppliers', auth, async (req, res) => {
  const pool = global.pool;
  const { id } = req.params;
  const { supplier_id, service_description, contracted_amount, payment_status, notes } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'supplier_id requerido' });
  try {
    const evCheck = await pool.query(
      `SELECT id FROM events.events WHERE id = $1 ${req.user.role !== 'admin' ? 'AND user_id = $2' : ''}`,
      req.user.role !== 'admin' ? [id, req.user.id] : [id]
    );
    if (!evCheck.rowCount) return res.status(403).json({ error: 'Acceso denegado' });
    const { rows } = await pool.query(
      `INSERT INTO events.event_suppliers
         (event_id, user_id, supplier_id, service_description, contracted_amount, payment_status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, req.user.id, supplier_id,
       service_description || null, contracted_amount || 0,
       payment_status || 'pending', notes || null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ POST /:id/suppliers:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/:id/suppliers/:contractId', auth, async (req, res) => {
  const pool = global.pool;
  const { id, contractId } = req.params;
  const { service_description, contracted_amount, payment_status, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE events.event_suppliers SET
         service_description = COALESCE($1, service_description),
         contracted_amount   = COALESCE($2, contracted_amount),
         payment_status      = COALESCE($3, payment_status),
         notes               = COALESCE($4, notes)
       WHERE id = $5 AND event_id = $6 AND user_id = $7 RETURNING *`,
      [service_description ?? null,
       contracted_amount != null ? contracted_amount : null,
       payment_status || null, notes ?? null,
       contractId, id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Contrato no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ PATCH /:id/suppliers/:contractId:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.delete('/:id/suppliers/:contractId', auth, async (req, res) => {
  const pool = global.pool;
  const { id, contractId } = req.params;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM events.event_suppliers WHERE id = $1 AND event_id = $2 AND user_id = $3`,
      [contractId, id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Contrato no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ DELETE /:id/suppliers/:contractId:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/:id/budget', auth, async (req, res) => {
  const pool = global.pool;
  const { id } = req.params;
  const isAdmin = req.user.role === 'admin';
  try {
    const [eventR, suppliersR] = await Promise.all([
      pool.query(
        `SELECT config FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
        isAdmin ? [id] : [id, req.user.id]
      ),
      pool.query(
        `SELECT payment_status, SUM(contracted_amount)::NUMERIC AS total
         FROM events.event_suppliers WHERE event_id = $1 AND user_id = $2
         GROUP BY payment_status`,
        [id, req.user.id]
      )
    ]);
    if (!eventR.rowCount) return res.status(403).json({ error: 'Acceso denegado' });
    const total_budget = parseFloat(eventR.rows[0]?.config?.total_budget || 0);
    const breakdown = {};
    let committed = 0;
    let total_contracted = 0;
    for (const row of suppliersR.rows) {
      breakdown[row.payment_status] = parseFloat(row.total);
      total_contracted += parseFloat(row.total);
      if (['partial', 'paid'].includes(row.payment_status)) committed += parseFloat(row.total);
    }
    res.json({ total_budget, total_contracted, committed, breakdown });
  } catch (err) {
    console.error('❌ GET /:id/budget:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
