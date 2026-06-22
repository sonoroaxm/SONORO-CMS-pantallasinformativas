// Events v1 — Rutas autenticadas (organizador / productor)
// P-2: todo filtro incluye user_id | P-3: mutaciones ≥2 tablas usan withTransaction
// Fase: E2

'use strict';
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const { withTransaction } = require('../db/withTransaction');
const { sendEventRegistrationEmail, sendSupplierQuoteEmail, sendSupplierAcceptedEmail, sendSupplierDepositEmail, sendSupplierPaidEmail, sendInvitationConfirmedEmail, sendInvitationPendingEmail } = require('../services/email');
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
      `SELECT s.*,
              COUNT(DISTINCT es.event_id)::int        AS event_count,
              (SELECT e2.name
               FROM events.event_suppliers es2
               JOIN events.events e2 ON e2.id = es2.event_id
               WHERE es2.supplier_id = s.id
               ORDER BY e2.starts_at DESC NULLS LAST
               LIMIT 1)                              AS last_event_name
       FROM events.suppliers s
       LEFT JOIN events.event_suppliers es ON es.supplier_id = s.id
       WHERE s.user_id = $1
       GROUP BY s.id
       ORDER BY s.name`,
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
const VALID_DOC_TYPES = ['rut', 'cert_bancario', 'camara_comercio', 'portafolio'];
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
          starts_at, ends_at, capacity, requires_registration = false,
          speaker_name = null } = req.body;
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
          starts_at, ends_at, capacity, requires_registration, speaker_name)
       VALUES ($1,$2,$3,$4,$5,$6,
         ($7::timestamp AT TIME ZONE $11),
         ($8::timestamp AT TIME ZONE $11),
         $9,$10,$12) RETURNING *`,
      [req.params.id, evCheck.rows[0].user_id, name.trim(), description || null,
       session_type, venue_zone || null, starts_at, ends_at, capacity || null, requires_registration, tz,
       (speaker_name && String(speaker_name).trim()) || null]
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

// ── EDITAR INSCRITO ───────────────────────────────────────────────────────────
router.patch('/:id/registrations/:regId', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const { name, email, phone, id_number, organization, job_title, custom_fields } = req.body || {};

  const evCheck = await pool.query(
    `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
    isAdmin ? [req.params.id] : [req.params.id, req.user.id]
  );
  if (!evCheck.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });

  try {
    const result = await withTransaction(pool, async (client) => {
      const regRes = await client.query(
        `SELECT r.id, r.attendee_id FROM events.registrations r
         WHERE r.id = $1 AND r.event_id = $2 FOR UPDATE`,
        [req.params.regId, req.params.id]
      );
      if (!regRes.rows[0]) {
        const err = new Error('Inscripción no encontrada'); err.httpStatus = 404; throw err;
      }
      const reg = regRes.rows[0];

      const attendeeFields = { name, email, phone, id_number, organization, job_title };
      const sets = []; const vals = []; let i = 1;
      for (const [k, v] of Object.entries(attendeeFields)) {
        if (v !== undefined) { sets.push(`${k} = $${i++}`); vals.push(v === '' ? null : v); }
      }
      if (sets.length) {
        vals.push(reg.attendee_id);
        await client.query(`UPDATE events.attendees SET ${sets.join(', ')} WHERE id = $${i}`, vals);
      }

      if (custom_fields !== undefined) {
        await client.query(
          `UPDATE events.registrations SET custom_fields = $1 WHERE id = $2`,
          [custom_fields, reg.id]
        );
      }

      const out = await client.query(
        `SELECT r.id, r.qr_token, r.ticket_type, r.status, r.custom_fields,
                a.name AS attendee_name, a.email, a.phone, a.id_number, a.organization, a.job_title
         FROM events.registrations r JOIN events.attendees a ON a.id = r.attendee_id
         WHERE r.id = $1`,
        [reg.id]
      );
      return out.rows[0];
    });
    res.json({ ok: true, registration: result });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('❌ PATCH /api/events/:id/registrations/:regId:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── REENVIAR QR POR EMAIL ─────────────────────────────────────────────────────
router.post('/:id/registrations/:regId/resend-email', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';

  try {
    const evRes = await pool.query(
      `SELECT * FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    const event = evRes.rows[0];
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });

    const regRes = await pool.query(
      `SELECT r.*, a.name AS attendee_name, a.email AS attendee_email
       FROM events.registrations r JOIN events.attendees a ON a.id = r.attendee_id
       WHERE r.id = $1 AND r.event_id = $2`,
      [req.params.regId, req.params.id]
    );
    const reg = regRes.rows[0];
    if (!reg) return res.status(404).json({ error: 'Inscripción no encontrada' });
    if (!reg.attendee_email) return res.status(400).json({ error: 'Inscrito sin email' });
    if (reg.status === 'cancelled') return res.status(409).json({ error: 'Inscripción cancelada' });

    const emailConfig = { from_name: event.config?.email_from_name || null, reply_to: event.config?.email_reply_to || null };
    await sendEventRegistrationEmail(
      { name: reg.attendee_name, email: reg.attendee_email },
      event, reg, emailConfig
    );
    res.json({ ok: true, sent_to: reg.attendee_email });
  } catch (err) {
    console.error('❌ POST /api/events/:id/registrations/:regId/resend-email:', err);
    res.status(500).json({ error: err.message || 'Error al enviar email' });
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

  // Claves estándar reconocidas (todo lo demás va a custom_fields)
  const STD_KEYS = new Set([
    'nombre','name','email','telefono','phone','cedula','id_number',
    'tipo_documento','id_type','empresa','organization','cargo','job_title',
    'tipo_ticket','ticket_type'
  ]);

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const name   = (row.nombre  || row.name  || '').trim();
    const email  = (row.email   || '').toLowerCase().trim();
    const phone  = row.telefono || row.phone        || null;
    const idNum  = row.cedula   || row.id_number    || null;
    const idType = (row.tipo_documento || row.id_type || 'CC').toUpperCase().slice(0, 10);
    const org    = row.empresa  || row.organization || null;
    const job    = row.cargo    || row.job_title    || null;
    const ticket = row.tipo_ticket || row.ticket_type || 'general';

    // Columnas extra → custom_fields
    const customFields = {};
    for (const k of Object.keys(row)) {
      if (!STD_KEYS.has(k) && row[k] != null && String(row[k]).trim() !== '') {
        customFields[k] = String(row[k]).trim();
      }
    }

    if (!name || !email) { errors.push({ row: i + 2, error: 'nombre y email requeridos' }); continue; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ row: i + 2, error: `email inválido: ${email}` }); continue;
    }

    try {
      // P-3: withTransaction — upsert attendee + insert registration atómicos
      const inserted = await withTransaction(pool, async (client) => {
        const att = await client.query(
          `INSERT INTO events.attendees (user_id, email, name, phone, id_number, id_type, organization, job_title)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (user_id, email) DO UPDATE SET
             name         = EXCLUDED.name,
             phone        = COALESCE(EXCLUDED.phone,        events.attendees.phone),
             id_number    = COALESCE(EXCLUDED.id_number,    events.attendees.id_number),
             id_type      = COALESCE(EXCLUDED.id_type,      events.attendees.id_type),
             organization = COALESCE(EXCLUDED.organization, events.attendees.organization),
             job_title    = COALESCE(EXCLUDED.job_title,    events.attendees.job_title),
             updated_at   = NOW()
           RETURNING id`,
          [userId, email, name, phone, idNum, idType, org, job]
        );
        const ins = await client.query(
          `INSERT INTO events.registrations
             (event_id, attendee_id, user_id, ticket_type, origin, custom_fields, accepted_terms)
           VALUES ($1,$2,$3,$4,'import',$5,TRUE)
           ON CONFLICT (event_id, attendee_id) DO NOTHING`,
          [req.params.id, att.rows[0].id, userId, ticket, JSON.stringify(customFields)]
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

// ── EXPORTAR REGISTROS CSV ────────────────────────────────────────────────────
router.get('/:id/registrations/export/csv', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const evRes = await pool.query(
      `SELECT e.name, e.timezone FROM events.events e WHERE e.id = $1 ${isAdmin ? '' : 'AND e.user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evRes.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    const { name: evName, timezone: tz } = evRes.rows[0];

    const { rows } = await pool.query(
      `SELECT r.id, r.qr_token, r.ticket_type, r.status, r.origin, r.created_at AS registered_at,
              r.custom_fields,
              a.name AS attendee_name, a.email, a.phone, a.id_number, a.organization, a.job_title,
              (SELECT string_agg(sess.name, ' | ' ORDER BY sess.starts_at)
               FROM events.registration_sessions rs
               JOIN events.event_sessions sess ON sess.id = rs.session_id
               WHERE rs.registration_id = r.id) AS sessions,
              (SELECT string_agg(c.event_day::text || ' ' ||
                 to_char(c.checked_in_at AT TIME ZONE $2, 'HH12:MI AM'), ' | '
                 ORDER BY c.checked_in_at)
               FROM events.registration_checkins c WHERE c.registration_id = r.id) AS checkins
       FROM events.registrations r
       JOIN events.attendees a ON a.id = r.attendee_id
       WHERE r.event_id = $1
       ORDER BY r.created_at ASC`,
      [req.params.id, tz]
    );

    const escCSV = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const statusLbl = s => s === 'confirmed' ? 'Confirmado' : s === 'cancelled' ? 'Cancelado' : 'Pendiente';

    // Collect all custom_field keys across rows
    const cfKeys = [...new Set(rows.flatMap(r => Object.keys(r.custom_fields || {})))];
    const headers = [
      'nombre', 'email', 'telefono', 'cedula', 'organizacion', 'cargo',
      'tipo_entrada', 'estado', 'origen', 'sesiones_inscritas', 'check_ins', 'registrado_en',
      ...cfKeys
    ];

    let csv = headers.map(escCSV).join(',') + '\r\n';
    for (const r of rows) {
      const cf = r.custom_fields || {};
      csv += [
        escCSV(r.attendee_name), escCSV(r.email), escCSV(r.phone), escCSV(r.id_number),
        escCSV(r.organization), escCSV(r.job_title), escCSV(r.ticket_type),
        escCSV(statusLbl(r.status)), escCSV(r.origin),
        escCSV(r.sessions), escCSV(r.checkins),
        escCSV(r.registered_at ? new Date(r.registered_at).toLocaleString('es-CO', { timeZone: tz, hour12: true }) : ''),
        ...cfKeys.map(k => escCSV(cf[k]))
      ].join(',') + '\r\n';
    }

    const filename = `registros_${evName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + csv); // BOM para Excel
  } catch (err) {
    console.error('❌ GET registrations/export/csv:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── EXPORTAR REGISTROS PDF ────────────────────────────────────────────────────
router.get('/:id/registrations/export/pdf', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const evRes = await pool.query(
      `SELECT id, name, slug, status, starts_at, ends_at, timezone, venue_name, config
       FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evRes.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    const ev = evRes.rows[0];
    const tz = ev.timezone || 'America/Bogota';
    const maxCap = ev.config?.max_capacity ? parseInt(ev.config.max_capacity) : null;

    const [statsRes, sessionsRes, regsRes] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT COUNT(*) FROM events.registrations WHERE event_id=$1 AND status!='cancelled')::int AS total,
           (SELECT COUNT(*) FROM events.registrations WHERE event_id=$1 AND status='confirmed')::int  AS confirmed,
           (SELECT COUNT(*) FROM events.registrations WHERE event_id=$1 AND status='pending')::int    AS pending,
           (SELECT COUNT(DISTINCT registration_id) FROM events.registration_checkins WHERE event_id=$1)::int AS checked_in`,
        [req.params.id]
      ),
      pool.query(
        `WITH sr AS (
           SELECT rs.session_id, COUNT(DISTINCT rs.registration_id)::int AS reg_count
           FROM events.registration_sessions rs
           JOIN events.registrations r ON r.id = rs.registration_id
           WHERE r.event_id = $1 GROUP BY rs.session_id
         ), ci AS (
           SELECT session_id, COUNT(DISTINCT registration_id)::int AS ci_count
           FROM events.registration_checkins WHERE event_id = $1 GROUP BY session_id
         )
         SELECT s.name, COALESCE(sr.reg_count,0) AS reg_count, COALESCE(ci.ci_count,0) AS ci_count,
                s.capacity
         FROM events.event_sessions s
         LEFT JOIN sr ON sr.session_id = s.id
         LEFT JOIN ci ON ci.session_id = s.id
         WHERE s.event_id = $1 AND s.status != 'cancelled'
         ORDER BY s.starts_at`,
        [req.params.id]
      ),
      pool.query(
        `SELECT a.name AS attendee_name, a.email, a.phone, r.ticket_type, r.status,
                (SELECT string_agg(sess.name, ', ' ORDER BY sess.starts_at)
                 FROM events.registration_sessions rs
                 JOIN events.event_sessions sess ON sess.id = rs.session_id
                 WHERE rs.registration_id = r.id) AS sessions,
                (SELECT string_agg(c.event_day::text || ' ' ||
                   to_char(c.checked_in_at AT TIME ZONE $2, 'HH12:MI AM'), ', '
                   ORDER BY c.checked_in_at)
                 FROM events.registration_checkins c WHERE c.registration_id = r.id) AS checkins,
                r.created_at AS registered_at
         FROM events.registrations r
         JOIN events.attendees a ON a.id = r.attendee_id
         WHERE r.event_id = $1
         ORDER BY r.created_at ASC`,
        [req.params.id, tz]
      ),
    ]);

    const stats    = statsRes.rows[0];
    const sessions = sessionsRes.rows;
    const regs     = regsRes.rows;

    // ── PDF setup ─────────────────────────────────────────────────────────────
    const filename = `registros_${ev.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 48, size: 'A4', bufferPages: true });
    doc.pipe(res);

    const PAGE_W = 595;
    const M      = 48;
    const W      = PAGE_W - M * 2;       // 499
    const AMBER  = '#f59e0b';
    const GREEN  = '#22c55e';
    const BLUE   = '#3b82f6';
    const DARK   = '#111827';
    const GRAY   = '#6b7280';
    const LIGHT  = '#f3f4f6';
    const WHITE  = '#ffffff';

    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('es-CO',
      { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    const statusLbl = s => s === 'confirmed' ? 'Confirmado' : s === 'cancelled' ? 'Cancelado' : 'Pendiente';

    // ── HEADER ────────────────────────────────────────────────────────────────
    doc.rect(0, 0, PAGE_W, 78).fill('#18181b');
    doc.fillColor(AMBER).font('Helvetica-Bold').fontSize(18).text('SONORO', M, 18);
    doc.fillColor('#d1d5db').font('Helvetica').fontSize(10).text('Reporte de Registros', M, 40);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(13).text(ev.name, M, 56, { width: W - 80 });

    let y = 90;
    const dateRange = `${fmtDate(ev.starts_at)}${ev.ends_at !== ev.starts_at ? ' — ' + fmtDate(ev.ends_at) : ''}`;
    const genAt = new Date().toLocaleString('es-CO', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
    doc.fillColor(GRAY).font('Helvetica').fontSize(9)
       .text(`${dateRange}   ·   ${ev.venue_name || 'Sin sede'}   ·   Estado: ${statusLbl(ev.status)}`, M, y);
    doc.fillColor(GRAY).fontSize(8).text(`Generado: ${genAt}`, M, y + 12);
    y += 30;

    // ── DONUTS ────────────────────────────────────────────────────────────────
    // Helper: draw a donut + text block, returns width used
    const DONUT_R  = 28;
    const DONUT_D  = DONUT_R * 2 + 8; // card inner padding
    const CARD_H   = 70;

    // Build donut data array
    const donutData = [
      {
        pct: maxCap ? Math.min(100, Math.round((stats.total / maxCap) * 100)) : null,
        color: AMBER, big: stats.total,
        line1: maxCap ? `de ${maxCap} cupos` : 'sin límite', line2: 'INSCRITOS'
      },
      {
        pct: stats.total ? Math.round((stats.confirmed / stats.total) * 100) : 0,
        color: GREEN, big: stats.confirmed,
        line1: `de ${stats.total} inscritos`, line2: 'CONFIRMADOS'
      },
      {
        pct: stats.total ? Math.round((stats.checked_in / stats.total) * 100) : 0,
        color: BLUE, big: stats.checked_in,
        line1: `de ${stats.total} inscritos`, line2: 'CHECK-INS'
      },
    ];
    if (stats.pending > 0) {
      donutData.push({
        pct: null, color: AMBER, big: stats.pending,
        line1: 'por confirmar', line2: 'PENDIENTES'
      });
    }

    const donutCount = donutData.length;
    const cardW = Math.floor((W - (donutCount - 1) * 8) / donutCount);

    donutData.forEach((d, i) => {
      const cx = M + i * (cardW + 8);
      doc.roundedRect(cx, y, cardW, CARD_H, 5).fill(LIGHT);

      // Donut arc via SVG-style path simulation using ellipse strokes
      const dcx = cx + DONUT_R + 10;
      const dcy = y + CARD_H / 2;
      const pct = d.pct ?? 0;

      // Background circle
      doc.circle(dcx, dcy, DONUT_R).lineWidth(5).strokeColor('rgba(128,128,128,0.2)').stroke();

      // Foreground arc (approximate with many short lines)
      if (pct > 0) {
        const startAngle = -Math.PI / 2;
        const endAngle   = startAngle + (pct / 100) * 2 * Math.PI;
        const steps = Math.max(4, Math.round(pct * 0.8));
        doc.save();
        doc.lineWidth(5).strokeColor(d.color).lineCap('round');
        doc.moveTo(dcx + DONUT_R * Math.cos(startAngle), dcy + DONUT_R * Math.sin(startAngle));
        for (let s = 1; s <= steps; s++) {
          const a = startAngle + (s / steps) * (endAngle - startAngle);
          doc.lineTo(dcx + DONUT_R * Math.cos(a), dcy + DONUT_R * Math.sin(a));
        }
        doc.stroke();
        doc.restore();
      }

      // % text inside donut
      const pctLabel = d.pct !== null ? `${pct}%` : '—';
      doc.fillColor(d.color).font('Helvetica-Bold').fontSize(8)
         .text(pctLabel, dcx - DONUT_R, dcy - 5, { width: DONUT_R * 2, align: 'center', lineBreak: false });

      // Right side text
      const tx = dcx + DONUT_R + 8;
      const tw = cardW - (tx - cx) - 6;
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(18)
         .text(String(d.big), tx, y + 10, { width: tw, lineBreak: false });
      doc.fillColor(GRAY).font('Helvetica').fontSize(7)
         .text(d.line1, tx, y + 32, { width: tw, lineBreak: false });
      doc.fillColor(GRAY).font('Helvetica-Bold').fontSize(6.5)
         .text(d.line2, tx, y + 44, { width: tw, lineBreak: false });
    });
    y += CARD_H + 14;

    // ── SESSION PILLS ─────────────────────────────────────────────────────────
    // General check-in row (no session_id) from checkin-stats logic
    const generalCI = stats.checked_in - sessions.reduce((s, r) => s + r.ci_count, 0);

    // Include "Entrada general" if there are check-ins without session
    const pillRows = [...sessions];
    if (generalCI > 0) {
      pillRows.unshift({ name: 'Entrada general', reg_count: stats.total, ci_count: generalCI, capacity: null });
    }

    if (pillRows.length > 0) {
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(10).text('Asistencia por sesión', M, y);
      y += 14;

      const PILLS_PER_ROW = 2;
      const GAP           = 10;
      const PILL_W        = Math.floor((W - GAP * (PILLS_PER_ROW - 1)) / PILLS_PER_ROW);
      const PILL_H        = 52;
      const BAR_MAX_W     = PILL_W - 24;  // internal bar never reaches pill edges
      const BAR_H         = 6;

      pillRows.forEach((s, i) => {
        const col = i % PILLS_PER_ROW;
        const row = Math.floor(i / PILLS_PER_ROW);
        const px  = M + col * (PILL_W + GAP);
        const py  = y + row * (PILL_H + 8);

        if (py + PILL_H > 790) { doc.addPage(); y = M - row * (PILL_H + 8); }

        const denom = s.capacity ? parseInt(s.capacity) : (s.reg_count || 1);
        const pct   = denom > 0 ? Math.min(100, Math.round((s.ci_count / denom) * 100)) : 0;
        const barW  = Math.round((pct / 100) * BAR_MAX_W);

        // Pill background
        doc.roundedRect(px, py, PILL_W, PILL_H, 5).fill(LIGHT);

        // Session name
        doc.fillColor(DARK).font('Helvetica-Bold').fontSize(8)
           .text(s.name || 'Sin nombre', px + 10, py + 9, { width: PILL_W - 80, lineBreak: false, ellipsis: true });

        // % badge top-right
        doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(10)
           .text(`${pct}%`, px + PILL_W - 46, py + 7, { width: 38, align: 'right', lineBreak: false });

        // Bar track
        doc.roundedRect(px + 10, py + 26, BAR_MAX_W, BAR_H, 3).fill('#d1d5db');
        // Bar fill
        if (barW > 0) {
          doc.roundedRect(px + 10, py + 26, barW, BAR_H, 3).fill(BLUE);
        }

        // Count label
        doc.fillColor(GRAY).font('Helvetica').fontSize(7)
           .text(`${s.ci_count} de ${denom} asistentes`, px + 10, py + 37, { width: PILL_W - 20, lineBreak: false });
      });

      const totalPillRows = Math.ceil(pillRows.length / PILLS_PER_ROW);
      y += totalPillRows * (PILL_H + 8) + 10;
    }

    // ── DIVIDER ───────────────────────────────────────────────────────────────
    doc.rect(M, y, W, 1).fill('#e5e7eb');
    y += 10;

    // ── TABLE ─────────────────────────────────────────────────────────────────
    const cols = [
      { label: 'Nombre',   w: 110 },
      { label: 'Email',    w: 120 },
      { label: 'Teléfono', w: 68  },
      { label: 'Tipo',     w: 55  },
      { label: 'Estado',   w: 58  },
      { label: 'Sesiones', w: 88  },
    ];

    doc.rect(M, y, W, 18).fill('#18181b');
    let cx = M;
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(7.5);
    cols.forEach(c => {
      doc.text(c.label, cx + 4, y + 5, { width: c.w - 8, lineBreak: false });
      cx += c.w;
    });
    y += 18;

    const ROW_H = 20;
    regs.forEach((r, i) => {
      if (y + ROW_H > 790) { doc.addPage(); y = M; }
      doc.rect(M, y, W, ROW_H).fill(i % 2 === 0 ? WHITE : LIGHT);
      cx = M;
      const stColor = r.status === 'confirmed' ? GREEN : r.status === 'cancelled' ? '#ef4444' : AMBER;
      const vals = [
        r.attendee_name || '—',
        r.email || '—',
        r.phone || '—',
        r.ticket_type || '—',
        statusLbl(r.status),
        r.sessions || (r.checkins ? 'Check-in ✓' : '—'),
      ];
      doc.font('Helvetica').fontSize(7.5);
      cols.forEach((col, ci) => {
        doc.fillColor(ci === 4 ? stColor : DARK)
           .text(vals[ci], cx + 4, y + 6, { width: col.w - 8, lineBreak: false, ellipsis: true });
        cx += col.w;
      });
      y += ROW_H;
    });

    if (!regs.length) {
      doc.fillColor(GRAY).font('Helvetica').fontSize(9).text('Sin registros.', M, y + 8);
      y += 24;
    }

    // ── FOOTER ───────────────────────────────────────────────────────────────
    const pages = doc.bufferedPageRange();
    for (let p = 0; p < pages.count; p++) {
      doc.switchToPage(p);
      doc.fillColor(GRAY).font('Helvetica').fontSize(7)
         .text(`SONORO CMS · ${ev.name} · Registros · Pág ${p + 1} de ${pages.count}`, M, 828, { width: W, align: 'center' });
    }

    doc.end();
  } catch (err) {
    console.error('❌ GET registrations/export/pdf:', err);
    res.status(500).json({ error: 'Error interno' });
  }
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
          assigned_staff_id, observations, speaker_name } = req.body;
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
         observations      = COALESCE($11, observations),
         speaker_name      = COALESCE($12, speaker_name)
       WHERE id = $1 AND event_id = $2 RETURNING *`,
      [req.params.sessionId, req.params.id,
       name?.trim() || null, starts_at || null, ends_at || null,
       capacity !== undefined ? (capacity || null) : undefined,
       venue_zone || null, description || null, tz,
       assigned_staff_id || null, observations || null,
       (speaker_name && String(speaker_name).trim()) || null]
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

// ── PRODUCTION TOKENS (URLs públicas para dashboard productor + teleprompter) ──
// Tabla: events.production_tokens(id, user_id, event_id, session_id, kind, token, created_at, revoked_at)
// kind='produccion' → URL del dashboard del productor (sin session_id)
// kind='teleprompter' → URL por sesión para confidence monitor (requiere session_id)

function buildTokenUrl(req, slug, row) {
  const base = `${req.protocol}://${req.get('host')}`;
  if (row.kind === 'teleprompter') {
    return `${base}/evento/${slug}/orador/${row.session_id}?t=${row.token}`;
  }
  return `${base}/evento/${slug}/produccion?t=${row.token}`;
}

router.get('/:id/production-tokens', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const evCheck = await pool.query(
      `SELECT id, slug FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evCheck.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const slug = evCheck.rows[0].slug;
    const params = isAdmin ? [req.params.id] : [req.params.id, req.user.id];
    const userFilter = isAdmin ? '' : 'AND pt.user_id = $2';
    const { rows } = await pool.query(
      `SELECT pt.id, pt.kind, pt.session_id, pt.token, pt.created_at,
              s.name AS session_title
       FROM events.production_tokens pt
       LEFT JOIN events.event_sessions s ON s.id = pt.session_id
       WHERE pt.event_id = $1 ${userFilter} AND pt.revoked_at IS NULL
       ORDER BY pt.created_at DESC`,
      params
    );
    res.json(rows.map(r => ({
      id: r.id, kind: r.kind, session_id: r.session_id, session_title: r.session_title,
      token: r.token, created_at: r.created_at,
      public_url: buildTokenUrl(req, slug, r)
    })));
  } catch (err) {
    console.error('GET /production-tokens:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/:id/production-tokens', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const { kind, session_id } = req.body || {};
  if (!['produccion', 'teleprompter'].includes(kind)) {
    return res.status(400).json({ error: "kind debe ser 'produccion' o 'teleprompter'" });
  }
  if (kind === 'teleprompter' && !session_id) {
    return res.status(400).json({ error: 'session_id requerido para teleprompter' });
  }
  try {
    const evCheck = await pool.query(
      `SELECT id, user_id, slug FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evCheck.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const ev = evCheck.rows[0];

    if (session_id) {
      const sCheck = await pool.query(
        `SELECT id FROM events.event_sessions WHERE id = $1 AND event_id = $2`,
        [session_id, ev.id]
      );
      if (!sCheck.rowCount) return res.status(404).json({ error: 'Sesión no encontrada' });
    }

    const { rows } = await pool.query(
      `INSERT INTO events.production_tokens (user_id, event_id, session_id, kind)
       VALUES ($1, $2, $3, $4)
       RETURNING id, kind, session_id, token, created_at`,
      [ev.user_id, ev.id, kind === 'teleprompter' ? session_id : null, kind]
    );
    const row = rows[0];
    let session_title = null;
    if (row.session_id) {
      const t = await pool.query(`SELECT name FROM events.event_sessions WHERE id = $1`, [row.session_id]);
      session_title = t.rows[0]?.name || null;
    }
    res.status(201).json({
      id: row.id, kind: row.kind, session_id: row.session_id, session_title,
      token: row.token, created_at: row.created_at,
      public_url: buildTokenUrl(req, ev.slug, row)
    });
  } catch (err) {
    console.error('POST /production-tokens:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.delete('/:id/production-tokens/:tokenId', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const params = isAdmin
      ? [req.params.tokenId, req.params.id]
      : [req.params.tokenId, req.params.id, req.user.id];
    const userFilter = isAdmin ? '' : 'AND user_id = $3';
    const del = await pool.query(
      `UPDATE events.production_tokens
       SET revoked_at = NOW()
       WHERE id = $1 AND event_id = $2 ${userFilter} AND revoked_at IS NULL`,
      params
    );
    if (!del.rowCount) return res.status(404).json({ error: 'Token no encontrado' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /production-tokens:', err);
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
        `SELECT s.name AS supplier_name, s.contact_email, e.name AS event_name, e.config AS event_config
         FROM events.suppliers s
         JOIN events.events e ON e.id = $1
         WHERE s.id = $2 AND s.user_id = $3`,
        [id, rows[0].supplier_id, req.user.id]
      ).then(supR => {
        if (supR.rows[0]?.contact_email) {
          const eCfgAcc = { from_name: supR.rows[0].event_config?.email_from_name || null, reply_to: supR.rows[0].event_config?.email_reply_to || null };
          sendSupplierAcceptedEmail({
            supplier_name: supR.rows[0].supplier_name,
            contact_email: supR.rows[0].contact_email,
            event_name:    supR.rows[0].event_name,
            contracted_amount: rows[0].contracted_amount,
          }, eCfgAcc).catch(e => console.error('⚠️ Email aceptación proveedor:', e.message));
        }
      }).catch(() => {});
    }
    if ((payment_status === 'partial' || payment_status === 'paid') && rows[0].supplier_id) {
      pool.query(
        `SELECT s.name AS supplier_name, s.contact_email, e.name AS event_name, e.config AS event_config
         FROM events.suppliers s
         JOIN events.events e ON e.id = $1
         WHERE s.id = $2 AND s.user_id = $3`,
        [id, rows[0].supplier_id, req.user.id]
      ).then(supR => {
        if (supR.rows[0]?.contact_email) {
          const eCfg = { from_name: supR.rows[0].event_config?.email_from_name || null, reply_to: supR.rows[0].event_config?.email_reply_to || null };
          if (payment_status === 'partial') {
            sendSupplierDepositEmail({
              supplier_name:     supR.rows[0].supplier_name,
              contact_email:     supR.rows[0].contact_email,
              event_name:        supR.rows[0].event_name,
              deposit_amount:    rows[0].deposit_amount,
              contracted_amount: rows[0].contracted_amount,
              payment_proof_url: rows[0].payment_proof_url,
            }, eCfg).catch(e => console.error('⚠️ Email abono proveedor:', e.message));
          } else {
            sendSupplierPaidEmail({
              supplier_name:     supR.rows[0].supplier_name,
              contact_email:     supR.rows[0].contact_email,
              event_name:        supR.rows[0].event_name,
              contracted_amount: rows[0].contracted_amount,
              payment_proof_url: rows[0].payment_proof_url,
            }, eCfg).catch(e => console.error('⚠️ Email pago completo proveedor:', e.message));
          }
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
              e.name AS event_name, e.starts_at, e.timezone, e.config AS event_config
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
    const emailCfgQ = { from_name: contract.event_config?.email_from_name || null, reply_to: contract.event_config?.email_reply_to || null };
    await sendSupplierQuoteEmail(contract, quoteUrl, emailCfgQ);
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
      `WITH
         total_regs AS (
           SELECT COUNT(*)::int AS n FROM events.registrations WHERE event_id = $1
         ),
         session_regs AS (
           SELECT rs.session_id, COUNT(DISTINCT rs.registration_id)::int AS total_registered
           FROM events.registration_sessions rs
           JOIN events.registrations r ON r.id = rs.registration_id
           WHERE r.event_id = $1
           GROUP BY rs.session_id
         )
       SELECT
         sess.id                                                              AS session_id,
         COALESCE(sess.name, 'Entrada general')                              AS name,
         COUNT(DISTINCT c.registration_id)::int                              AS count,
         COALESCE(sr.total_registered, (SELECT n FROM total_regs))::int      AS total_registered
       FROM events.registration_checkins c
       LEFT JOIN events.event_sessions sess ON sess.id = c.session_id
       LEFT JOIN session_regs sr ON sr.session_id = sess.id
       WHERE c.event_id = $1
       GROUP BY sess.id, sess.name, sr.total_registered
       ORDER BY count DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /api/events/:id/checkin-stats:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/suppliers/invite', auth, async (req, res) => {
  const pool = global.pool;
  const { event_id } = req.body;
  try {
    const userRes = await pool.query('SELECT name, email FROM public.users WHERE id = $1', [req.user.id]);
    const invitedBy = userRes.rows[0]?.name || userRes.rows[0]?.email || 'El equipo';
    let eventName = null;
    if (event_id) {
      const evRes = await pool.query(
        'SELECT name FROM events.events WHERE id = $1 AND user_id = $2',
        [event_id, req.user.id]
      );
      eventName = evRes.rows[0]?.name || null;
    }
    const { rows } = await pool.query(
      `INSERT INTO events.supplier_invite_tokens (user_id, event_id, event_name_cache, invited_by_name)
       VALUES ($1, $2, $3, $4) RETURNING token`,
      [req.user.id, event_id || null, eventName, invitedBy]
    );
    res.json({ token: rows[0].token });
  } catch (err) {
    console.error('❌ POST /suppliers/invite:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// INVITATION BATCHES — Batches de invitaciones para talento (E1.5)
// P-2: filtro user_id en todas las queries
// P-3: claim público en withTransaction con FOR UPDATE sobre el batch
// ═══════════════════════════════════════════════════════════════════════════

// Helper: verificar ownership del evento (admin ve todo, organizador solo lo suyo)
async function getEventForUser(pool, eventId, user) {
  const isAdmin = user.role === 'admin';
  const q = isAdmin
    ? `SELECT id, user_id, name, slug, starts_at, ends_at, timezone, config FROM events.events WHERE id = $1`
    : `SELECT id, user_id, name, slug, starts_at, ends_at, timezone, config FROM events.events WHERE id = $1 AND user_id = $2`;
  const params = isAdmin ? [eventId] : [eventId, user.id];
  const { rows } = await pool.query(q, params);
  return rows[0] || null;
}

// LISTAR batches del evento
router.get('/:eventId/invitation-batches', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const ev = await getEventForUser(pool, req.params.eventId, req.user);
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows } = await pool.query(
      `SELECT b.*,
              (SELECT COUNT(*) FROM events.registrations r
                 WHERE r.invitation_batch_id = b.id AND r.status = 'pending') AS pending_count,
              (SELECT COUNT(*) FROM events.registrations r
                 WHERE r.invitation_batch_id = b.id AND r.status = 'confirmed') AS confirmed_count
         FROM events.registration_invitation_batches b
         WHERE b.event_id = $1
         ORDER BY b.created_at DESC`,
      [req.params.eventId]
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /invitation-batches:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// CREAR batch
router.post('/:eventId/invitation-batches', auth, async (req, res) => {
  const pool = global.pool;
  const {
    label, quota, ticket_type = 'talent',
    assigned_to_name, assigned_to_email, assigned_to_phone,
    auto_approve = false, notes, expires_at,
    mode = 'claim', session_scope = 'event_wide', session_ids = [],
  } = req.body;
  if (!['claim','roster'].includes(mode)) return res.status(400).json({ error: 'mode inválido' });
  if (!['event_wide','specific_sessions'].includes(session_scope)) return res.status(400).json({ error: 'session_scope inválido' });
  const sessIds = Array.isArray(session_ids) ? session_ids.filter(Boolean) : [];
  if (session_scope === 'specific_sessions' && sessIds.length === 0) {
    return res.status(400).json({ error: 'Debes seleccionar al menos una sesión' });
  }

  if (!label?.trim()) return res.status(400).json({ error: 'El label es requerido' });
  const quotaNum = parseInt(quota);
  if (!quotaNum || quotaNum < 1) return res.status(400).json({ error: 'Cupo debe ser ≥ 1' });

  try {
    const ev = await getEventForUser(pool, req.params.eventId, req.user);
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });

    // Validar expires_at ≤ event.ends_at (P-5: timezone propio del evento implícito en TIMESTAMPTZ)
    if (expires_at) {
      const exp = new Date(expires_at);
      if (isNaN(exp.getTime())) return res.status(400).json({ error: 'Fecha de expiración inválida' });
      if (exp > new Date(ev.ends_at)) {
        return res.status(400).json({ error: 'La expiración no puede ser posterior al fin del evento' });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO events.registration_invitation_batches
         (event_id, user_id, label, ticket_type, quota,
          assigned_to_name, assigned_to_email, assigned_to_phone,
          auto_approve, notes, expires_at,
          mode, session_scope, session_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [ev.id, ev.user_id, label.trim(), ticket_type, quotaNum,
       assigned_to_name || null, assigned_to_email || null, assigned_to_phone || null,
       !!auto_approve, notes || null, expires_at || null,
       mode, session_scope, sessIds]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('❌ POST /invitation-batches:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DETALLE de un batch (incluye lista de registros)
router.get('/:eventId/invitation-batches/:batchId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const ev = await getEventForUser(pool, req.params.eventId, req.user);
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows: bRows } = await pool.query(
      `SELECT * FROM events.registration_invitation_batches WHERE id = $1 AND event_id = $2`,
      [req.params.batchId, req.params.eventId]
    );
    if (!bRows[0]) return res.status(404).json({ error: 'Batch no encontrado' });
    const { rows: regs } = await pool.query(
      `SELECT r.id, r.qr_token, r.ticket_type, r.status, r.created_at, r.custom_fields,
              a.name, a.email, a.phone, a.organization, a.job_title
         FROM events.registrations r
         JOIN events.attendees a ON a.id = r.attendee_id
        WHERE r.invitation_batch_id = $1
        ORDER BY r.created_at DESC`,
      [req.params.batchId]
    );
    res.json({ ...bRows[0], registrations: regs });
  } catch (err) {
    console.error('❌ GET /invitation-batches/:batchId:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// EDITAR batch (solo aumentar quota; label / notas / expires_at / auto_approve libres)
router.patch('/:eventId/invitation-batches/:batchId', auth, async (req, res) => {
  const pool = global.pool;
  const { label, quota, auto_approve, notes, expires_at,
          assigned_to_name, assigned_to_email, assigned_to_phone } = req.body;
  try {
    const ev = await getEventForUser(pool, req.params.eventId, req.user);
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows: cur } = await pool.query(
      `SELECT * FROM events.registration_invitation_batches WHERE id = $1 AND event_id = $2`,
      [req.params.batchId, req.params.eventId]
    );
    if (!cur[0]) return res.status(404).json({ error: 'Batch no encontrado' });
    const b = cur[0];

    if (quota !== undefined) {
      const q = parseInt(quota);
      if (!q || q < b.claimed_count) {
        return res.status(400).json({ error: `Cupo no puede ser menor que el ya reclamado (${b.claimed_count})` });
      }
      if (q < b.quota) {
        return res.status(400).json({ error: 'Cupo solo puede aumentar, no disminuir' });
      }
    }
    if (expires_at) {
      const exp = new Date(expires_at);
      if (isNaN(exp.getTime())) return res.status(400).json({ error: 'Fecha inválida' });
      if (exp > new Date(ev.ends_at)) {
        return res.status(400).json({ error: 'La expiración no puede ser posterior al fin del evento' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE events.registration_invitation_batches SET
         label             = COALESCE($1, label),
         quota             = COALESCE($2, quota),
         auto_approve      = COALESCE($3, auto_approve),
         notes             = COALESCE($4, notes),
         expires_at        = $5,
         assigned_to_name  = COALESCE($6, assigned_to_name),
         assigned_to_email = COALESCE($7, assigned_to_email),
         assigned_to_phone = COALESCE($8, assigned_to_phone),
         updated_at        = NOW()
       WHERE id = $9 AND event_id = $10
       RETURNING *`,
      [label || null, quota ? parseInt(quota) : null,
       auto_approve === undefined ? null : !!auto_approve,
       notes === undefined ? null : notes,
       expires_at === undefined ? b.expires_at : expires_at,
       assigned_to_name === undefined ? null : assigned_to_name,
       assigned_to_email === undefined ? null : assigned_to_email,
       assigned_to_phone === undefined ? null : assigned_to_phone,
       req.params.batchId, req.params.eventId]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ PATCH /invitation-batches:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// REVOCAR batch (soft-delete — no afecta registros ya creados)
router.post('/:eventId/invitation-batches/:batchId/revoke', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const ev = await getEventForUser(pool, req.params.eventId, req.user);
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows } = await pool.query(
      `UPDATE events.registration_invitation_batches
         SET revoked_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND event_id = $2 AND revoked_at IS NULL
       RETURNING id, revoked_at, claimed_count`,
      [req.params.batchId, req.params.eventId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Batch no encontrado o ya revocado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ POST /invitation-batches/revoke:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// APROBAR pending en bloque — confirma todos los registros pending del batch y emite QR
router.post('/:eventId/invitation-batches/:batchId/approve-pending', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const ev = await getEventForUser(pool, req.params.eventId, req.user);
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows: bRows } = await pool.query(
      `SELECT * FROM events.registration_invitation_batches WHERE id = $1 AND event_id = $2`,
      [req.params.batchId, req.params.eventId]
    );
    if (!bRows[0]) return res.status(404).json({ error: 'Batch no encontrado' });

    const { rows: approved } = await pool.query(
      `UPDATE events.registrations r
         SET status = 'confirmed', updated_at = NOW()
       FROM events.attendees a
       WHERE r.attendee_id = a.id
         AND r.invitation_batch_id = $1
         AND r.status = 'pending'
       RETURNING r.id, r.qr_token, r.ticket_type, a.name, a.email`,
      [req.params.batchId]
    );

    const emailConfig = { from_name: ev.config?.email_from_name || null, reply_to: ev.config?.email_reply_to || null };
    const batch = bRows[0];
    for (const r of approved) {
      sendInvitationConfirmedEmail(
        { name: r.name, email: r.email }, ev,
        { id: r.id, qr_token: r.qr_token, ticket_type: r.ticket_type }, batch,
        emailConfig
      ).catch(e => console.error('⚠️ Email confirmación talento fallido:', e.message));
    }

    global.io?.to(`event_${ev.id}`).emit('invitation.approved', {
      event_id: ev.id, batch_id: req.params.batchId, count: approved.length,
    });

    res.json({ approved: approved.length });
  } catch (err) {
    console.error('❌ POST /invitation-batches/approve-pending:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// APROBAR un registro individual del batch
router.patch('/:eventId/registrations/:regId/approve', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const ev = await getEventForUser(pool, req.params.eventId, req.user);
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });

    const { rows } = await pool.query(
      `UPDATE events.registrations r
         SET status = 'confirmed', updated_at = NOW()
       FROM events.attendees a
       WHERE r.attendee_id = a.id
         AND r.id = $1 AND r.event_id = $2 AND r.status = 'pending'
       RETURNING r.id, r.qr_token, r.ticket_type, r.invitation_batch_id, a.name, a.email`,
      [req.params.regId, req.params.eventId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Registro no encontrado o no está pendiente' });
    const r = rows[0];

    const emailConfig = { from_name: ev.config?.email_from_name || null, reply_to: ev.config?.email_reply_to || null };
    let batch = null;
    if (r.invitation_batch_id) {
      const { rows: bb } = await pool.query(`SELECT * FROM events.registration_invitation_batches WHERE id = $1`, [r.invitation_batch_id]);
      batch = bb[0];
    }
    if (batch) {
      sendInvitationConfirmedEmail(
        { name: r.name, email: r.email }, ev,
        { id: r.id, qr_token: r.qr_token, ticket_type: r.ticket_type }, batch,
        emailConfig
      ).catch(e => console.error('⚠️ Email aprobación fallido:', e.message));
    } else {
      sendEventRegistrationEmail(
        { name: r.name, email: r.email }, ev,
        { id: r.id, qr_token: r.qr_token, ticket_type: r.ticket_type },
        emailConfig
      ).catch(e => console.error('⚠️ Email aprobación fallido:', e.message));
    }

    global.io?.to(`event_${ev.id}`).emit('invitation.approved', {
      event_id: ev.id, batch_id: r.invitation_batch_id, count: 1,
    });
    res.json({ ok: true, registration_id: r.id });
  } catch (err) {
    console.error('❌ PATCH /registrations/:regId/approve:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ROSTER: carga masiva de invitados pre-aprobados — emite QR inmediatamente
router.post('/:eventId/invitation-batches/:batchId/roster', auth, async (req, res) => {
  const pool = global.pool;
  const { recipients } = req.body;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'recipients debe ser un array no vacío' });
  }
  try {
    const ev = await getEventForUser(pool, req.params.eventId, req.user);
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows: bRows } = await pool.query(
      `SELECT * FROM events.registration_invitation_batches WHERE id = $1 AND event_id = $2`,
      [req.params.batchId, req.params.eventId]
    );
    if (!bRows[0]) return res.status(404).json({ error: 'Batch no encontrado' });
    const batch = bRows[0];
    if (batch.revoked_at) return res.status(410).json({ error: 'Batch revocado' });
    if (batch.expires_at && new Date(batch.expires_at) < new Date()) return res.status(410).json({ error: 'Batch expirado' });

    const remaining = batch.quota - batch.claimed_count;
    if (recipients.length > remaining) {
      return res.status(400).json({ error: `Cupo insuficiente: ${remaining} disponibles, ${recipients.length} en el roster` });
    }

    const created = await withTransaction(pool, async (client) => {
      // FOR UPDATE sobre el batch para serializar contra claims concurrentes
      const { rows: b2 } = await client.query(
        `SELECT * FROM events.registration_invitation_batches WHERE id = $1 FOR UPDATE`,
        [batch.id]
      );
      const b = b2[0];
      if (recipients.length > (b.quota - b.claimed_count)) {
        const e = new Error('Cupo insuficiente'); e.httpStatus = 400; throw e;
      }

      const out = [];
      for (const rcp of recipients) {
        const name = (rcp.name || '').trim();
        const email = (rcp.email || '').trim().toLowerCase();
        if (!name || !email) continue;
        // upsert attendee
        const { rows: aR } = await client.query(
          `INSERT INTO events.attendees (event_id, user_id, name, email, phone, organization)
             VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (event_id, email) DO UPDATE SET
             name = EXCLUDED.name,
             phone = COALESCE(EXCLUDED.phone, events.attendees.phone),
             organization = COALESCE(EXCLUDED.organization, events.attendees.organization),
             updated_at = NOW()
           RETURNING id`,
          [ev.id, ev.user_id, name, email, rcp.phone || null, rcp.organization || null]
        );
        const attendeeId = aR[0].id;
        const { rows: rR } = await client.query(
          `INSERT INTO events.registrations
             (event_id, user_id, attendee_id, ticket_type, status, origin, invitation_batch_id, custom_fields)
           VALUES ($1,$2,$3,$4,'confirmed','invitation',$5,$6)
           ON CONFLICT (event_id, attendee_id) DO UPDATE SET
             ticket_type = EXCLUDED.ticket_type,
             status = 'confirmed',
             invitation_batch_id = EXCLUDED.invitation_batch_id,
             updated_at = NOW()
           RETURNING id, qr_token, ticket_type`,
          [ev.id, ev.user_id, attendeeId, batch.ticket_type, batch.id, rcp.custom_fields || {}]
        );
        const reg = rR[0];

        if (b.session_scope === 'specific_sessions' && Array.isArray(b.session_ids) && b.session_ids.length) {
          for (const sid of b.session_ids) {
            await client.query(
              `INSERT INTO events.registration_sessions (registration_id, session_id, user_id)
                 VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
              [reg.id, sid, ev.user_id]
            );
          }
        }
        out.push({ ...reg, name, email });
      }

      await client.query(
        `UPDATE events.registration_invitation_batches SET claimed_count = claimed_count + $1, updated_at = NOW() WHERE id = $2`,
        [out.length, batch.id]
      );
      return out;
    });

    const emailConfig = { from_name: ev.config?.email_from_name || null, reply_to: ev.config?.email_reply_to || null };
    for (const r of created) {
      sendInvitationConfirmedEmail(
        { name: r.name, email: r.email }, ev,
        { id: r.id, qr_token: r.qr_token, ticket_type: r.ticket_type }, batch,
        emailConfig
      ).catch(e => console.error('⚠️ Email roster fallido:', e.message));
    }

    global.io?.to(`event_${ev.id}`).emit('invitation.roster', {
      event_id: ev.id, batch_id: batch.id, count: created.length,
    });

    res.status(201).json({ created: created.length });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('❌ POST /invitation-batches/roster:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
