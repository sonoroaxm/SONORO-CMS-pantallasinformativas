// Events v1 — Rutas autenticadas (organizador / productor)
// P-2: todo filtro incluye user_id | P-3: mutaciones ≥2 tablas usan withTransaction
// Fase: E2

'use strict';
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const { withTransaction } = require('../db/withTransaction');
const { sendEventRegistrationEmail, sendSupplierQuoteEmail, sendSupplierAcceptedEmail } = require('../services/email');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const path = require('path');
const fs   = require('fs');

function makeDocStorage(subdir) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '../../uploads', subdir);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.pdf';
      const id  = req.params.supId || req.params.contractId || 'file';
      cb(null, id + '-' + Date.now() + ext);
    }
  });
}
const uploadSupplierDoc  = multer({ storage: makeDocStorage('supplier-docs'),  limits: { fileSize: 10 * 1024 * 1024 } });
const uploadPaymentProof = multer({ storage: makeDocStorage('payment-proofs'), limits: { fileSize: 10 * 1024 * 1024 } });

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

// ── SUBIR DOCUMENTOS LEGALES DEL PROVEEDOR ─────────────────────────────
// docType: rut | cert_bancario | camara_comercio
const VALID_DOC_TYPES = ['rut', 'cert_bancario', 'camara_comercio'];
router.post('/suppliers/:supId/documents/:docType', auth, async (req, res) => {
  const pool = global.pool;
  const { supId, docType } = req.params;
  if (!VALID_DOC_TYPES.includes(docType)) return res.status(400).json({ error: 'docType invalido' });
  const docFile = req.files?.document;
  if (!docFile) return res.status(400).json({ error: 'Archivo requerido (campo: document)' });
  if (docFile.size > 10 * 1024 * 1024) return res.status(400).json({ error: 'Archivo demasiado grande (max 10MB)' });
  const colName = docType + '_url';
  const ext = path.extname(docFile.name).toLowerCase() || '.pdf';
  const filename = supId + '-' + docType + '-' + Date.now() + ext;
  const uploadDir = path.join(__dirname, '../../uploads/supplier-docs');
  const filePath  = path.join(uploadDir, filename);
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
    await docFile.mv(filePath);
    const fileUrl = '/uploads/supplier-docs/' + filename;
    const { rows } = await pool.query(
      'UPDATE events.suppliers SET ' + colName + ' = $1 WHERE id = $2 AND user_id = $3 RETURNING id, ' + colName,
      [fileUrl, supId, req.user.id]
    );
    if (!rows[0]) {
      fs.unlink(filePath, () => {});
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    }
    res.json({ ok: true, url: fileUrl });
  } catch (err) {
    console.error('❌ POST /suppliers/:supId/documents:', err);
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
    const tz = evCheck.rows[0].timezone || 'America/Bogota';
    const { rows } = await pool.query(
      `INSERT INTO events.event_sessions
         (event_id, user_id, name, description, session_type, venue_zone,
          starts_at, ends_at, capacity, requires_registration)
       VALUES ($1,$2,$3,$4,$5,$6,
         ($7::timestamp AT TIME ZONE $11),
         ($8::timestamp AT TIME ZONE $11),
         $9,$10) RETURNING *`,
      [req.params.id, evCheck.rows[0].user_id, name.trim(), description || null,
       session_type, venue_zone || null, starts_at, ends_at, capacity || null, requires_registration, tz]
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
      `SELECT s.*, estf.name AS assigned_staff_name
       FROM events.event_sessions s ${join}
       LEFT JOIN events.event_staff estf ON estf.id = s.assigned_staff_id
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
                   'checked_in_at', c.checked_in_at,
                   'session_id', c.session_id,
                   'session_name', sess.name) ORDER BY c.checked_in_at)
                 FROM events.registration_checkins c
                 LEFT JOIN events.event_sessions sess ON sess.id = c.session_id
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
                s.capacity, s.status, s.description, s.assigned_staff_id,
                estf.name AS assigned_staff_name,
                COUNT(DISTINCT rs.registration_id)::int AS registered_count
         FROM events.event_sessions s
         LEFT JOIN events.registration_sessions rs ON rs.session_id = s.id
         LEFT JOIN events.event_staff estf ON estf.id = s.assigned_staff_id
         WHERE s.event_id = $1 AND s.status != 'cancelled'
         GROUP BY s.id, estf.name ORDER BY s.starts_at`,
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
router.patch('/:id/sessions/:sessionId', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const { name, starts_at, ends_at, capacity, venue_zone, description, session_type,
          assigned_staff_id, observations } = req.body;
  try {
    const evCheck = await pool.query(
      `SELECT id, timezone FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evCheck.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const tz = evCheck.rows[0].timezone || 'America/Bogota';
    const { rows } = await pool.query(
      `UPDATE events.event_sessions SET
         name = COALESCE($3, name),
         starts_at = COALESCE(($4::timestamp AT TIME ZONE $9), starts_at),
         ends_at   = COALESCE(($5::timestamp AT TIME ZONE $9), ends_at),
         capacity  = $6,
         venue_zone = COALESCE($7, venue_zone),
         description       = COALESCE($8, description),
         assigned_staff_id = COALESCE($10, assigned_staff_id),
         observations      = COALESCE($11, observations)
       WHERE id = $1 AND event_id = $2 RETURNING *`,
      [req.params.sessionId, req.params.id,
       name?.trim() || null, starts_at || null, ends_at || null,
       capacity !== undefined ? (capacity || null) : undefined,
       venue_zone || null, description || null, tz,
       assigned_staff_id || null, observations || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Sesión no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('\u274C PATCH /sessions/:id:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.delete('/:id/sessions/:sessionId', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const evCheck = await pool.query(
      `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evCheck.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const del = await pool.query(
      'DELETE FROM events.event_sessions WHERE id = $1 AND event_id = $2',
      [req.params.sessionId, req.params.id]
    );
    if (!del.rowCount) return res.status(404).json({ error: 'Sesión no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('\u274C DELETE /sessions/:id:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

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
              es.currency, es.payment_status, es.abono_amount, es.notes,
              es.deposit_amount, es.payment_date, es.payment_proof_url, es.history,
              s.name AS supplier_name, s.category, s.contact_name, s.contact_email, s.contact_phone,
              s.id_type, s.id_number, s.rut_url, s.cert_bancario_url, s.camara_comercio_url,
              sq.status AS quote_status, sq.submitted_at AS quote_submitted_at, sq.id AS quote_id,
              sq.data AS quote_data
       FROM events.event_suppliers es
       JOIN events.suppliers s ON s.id = es.supplier_id
       LEFT JOIN LATERAL (
         SELECT id, status, submitted_at, data FROM events.supplier_quotes
         WHERE event_supplier_id = es.id ORDER BY created_at DESC LIMIT 1
       ) sq ON TRUE
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
       payment_status || 'quote_requested', notes || null]
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
  const { service_description, contracted_amount, payment_status, abono_amount, notes,
          deposit_amount, payment_date, payment_proof_url } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE events.event_suppliers SET
         service_description = COALESCE($1, service_description),
         contracted_amount   = COALESCE($2, contracted_amount),
         payment_status      = COALESCE($3, payment_status),
         abono_amount        = COALESCE($4, abono_amount),
         notes               = COALESCE($5, notes),
         deposit_amount      = COALESCE($6, deposit_amount),
         payment_date        = COALESCE($7, payment_date),
         payment_proof_url   = COALESCE($8, payment_proof_url)
       WHERE id = $9 AND event_id = $10 AND user_id = $11 RETURNING *`,
      [service_description ?? null,
       contracted_amount != null ? contracted_amount : null,
       payment_status || null,
       abono_amount != null ? abono_amount : null,
       notes ?? null,
       deposit_amount != null ? deposit_amount : null,
       payment_date || null,
       payment_proof_url || null,
       contractId, id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Contrato no encontrado' });
    if (['accepted','partial','paid','rejected','cancelled'].includes(payment_status)) {
      const hEntry = JSON.stringify([{ status: payment_status, at: new Date().toISOString(),
        amount: deposit_amount != null ? deposit_amount : (rows[0].contracted_amount ?? null) }]);
      await pool.query(
        `UPDATE events.event_suppliers SET history = COALESCE(history,'[]'::jsonb) || $1::jsonb
         WHERE id = $2 AND event_id = $3 AND user_id = $4`,
        [hEntry, contractId, id, req.user.id]
      );
    }
    if (payment_status === 'accepted' && rows[0].supplier_id) {
      pool.query(
        `SELECT s.name AS supplier_name, s.contact_email, e.name AS event_name
         FROM events.suppliers s
         JOIN events.events e ON e.id = $1
         WHERE s.id = $2 AND s.user_id = $3`,
        [id, rows[0].supplier_id, req.user.id]
      ).then(supR => {
        if (supR.rows[0]?.contact_email) {
          sendSupplierAcceptedEmail({
            supplier_name: supR.rows[0].supplier_name,
            contact_email: supR.rows[0].contact_email,
            event_name:    supR.rows[0].event_name,
            contracted_amount: rows[0].contracted_amount,
          }).catch(e => console.error('⚠️ Email aceptación proveedor:', e.message));
        }
      }).catch(() => {});
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ PATCH /:id/suppliers/:contractId:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── SUBIR COMPROBANTE DE PAGO ─────────────────────────────────────────────
router.post('/:id/suppliers/:contractId/payment-proof', auth, async (req, res) => {
  const pool = global.pool;
  const { id, contractId } = req.params;
  const proofFile = req.files?.proof;
  if (!proofFile) return res.status(400).json({ error: 'Archivo requerido (campo: proof)' });
  if (proofFile.size > 10 * 1024 * 1024) return res.status(400).json({ error: 'Archivo demasiado grande (max 10MB)' });
  const ext = path.extname(proofFile.name).toLowerCase() || '.pdf';
  const filename = contractId + '-proof-' + Date.now() + ext;
  const uploadDir = path.join(__dirname, '../../uploads/payment-proofs');
  const filePath  = path.join(uploadDir, filename);
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
    await proofFile.mv(filePath);
    const fileUrl = `/uploads/payment-proofs/${filename}`;
    const { rows } = await pool.query(
      `UPDATE events.event_suppliers SET payment_proof_url = $1
       WHERE id = $2 AND event_id = $3 AND user_id = $4
       RETURNING id, payment_proof_url`,
      [fileUrl, contractId, id, req.user.id]
    );
    if (!rows[0]) {
      fs.unlink(filePath, () => {});
      return res.status(404).json({ error: 'Contrato no encontrado' });
    }
    res.json({ ok: true, url: fileUrl });
  } catch (err) {
    console.error('❌ POST payment-proof:', err);
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
    const [eventR, suppliersR, quotesR] = await Promise.all([
      pool.query(
        `SELECT config FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
        isAdmin ? [id] : [id, req.user.id]
      ),
      pool.query(
        `SELECT payment_status,
                SUM(contracted_amount)::NUMERIC  AS contracted_total,
                SUM(COALESCE(deposit_amount, 0))::NUMERIC AS deposit_total
         FROM events.event_suppliers WHERE event_id = $1
         GROUP BY payment_status`,
        [id]
      ),
      pool.query(
        `SELECT COALESCE(SUM((sq.data->>'total_con_iva')::NUMERIC), 0)::NUMERIC AS total_cotizado
         FROM events.event_suppliers es
         JOIN LATERAL (
           SELECT data FROM events.supplier_quotes
           WHERE event_supplier_id = es.id AND status IN ('recibida','aceptada')
           ORDER BY created_at DESC LIMIT 1
         ) sq ON TRUE
         WHERE es.event_id = $1`,
        [id]
      )
    ]);
    if (!eventR.rowCount) return res.status(403).json({ error: 'Acceso denegado' });

    const total_budget   = parseFloat(eventR.rows[0]?.config?.total_budget || 0);
    const total_cotizado = parseFloat(quotesR.rows[0]?.total_cotizado || 0);

    let total_aprobado = 0;
    let total_pagado   = 0;
    for (const row of suppliersR.rows) {
      const ct = parseFloat(row.contracted_total || 0);
      const dt = parseFloat(row.deposit_total || 0);
      if (['accepted','partial','paid'].includes(row.payment_status)) {
        total_aprobado += ct;
      }
      if (row.payment_status === 'partial') total_pagado += dt;
      if (row.payment_status === 'paid')    total_pagado += ct;
    }
    const saldo_disponible = total_budget - total_aprobado;
    res.json({ total_budget, total_cotizado, total_aprobado, total_pagado, saldo_disponible });
  } catch (err) {
    console.error('❌ GET /:id/budget:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── COTIZACIONES ──────────────────────────────────────────────────────────────

router.post('/:id/suppliers/:contractId/send-quote', auth, async (req, res) => {
  const pool = global.pool;
  const { id, contractId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT es.id, es.service_description, es.contracted_amount,
              s.name AS supplier_name, s.contact_email,
              e.name AS event_name, e.starts_at, e.timezone
       FROM events.event_suppliers es
       JOIN events.suppliers s ON s.id = es.supplier_id
       JOIN events.events e ON e.id = es.event_id
       WHERE es.id = $1 AND es.event_id = $2 AND es.user_id = $3`,
      [contractId, id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Contrato no encontrado' });
    const contract = rows[0];
    if (!contract.contact_email) return res.status(400).json({ error: 'El proveedor no tiene email registrado' });

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO events.supplier_quotes (event_id, event_supplier_id, user_id, token, sent_to_email)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, contractId, req.user.id, token, contract.contact_email]
    );
    const quoteUrl = `${process.env.CMS_URL || 'https://cms.sonoro.com.co'}/cotizacion/${token}`;
    await sendSupplierQuoteEmail(contract, quoteUrl);
    await pool.query(
      `UPDATE events.event_suppliers SET payment_status = 'quote_sent' WHERE id = $1`,
      [contractId]
    );
    res.json({ ok: true, sent_to: contract.contact_email, quote_url: quoteUrl });
  } catch (err) {
    console.error('❌ POST /:id/suppliers/:contractId/send-quote:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/:id/suppliers/:contractId/quote', auth, async (req, res) => {
  const pool = global.pool;
  const { id, contractId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT sq.*, s.name AS supplier_name
       FROM events.supplier_quotes sq
       JOIN events.event_suppliers es ON es.id = sq.event_supplier_id
       JOIN events.suppliers s ON s.id = es.supplier_id
       WHERE sq.event_supplier_id = $1 AND sq.event_id = $2 AND sq.user_id = $3
       ORDER BY sq.created_at DESC LIMIT 1`,
      [contractId, id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Sin cotización' });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ GET /:id/suppliers/:contractId/quote:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── ELIMINAR EVENTO ───────────────────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const evCheck = await pool.query(
      `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evCheck.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    await withTransaction(pool, async (client) => {
      // Limpiar FKs sin CASCADE antes de borrar el evento
      await client.query(`DELETE FROM events.service_redemptions WHERE event_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM events.registration_checkins WHERE event_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM events.supplier_quotes WHERE event_id = $1`, [req.params.id]);
      // Borrar evento — CASCADE limpia el resto (registrations, sessions, staff, rundown_cues, event_suppliers)
      await client.query(`DELETE FROM events.events WHERE id = $1`, [req.params.id]);
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ DELETE /api/events/:id:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});



// ── RUNDOWN / LIBRETO ─────────────────────────────────────────────────────────
router.get('/:id/rundown', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const evCheck = await pool.query(
      `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evCheck.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const rows = await pool.query(
      `SELECT c.*, es.name AS responsible_name
       FROM events.rundown_cues c
       LEFT JOIN events.event_staff es ON es.id = c.responsible_id
       WHERE c.event_id = $1
       ORDER BY c.scheduled_at, c.cue_number`,
      [req.params.id]
    );
    res.json(rows.rows);
  } catch (err) {
    console.error('\u274C GET rundown:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/:id/rundown', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const { cue_number, title, scheduled_at, duration_min, location, technical_notes, description, session_id, responsible_id } = req.body;
  if (!title || !scheduled_at) return res.status(400).json({ error: 'title y scheduled_at son requeridos' });
  try {
    const evCheck = await pool.query(
      `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evCheck.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const row = await pool.query(
      `INSERT INTO events.rundown_cues
         (event_id, user_id, cue_number, title, scheduled_at, duration_min, location, technical_notes, description, session_id, responsible_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
       RETURNING *`,
      [req.params.id, req.user.id, cue_number || null, title, scheduled_at,
       duration_min ? parseInt(duration_min) : null, location || null,
       technical_notes || null, description || null, session_id || null,
       responsible_id || null]
    );
    res.status(201).json(row.rows[0]);
  } catch (err) {
    console.error('\u274C POST rundown:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/:id/rundown/:cueId', auth, async (req, res) => {
  const pool = global.pool;
  const io = global.io;
  const isAdmin = req.user.role === 'admin';
  const allowed = ['cue_number','title','scheduled_at','duration_min','location','technical_notes','description','status','delay_minutes','session_id','responsible_id'];
  try {
    const evCheck = await pool.query(
      `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evCheck.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const fields = Object.keys(req.body).filter(k => allowed.includes(k));
    if (!fields.length && req.body.status !== 'in_progress') return res.status(400).json({ error: 'Sin campos a actualizar' });

    // Al activar un cue, registrar started_at y calcular delay real
    let extraSets = '';
    let extraVals = [];
    if (req.body.status === 'in_progress') {
      const cueR = await pool.query(
        `SELECT scheduled_at FROM events.rundown_cues WHERE id = $1 AND event_id = $2`,
        [req.params.cueId, req.params.id]
      );
      if (cueR.rowCount) {
        const diffMin = Math.round((Date.now() - new Date(cueR.rows[0].scheduled_at).getTime()) / 60000);
        extraSets = `, started_at = NOW(), delay_minutes = $${3 + fields.length}`;
        extraVals = [diffMin > 0 ? diffMin : 0];
      }
    }

    const sets = fields.map((f, i) => `${f} = $${i + 3}`);
    const values = fields.map(f => req.body[f]);
    const row = await pool.query(
      `UPDATE events.rundown_cues SET ${sets.length ? sets.join(', ') + ',' : ''} updated_at = NOW()${extraSets}
       WHERE id = $1 AND event_id = $2 RETURNING *`,
      [req.params.cueId, req.params.id, ...values, ...extraVals]
    );
    if (!row.rowCount) return res.status(404).json({ error: 'Cue no encontrado' });
    if (req.body.status && io) {
      const cue = row.rows[0];
      io.to(`event_${req.params.id}`).emit('cue.status_changed', {
        event_id: req.params.id,
        cue_id: req.params.cueId,
        status: req.body.status,
        delay_minutes: cue.delay_minutes || 0,
        started_at: cue.started_at || null
      });
    }
    res.json(row.rows[0]);
  } catch (err) {
    console.error('\u274C PATCH rundown/:cueId:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.delete('/:id/rundown/:cueId', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const evCheck = await pool.query(
      `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evCheck.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const del = await pool.query(
      'DELETE FROM events.rundown_cues WHERE id = $1 AND event_id = $2',
      [req.params.cueId, req.params.id]
    );
    if (!del.rowCount) return res.status(404).json({ error: 'Cue no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('\u274C DELETE rundown/:cueId:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});


// ── HELPERS ───────────────────────────────────────────────────────────────────
function fmtCOP(n) {
  if (!n && n !== 0) return '—';
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(n));
}
function fmtDate(iso, tz) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz || 'America/Bogota' });
}
function statusLabel(s) {
  return {
    quote_requested: 'Cot. solicitada', quote_sent: 'Cot. enviada', quote_received: 'Cot. recibida',
    accepted: 'Aceptada', rejected: 'Rechazada', partial: 'Abonada', paid: 'Pagada', cancelled: 'Cancelada',
    pending: 'Pendiente', cotizado: 'Sin pago', abono: 'Abono', pagado: 'Pagado',
    enviada: 'Enviada', recibida: 'Recibida', aceptada: 'Aceptada', rechazada: 'Rechazada'
  }[s] || s || '—';
}

async function getReportData(pool, eventId, userId, isAdmin) {
  const evRes = await pool.query(
    `SELECT id, name, starts_at, ends_at, venue_name, status, timezone,
            config->>'total_budget' AS total_budget
     FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
    isAdmin ? [eventId] : [eventId, userId]
  );
  if (!evRes.rowCount) return null;
  const ev = evRes.rows[0];

  const rows = await pool.query(
    `SELECT
       s.name        AS supplier_name,
       s.category,
       s.contact_name,
       s.contact_email,
       s.contact_phone,
       es.service_description,
       es.contracted_amount,
       es.abono_amount,
       es.deposit_amount,
       es.payment_status,
       es.notes,
       sq.data->>'total_con_iva'  AS quoted_amount,
       sq.data->>'descripcion'    AS quote_desc,
       sq.status                  AS quote_status,
       sq.submitted_at            AS quote_date
     FROM events.event_suppliers es
     JOIN events.suppliers s ON s.id = es.supplier_id
     LEFT JOIN LATERAL (
       SELECT data, status, submitted_at
       FROM events.supplier_quotes
       WHERE event_supplier_id = es.id
       ORDER BY submitted_at DESC NULLS LAST LIMIT 1
     ) sq ON true
     WHERE es.event_id = $1
     ORDER BY s.category NULLS LAST, s.name`,
    [eventId]
  );

  const contracts = rows.rows;
  const totalBudget = parseFloat(ev.total_budget || 0);
  const totalContracted = contracts.reduce((a, c) => a + parseFloat(c.contracted_amount || 0), 0);
  let totalAprobado = 0, totalPagado = 0;
  for (const c of contracts) {
    const ct = parseFloat(c.contracted_amount || 0);
    const dt = parseFloat(c.deposit_amount || 0);
    if (['accepted','partial','paid'].includes(c.payment_status)) totalAprobado += ct;
    if (c.payment_status === 'partial') totalPagado += dt;
    if (c.payment_status === 'paid')    totalPagado += ct;
  }
  const saldoDisponible = totalBudget - totalAprobado;
  const totalCotizado = contracts
    .filter(c => c.quote_status === 'recibida' || c.quote_status === 'aceptada')
    .reduce((a, c) => a + parseFloat(c.quoted_amount || 0), 0);
  const totalCommitted = totalPagado; // alias legacy CSV
  const totalQuoted = totalCotizado;  // alias legacy CSV

  return { ev, contracts, totalBudget, totalContracted, totalAprobado, totalPagado, saldoDisponible, totalCotizado, totalCommitted, totalQuoted };
}

// ── CSV REPORT ────────────────────────────────────────────────────────────────
router.get('/:id/report/csv', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const d = await getReportData(pool, req.params.id, req.user.id, isAdmin);
    if (!d) return res.status(404).json({ error: 'Evento no encontrado' });
    const { ev, contracts } = d;
    const tz = ev.timezone || 'America/Bogota';

    const headers = ['Proveedor','Categoría','Contacto','Email','Teléfono','Servicio','Monto Pactado COP','Abono COP','Estado Pago','Total Cotizado COP','Estado Cotización','Fecha Cotización'];
    const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

    let csv = '﻿'; // BOM for Excel
    csv += headers.map(escape).join(',') + '\r\n';
    for (const c of contracts) {
      csv += [
        c.supplier_name,
        c.category || '',
        c.contact_name || '',
        c.contact_email || '',
        c.contact_phone || '',
        c.service_description || '',
        c.contracted_amount ? Math.round(c.contracted_amount) : 0,
        c.deposit_amount ? Math.round(c.deposit_amount) : 0,
        statusLabel(c.payment_status),
        c.quoted_amount ? Math.round(c.quoted_amount) : 0,
        statusLabel(c.quote_status),
        c.quote_date ? fmtDate(c.quote_date, tz) : ''
      ].map(escape).join(',') + '\r\n';
    }
    // Totals row
    csv += [
      'TOTAL','','','','','',
      Math.round(d.totalAprobado),
      Math.round(d.totalPagado),
      '','',Math.round(d.totalCotizado),''
    ].map(escape).join(',') + '\r\n';

    const filename = `proveedores_${ev.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('❌ GET report/csv:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── PDF REPORT ────────────────────────────────────────────────────────────────
router.get('/:id/report/pdf', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const d = await getReportData(pool, req.params.id, req.user.id, isAdmin);
    if (!d) return res.status(404).json({ error: 'Evento no encontrado' });
    const { ev, contracts, totalBudget, totalAprobado, totalPagado, saldoDisponible, totalCotizado } = d;
    const tz = ev.timezone || 'America/Bogota';

    const filename = `proveedores_${ev.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 48, size: 'A4', bufferPages: true });
    doc.pipe(res);

    const W = 595 - 96; // page width minus margins
    const AMBER = '#f59e0b';
    const DARK  = '#111827';
    const GRAY  = '#6b7280';
    const LIGHT = '#f3f4f6';
    const WHITE = '#ffffff';

    // ── HEADER ──────────────────────────────────────────────────────────────
    doc.rect(0, 0, 595, 80).fill('#18181b');
    doc.fillColor(AMBER).font('Helvetica-Bold').fontSize(18).text('SONORO', 48, 20);
    doc.fillColor('#d1d5db').font('Helvetica').fontSize(10).text('Reporte de Proveedores', 48, 44);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(13).text(ev.name, 48, 58, { width: W - 100 });

    // ── EVENT INFO ──────────────────────────────────────────────────────────
    let y = 96;
    const dateRange = `${fmtDate(ev.starts_at, tz)}${ev.ends_at !== ev.starts_at ? ' — ' + fmtDate(ev.ends_at, tz) : ''}`;
    doc.fillColor(GRAY).font('Helvetica').fontSize(9).text(`${dateRange}   ·   ${ev.venue_name || 'Sin sede'}   ·   Estado: ${statusLabel(ev.status)}`, 48, y);
    doc.fillColor(GRAY).fontSize(8).text(`Generado: ${new Date().toLocaleString('es-CO', { timeZone: tz, day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:true })}`, 48, y + 13);
    y += 36;

    // ── BUDGET SUMMARY ──────────────────────────────────────────────────────
    const boxW5 = (W - 12) / 5;
    const budgetBoxes = [
      { label: 'Presupuesto',  value: fmtCOP(totalBudget),   color: DARK },
      { label: 'Cotizado',     value: fmtCOP(totalCotizado), color: '#a78bfa' },
      { label: 'Aprobado',     value: fmtCOP(totalAprobado), color: '#f59e0b' },
      { label: 'Pagado',       value: fmtCOP(totalPagado),   color: '#3b82f6' },
      { label: 'Saldo',        value: totalBudget ? fmtCOP(saldoDisponible) : '—', color: saldoDisponible < 0 ? '#ef4444' : '#22c55e' }
    ];
    budgetBoxes.forEach((b, i) => {
      const bx = 48 + i * (boxW5 + 3);
      doc.roundedRect(bx, y, boxW5, 44, 4).fill(LIGHT);
      doc.fillColor(GRAY).font('Helvetica').fontSize(7.5).text(b.label, bx + 6, y + 8, { width: boxW5 - 12 });
      doc.fillColor(b.color).font('Helvetica-Bold').fontSize(10).text(b.value, bx + 6, y + 20, { width: boxW5 - 12 });
    });
    y += 56;

    // ── TABLE HEADER ────────────────────────────────────────────────────────
    const cols = [
      { label: 'Proveedor',   w: 110 },
      { label: 'Categoría',   w: 55  },
      { label: 'Servicio',    w: 130 },
      { label: 'Aprobado',    w: 72  },
      { label: 'Pagado',      w: 72  },
      { label: 'Estado',      w: 60  },
    ];
    doc.rect(48, y, W, 18).fill('#18181b');
    let cx = 48;
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(8);
    cols.forEach(c => {
      doc.text(c.label, cx + 4, y + 5, { width: c.w - 8, lineBreak: false });
      cx += c.w;
    });
    y += 18;

    // ── TABLE ROWS ──────────────────────────────────────────────────────────
    const rowH = 22;
    contracts.forEach((c, i) => {
      if (y + rowH > 780) { doc.addPage(); y = 48; }
      doc.rect(48, y, W, rowH).fill(i % 2 === 0 ? WHITE : LIGHT);
      cx = 48;
      const vals = [
        c.supplier_name || '—',
        c.category || '—',
        c.service_description || '—',
        ['accepted','partial','paid'].includes(c.payment_status) ? fmtCOP(c.contracted_amount) : '—',
        c.payment_status === 'paid' ? fmtCOP(c.contracted_amount) : (c.payment_status === 'partial' ? fmtCOP(c.deposit_amount) : '—'),
        statusLabel(c.payment_status)
      ];
      doc.fillColor(DARK).font('Helvetica').fontSize(8);
      cols.forEach((col, ci) => {
        doc.text(vals[ci], cx + 4, y + 7, { width: col.w - 8, lineBreak: false, ellipsis: true });
        cx += col.w;
      });

      y += rowH;
    });

    // ── TOTALS ROW ───────────────────────────────────────────────────────────
    if (contracts.length) {
      if (y + rowH > 780) { doc.addPage(); y = 48; }
      doc.rect(48, y, W, rowH).fill('#18181b');
      doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(8);
      cx = 48;
      const totals = ['TOTAL', '', '', fmtCOP(totalAprobado), fmtCOP(totalPagado), ''];
      cols.forEach((col, ci) => {
        doc.text(totals[ci], cx + 4, y + 7, { width: col.w - 8, lineBreak: false });
        cx += col.w;
      });
      y += rowH;
    }

    // ── QUOTES DETAIL (if any received) ─────────────────────────────────────
    const withQuotes = contracts.filter(c => c.quote_status === 'recibida' || c.quote_status === 'aceptada');
    if (withQuotes.length) {
      y += 20;
      if (y + 30 > 780) { doc.addPage(); y = 48; }
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(11).text('Detalle de cotizaciones recibidas', 48, y);
      y += 16;
      withQuotes.forEach(c => {
        if (y + 50 > 780) { doc.addPage(); y = 48; }
        doc.roundedRect(48, y, W, 2).fill(AMBER);
        y += 6;
        doc.fillColor(DARK).font('Helvetica-Bold').fontSize(9).text(c.supplier_name, 48, y);
        doc.fillColor(GRAY).font('Helvetica').fontSize(8)
           .text(`Servicio: ${c.service_description || '—'}   ·   Cotizado: ${fmtCOP(c.quoted_amount)}   ·   ${fmtDate(c.quote_date, tz)}`, 48, y + 12);
        if (c.quote_desc) {
          doc.fillColor(GRAY).fontSize(7).text(c.quote_desc.substring(0, 200), 48, y + 24, { width: W });
          y += 38;
        } else { y += 30; }
      });
    }

    // ── FOOTER ───────────────────────────────────────────────────────────────
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fillColor(GRAY).font('Helvetica').fontSize(7)
         .text(`SONORO CMS · ${ev.name} · Pág ${i + 1} de ${pages.count}`, 48, 820, { width: W, align: 'center' });
    }

    doc.end();
  } catch (err) {
    console.error('❌ GET report/pdf:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Error interno' });
  }
});

// ── CHECK-IN STATS POR SESIÓN (para gráfica en dashboard) ──────────────────
router.get('/:id/checkin-stats', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const evRes = await pool.query(
      `SELECT user_id FROM events.events WHERE id = $1`,
      [req.params.id]
    );
    if (!evRes.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    if (evRes.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Sin acceso' });
    const { rows } = await pool.query(
      `SELECT
         sess.id                                                  AS session_id,
         COALESCE(sess.name, 'Entrada general')                   AS name,
         COUNT(DISTINCT c.registration_id)::int                   AS count
       FROM events.registration_checkins c
       LEFT JOIN events.event_sessions sess ON sess.id = c.session_id
       WHERE c.event_id = $1
       GROUP BY sess.id, sess.name
       ORDER BY count DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /api/events/:id/checkin-stats:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
