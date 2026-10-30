// Events v1 — Rutas autenticadas (organizador / productor)
// P-2: todo filtro incluye user_id | P-3: mutaciones ≥2 tablas usan withTransaction
// Fase: E2

'use strict';
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const { withTransaction } = require('../db/withTransaction');
const { sendEventRegistrationEmail, sendSupplierQuoteEmail, sendSupplierAcceptedEmail, sendSupplierDepositEmail, sendSupplierPaidEmail, sendInvitationConfirmedEmail, sendInvitationPendingEmail, sendStaffCredentialsEmail, sendStaffBriefingEmail } = require('../services/email');
const calendarRouter = require('./events-calendar');
const { syncEventToCalendars, deleteEventFromCalendars } = calendarRouter;
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');

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
                      e.config, e.parent_event_id,
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
  const { name, category, contact_name, contact_email, contact_phone, notes, locale: rawLocale } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  const locale = ['es','en','pt-BR'].includes(rawLocale) ? rawLocale : 'es';
  try {
    const { rows } = await pool.query(
      `INSERT INTO events.suppliers (user_id, name, category, contact_name, contact_email, contact_phone, notes, locale)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, name.trim(), category || null, contact_name || null,
       contact_email || null, contact_phone || null, notes || null, locale]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ POST /suppliers:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/suppliers/:supId', auth, async (req, res) => {
  const pool = global.pool;
  const { name, category, contact_name, contact_email, contact_phone, notes, locale: rawLocale } = req.body;
  const locale = ['es','en','pt-BR'].includes(rawLocale) ? rawLocale : null;
  try {
    const { rows } = await pool.query(
      `UPDATE events.suppliers SET
         name          = COALESCE($1, name),
         category      = COALESCE($2, category),
         contact_name  = COALESCE($3, contact_name),
         contact_email = COALESCE($4, contact_email),
         contact_phone = COALESCE($5, contact_phone),
         notes         = COALESCE($6, notes),
         locale        = COALESCE($9, locale)
       WHERE id = $7 AND user_id = $8 RETURNING *`,
      [name || null, category || null, contact_name || null,
       contact_email || null, contact_phone || null, notes || null,
       req.params.supId, req.user.id, locale]
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

// ── CATÁLOGO TENANT DE STAFF (S208n — reciclable entre eventos) ──────────────
// Rutas aditivas que deben estar ANTES de /:id para no ser capturadas

router.get('/staff-catalog', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              COUNT(DISTINCT es.event_id)::int AS event_count,
              (SELECT e2.name
               FROM events.event_staff es2
               JOIN events.events e2 ON e2.id = es2.event_id
               WHERE es2.catalog_id = c.id
               ORDER BY e2.starts_at DESC NULLS LAST
               LIMIT 1) AS last_event_name
       FROM events.staff_catalog c
       LEFT JOIN events.event_staff es ON es.catalog_id = c.id
       WHERE c.user_id = $1
       GROUP BY c.id
       ORDER BY c.name`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /staff-catalog:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/staff-catalog', auth, async (req, res) => {
  const pool = global.pool;
  const { name, email, phone, default_role, notes } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name requerido' });
  const validRoles = ['coordinator','registration','tech','host','security','catering','artistic_entertainment','other'];
  if (default_role && !validRoles.includes(default_role)) {
    return res.status(400).json({ error: 'default_role inválido' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO events.staff_catalog (user_id, name, email, phone, default_role, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, String(name).trim(), email || null, phone || null, default_role || null, notes || null]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe staff con ese email' });
    console.error('❌ POST /staff-catalog:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/staff-catalog/:catId', auth, async (req, res) => {
  const pool = global.pool;
  const fields = ['name','email','phone','default_role','notes'];
  const sets = [], params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      params.push(req.body[f] === '' ? null : req.body[f]);
      sets.push(`${f} = $${params.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
  sets.push(`updated_at = NOW()`);
  params.push(req.params.catId, req.user.id);
  try {
    const { rows } = await pool.query(
      `UPDATE events.staff_catalog SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Staff no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe staff con ese email' });
    console.error('❌ PATCH /staff-catalog:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.delete('/staff-catalog/:catId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM events.staff_catalog WHERE id = $1 AND user_id = $2',
      [req.params.catId, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Staff no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ DELETE /staff-catalog:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── INVITACIONES TENANT (S208n — vista agregada cross-events) ────────────────
router.get('/invitation-batches', auth, async (req, res) => {
  const pool = global.pool;
  const { event_id } = req.query;
  try {
    const params = [req.user.id];
    let where = `e.user_id = $1`;
    if (event_id) { params.push(event_id); where += ` AND b.event_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT b.*,
              e.id AS event_id, e.name AS event_name, e.slug AS event_slug, e.starts_at AS event_starts_at
         FROM events.registration_invitation_batches b
         JOIN events.events e ON e.id = b.event_id
        WHERE ${where}
        ORDER BY b.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /invitation-batches (tenant):', err);
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
    const event = await withTransaction(pool, async (client) => {
      const ins = await client.query(
        `INSERT INTO events.events
           (user_id, name, slug, starts_at, ends_at, timezone, venue_name, venue_address, cover_image_url, config)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.user.id, name.trim(), slug, starts_at, ends_at, timezone,
         venue_name || null, venue_address || null, cover_image_url || null, JSON.stringify(config)]
      );
      // Autoprovision owner staff_catalog (idempotente vía partial unique is_owner)
      await client.query(
        `INSERT INTO events.staff_catalog (user_id, name, email, default_role, is_owner)
         SELECT u.id, u.name, u.email, 'coordinator', TRUE
         FROM users u WHERE u.id = $1
         ON CONFLICT (user_id) WHERE is_owner = true DO NOTHING`,
        [req.user.id]
      );
      return ins.rows[0];
    });
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
                   'venue_name', 'venue_address', 'cover_image_url', 'config',
                   'publish_to_external_calendar', 'registration_mode', 'default_locale'];
  if (req.body.registration_mode !== undefined &&
      !['full_event','per_session'].includes(req.body.registration_mode)) {
    return res.status(400).json({ error: 'registration_mode inválido' });
  }
  if (req.body.default_locale !== undefined &&
      !['es','en','pt'].includes(req.body.default_locale)) {
    return res.status(400).json({ error: 'default_locale inválido (es|en|pt)' });
  }
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
    // Snapshot flag previo para detectar "publish=true → false"
    const prev = await pool.query(
      `SELECT publish_to_external_calendar FROM events.events WHERE id = $1`,
      [req.params.id]
    );
    const wasPublish = prev.rows[0]?.publish_to_external_calendar === true;

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

    // Calendar sync non-fatal
    const isPublish = rows[0].publish_to_external_calendar === true;
    if (wasPublish && !isPublish) {
      deleteEventFromCalendars(pool, rows[0].id, { purgeRows: true }).catch(e =>
        console.error('⚠️ cal.delete on toggle-off:', e.message));
    } else if (isPublish) {
      syncEventToCalendars(pool, rows[0]).catch(e =>
        console.error('⚠️ cal.sync on patch:', e.message));
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ PATCH /api/events/:id:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── VINCULAR / DESVINCULAR RUEDA A EVENTO PADRE (E-RN-9c #4/5) ───────────────
router.patch('/:id/parent', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const childId = req.params.id;
  const parentId = req.body.parent_event_id || null;
  try {
    const child = await pool.query(
      `SELECT id, user_id, config FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [childId] : [childId, req.user.id]
    );
    if (!child.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    const isRN = child.rows[0].config && child.rows[0].config.event_type === 'matchmaking';
    if (!isRN) return res.status(400).json({ error: 'Solo las ruedas de negocios pueden vincularse a un evento padre' });

    if (parentId) {
      if (parentId === childId) return res.status(400).json({ error: 'Un evento no puede ser su propio padre' });
      const parent = await pool.query(
        `SELECT id, user_id, config, parent_event_id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
        isAdmin ? [parentId] : [parentId, req.user.id]
      );
      if (!parent.rows[0]) return res.status(404).json({ error: 'Evento padre no encontrado' });
      const parentIsRN = parent.rows[0].config && parent.rows[0].config.event_type === 'matchmaking';
      if (parentIsRN) return res.status(400).json({ error: 'El padre debe ser un evento estándar, no una rueda' });
      if (parent.rows[0].parent_event_id) return res.status(400).json({ error: 'Jerarquía máxima: 2 niveles' });
    }

    const { rows } = await pool.query(
      `UPDATE events.events SET parent_event_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [parentId, childId]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ PATCH /api/events/:id/parent:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── CREAR SESIÓN ──────────────────────────────────────────────────────────────
router.post('/:id/sessions', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const { name, description, session_type = 'plenary', venue_zone,
          starts_at, ends_at, capacity, requires_registration = false,
          speaker_name = null, visibility = 'public',
          linked_rueda_id = null } = req.body;
  if (!name?.trim() || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'name, starts_at y ends_at son requeridos' });
  }
  if (ends_at <= starts_at) {
    return res.status(400).json({ error: 'ends_at debe ser posterior a starts_at' });
  }
  if (!['public','private','invite_only'].includes(visibility)) {
    return res.status(400).json({ error: 'visibility inválido' });
  }
  if (session_type === 'rueda' && !linked_rueda_id) {
    return res.status(400).json({ error: 'session_type=rueda requiere linked_rueda_id' });
  }
  const evCheck = await pool.query(
    `SELECT id, user_id, timezone FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
    isAdmin ? [req.params.id] : [req.params.id, req.user.id]
  );
  if (!evCheck.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });

  // Validar que la rueda vinculada existe, es del mismo tenant y es matchmaking.
  if (linked_rueda_id) {
    const rq = await pool.query(
      `SELECT id, user_id, (config->>'event_type') AS etype
         FROM events.events WHERE id = $1`,
      [linked_rueda_id]
    );
    if (rq.rowCount === 0) return res.status(400).json({ error: 'linked_rueda_id no existe' });
    if (rq.rows[0].user_id !== evCheck.rows[0].user_id) {
      return res.status(400).json({ error: 'linked_rueda_id pertenece a otro tenant' });
    }
    if (rq.rows[0].etype !== 'matchmaking') {
      return res.status(400).json({ error: 'linked_rueda_id no es rueda de negocios' });
    }
  }

  try {
    const tz = evCheck.rows[0].timezone || 'America/Bogota';
    const { rows } = await pool.query(
      `INSERT INTO events.event_sessions
         (event_id, user_id, name, description, session_type, venue_zone,
          starts_at, ends_at, capacity, requires_registration, speaker_name, visibility,
          linked_rueda_id, share_token)
       VALUES ($1,$2,$3,$4,$5,$6,
         ($7::timestamp AT TIME ZONE $11),
         ($8::timestamp AT TIME ZONE $11),
         $9,$10,$12,$13::varchar,$14,
         CASE WHEN $13::varchar = 'invite_only' THEN gen_random_uuid() ELSE NULL END) RETURNING *`,
      [req.params.id, evCheck.rows[0].user_id, name.trim(), description || null,
       session_type, venue_zone || null, starts_at, ends_at, capacity || null, requires_registration, tz,
       (speaker_name && String(speaker_name).trim()) || null, visibility,
       linked_rueda_id]
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
      `SELECT s.*, estf.name AS assigned_staff_name,
              rev.name AS linked_rueda_name, rev.slug AS linked_rueda_slug,
              rev.status AS linked_rueda_status
       FROM events.event_sessions s ${join}
       LEFT JOIN events.event_staff estf ON estf.id = s.assigned_staff_id
       LEFT JOIN events.events rev ON rev.id = s.linked_rueda_id
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
// ── PLANTILLA XLSX DINÁMICA (híbrida: estándar + custom del evento) ──────────
router.get('/:id/registrations/template.xlsx', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const r = await pool.query(
      `SELECT id, name, slug, config FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const ev = r.rows[0];
    const cfg = ev.config || {};
    const customFields = Array.isArray(cfg.registration_fields) ? cfg.registration_fields : [];

    // Columnas estándar que el backend reconoce (coinciden con STD_KEYS del import)
    const stdHeaders = ['nombre','email','telefono','tipo_documento','cedula','empresa','cargo','tipo_ticket'];
    const stdExample = ['Juan Pérez','juan@ejemplo.com','3001234567','CC','1012345678','Empresa SAS','Gerente','general'];

    // Agregar campos custom del formulario del evento (keys slug-safe)
    const slugify = (s) => String(s || '').toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0, 40);
    const customHeaders = [];
    const customExample = [];
    for (const f of customFields) {
      if (!f || !f.label || stdHeaders.includes(slugify(f.label))) continue;
      const k = f.key || slugify(f.label);
      if (!k || stdHeaders.includes(k)) continue;
      customHeaders.push(k);
      customExample.push(f.type === 'select' && Array.isArray(f.options) && f.options[0] ? f.options[0] : '');
    }

    const headers = [...stdHeaders, ...customHeaders];
    const example = [...stdExample, ...customExample];
    const emptyRow = headers.map(() => '');

    const wb = XLSX.utils.book_new();
    const wsAsistentes = XLSX.utils.aoa_to_sheet([headers, example, emptyRow, emptyRow, emptyRow]);
    wsAsistentes['!cols'] = headers.map(h => ({ wch: Math.max(14, h.length + 2) }));
    XLSX.utils.book_append_sheet(wb, wsAsistentes, 'Asistentes');

    const instrucciones = [
      [`Plantilla de importación — ${ev.name}`],
      [],
      ['Columnas obligatorias:'],
      ['  • nombre'],
      ['  • email (debe ser válido y único por evento)'],
      [],
      ['Columnas opcionales estándar:'],
      ['  • telefono, tipo_documento (CC/CE/PP/TI), cedula, empresa, cargo, tipo_ticket'],
      [],
      ['Campos custom del formulario (' + customHeaders.length + '):'],
      ...(customHeaders.length ? customHeaders.map(k => ['  • ' + k]) : [['  (ninguno configurado en este evento)']]),
      [],
      ['Reglas:'],
      ['  • La fila 2 es un ejemplo — reemplácela o elimínela.'],
      ['  • Columnas extra no listadas se guardan como custom_fields.'],
      ['  • Formato aceptado: .xlsx, .xls o .csv (UTF-8).'],
      ['  • Si un email ya existe para este evento, se omite (no duplica).'],
      [],
      [`Evento: ${ev.name}  |  Slug: ${ev.slug}  |  Generado: ${new Date().toISOString().slice(0,10)}`]
    ];
    const wsInstr = XLSX.utils.aoa_to_sheet(instrucciones);
    wsInstr['!cols'] = [{ wch: 70 }];
    XLSX.utils.book_append_sheet(wb, wsInstr, 'Instrucciones');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const safeName = (ev.slug || 'evento').replace(/[^a-z0-9-]/gi, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="plantilla-asistentes-${safeName}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('❌ GET /registrations/template.xlsx:', err);
    res.status(500).json({ error: 'Error generando plantilla' });
  }
});

router.post('/:id/registrations/import', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  // express-fileupload global middleware (index.js) consume el body multipart
  // antes de llegar al router, por eso aquí leemos de req.files en vez de multer.
  if (!req.files || !req.files.file) {
    return res.status(400).json({ error: 'Se requiere archivo CSV/XLSX (campo: file)' });
  }
  const uploaded = req.files.file;
  const buf = (uploaded.data && uploaded.data.length)
    ? uploaded.data
    : require('fs').readFileSync(uploaded.tempFilePath);

  const evCheck = await pool.query(
    `SELECT id, user_id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
    isAdmin ? [req.params.id] : [req.params.id, req.user.id]
  );
  if (!evCheck.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
  const userId = evCheck.rows[0].user_id;

  // Detectar formato por extensión del archivo subido
  const fname = (uploaded.name || '').toLowerCase();
  const isXlsx = fname.endsWith('.xlsx') || fname.endsWith('.xls');
  let rows;
  try {
    if (isXlsx) {
      const wb = XLSX.read(buf, { type: 'buffer' });
      // Preferir hoja "Asistentes", si no existe tomar la primera
      const sheetName = wb.SheetNames.includes('Asistentes') ? 'Asistentes' : wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
      // Normalizar keys a minúsculas (igual que parseCSV)
      rows = raw.map(r => {
        const o = {};
        for (const k of Object.keys(r)) o[String(k).toLowerCase().trim()] = r[k];
        return o;
      });
    } else {
      rows = parseCSV(buf.toString('utf-8'));
    }
  } catch (err) {
    return res.status(400).json({ error: 'No se pudo parsear el archivo: ' + err.message });
  }
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
             (event_id, attendee_id, user_id, ticket_type, origin, custom_fields, accepted_terms, status)
           VALUES ($1,$2,$3,$4,'import',$5,TRUE,'pending')
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
      `SELECT id, name, email, phone, role, pin, custom_briefing, briefing_sent_at, created_at
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
  let { name, email, phone, role, pin, custom_briefing, catalog_id, locale: rawLocale } = req.body;
  const locale = ['es','en','pt-BR'].includes(rawLocale) ? rawLocale : 'es';
  // S208n — si viene catalog_id, prellenar desde el catálogo tenant (sin pisar lo enviado)
  if (catalog_id) {
    try {
      const cat = await pool.query(
        `SELECT name, email, phone, default_role FROM events.staff_catalog
         WHERE id = $1 AND user_id = $2`, [catalog_id, req.user.id]
      );
      if (!cat.rowCount) return res.status(404).json({ error: 'Staff del catálogo no encontrado' });
      name  = name  || cat.rows[0].name;
      email = email || cat.rows[0].email;
      phone = phone || cat.rows[0].phone;
      role  = role  || cat.rows[0].default_role;
    } catch (err) {
      console.error('❌ staff catalog prefill:', err);
      return res.status(500).json({ error: 'Error leyendo catálogo' });
    }
  }
  if (!name || !role) return res.status(400).json({ error: 'name y role son requeridos' });
  if (!VALID_STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'rol inválido' });
  const staffPin = pin ? String(pin).replace(/\D/g, '').slice(0, 6).padStart(6, '0')
                       : String(Math.floor(100000 + Math.random() * 900000));
  try {
    const ev = await pool.query('SELECT id FROM events.events WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!ev.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows } = await pool.query(
      `INSERT INTO events.event_staff (event_id, user_id, name, email, phone, role, pin, custom_briefing, catalog_id, locale)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, name, email, phone, role, pin, custom_briefing, briefing_sent_at, catalog_id, locale, created_at`,
      [req.params.id, req.user.id, name.trim(), email||null, phone||null, role, staffPin, (custom_briefing||null), catalog_id || null, locale]
    );

    // Fire-and-forget: credenciales por email si tiene email (S208j)
    if (rows[0].email) {
      pool.query(
        `SELECT e.id, e.name, e.slug, e.starts_at, e.timezone, e.venue_name, e.venue_address,
                u.name AS producer_name, u.email AS producer_email
         FROM events.events e
         JOIN public.users u ON u.id = e.user_id
         WHERE e.id = $1`,
        [req.params.id]
      ).then(ctx => {
        if (!ctx.rowCount) return;
        const ev2 = ctx.rows[0];
        const producer = { name: ev2.producer_name, email: ev2.producer_email };
        sendStaffCredentialsEmail(rows[0], ev2, producer).catch(err =>
          console.error('❌ sendStaffCredentialsEmail:', err.message)
        );
      }).catch(err => console.error('❌ staff ctx query:', err.message));
    } else {
      console.log('⚠️ Staff creado sin email, skip credentials:', rows[0].id);
    }

    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH STAFF (S208j) ───────────────────────────────────────────────────────
router.patch('/:id/staff/:staffId', auth, async (req, res) => {
  const pool = global.pool;
  const { name, email, phone, role, custom_briefing } = req.body;
  if (role !== undefined && !VALID_STAFF_ROLES.includes(role)) {
    return res.status(400).json({ error: 'rol inválido' });
  }
  const sets = [];
  const vals = [];
  let i = 1;
  if (name !== undefined)            { sets.push(`name = $${i++}`);            vals.push(String(name).trim()); }
  if (email !== undefined)           { sets.push(`email = $${i++}`);           vals.push(email || null); }
  if (phone !== undefined)           { sets.push(`phone = $${i++}`);           vals.push(phone || null); }
  if (role !== undefined)            { sets.push(`role = $${i++}`);            vals.push(role); }
  if (custom_briefing !== undefined) { sets.push(`custom_briefing = $${i++}`); vals.push(custom_briefing || null); }
  if (!sets.length) return res.status(400).json({ error: 'nada que actualizar' });
  vals.push(req.params.staffId, req.params.id, req.user.id);
  try {
    const { rows } = await pool.query(
      `UPDATE events.event_staff SET ${sets.join(', ')}
       WHERE id = $${i++} AND event_id = $${i++} AND user_id = $${i++}
       RETURNING id, name, email, phone, role, pin, custom_briefing, briefing_sent_at, created_at`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Staff no encontrado' });
    res.json(rows[0]);
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

// ── REENVIAR CREDENCIALES STAFF (S208j) ───────────────────────────────────────
router.post('/:id/staff/:staffId/resend-credentials', auth, async (req, res) => {
  const pool = global.pool;
  const rotate = req.query.rotate === '1';
  try {
    const ctx = await pool.query(
      `SELECT s.id, s.name, s.email, s.phone, s.role, s.pin, s.custom_briefing, s.briefing_sent_at, s.locale,
              e.id AS event_id, e.name AS event_name, e.slug, e.starts_at, e.timezone, e.venue_name, e.venue_address,
              u.name AS producer_name, u.email AS producer_email
       FROM events.event_staff s
       JOIN events.events e ON e.id = s.event_id
       JOIN public.users u  ON u.id = e.user_id
       WHERE s.id = $1 AND s.event_id = $2 AND s.user_id = $3`,
      [req.params.staffId, req.params.id, req.user.id]
    );
    if (!ctx.rowCount) return res.status(404).json({ error: 'Staff no encontrado' });
    const row = ctx.rows[0];
    if (!row.email) return res.status(400).json({ error: 'staff sin email' });

    let pin = row.pin;
    if (rotate) {
      pin = String(Math.floor(100000 + Math.random() * 900000));
      await pool.query(`UPDATE events.event_staff SET pin = $1 WHERE id = $2`, [pin, row.id]);
    }

    const staff = { id: row.id, name: row.name, email: row.email, role: row.role, pin, locale: row.locale };
    const event = { id: row.event_id, name: row.event_name, slug: row.slug, starts_at: row.starts_at, timezone: row.timezone, venue_name: row.venue_name, venue_address: row.venue_address };
    const producer = { name: row.producer_name, email: row.producer_email };
    await sendStaffCredentialsEmail(staff, event, producer);
    res.json({ ok: true, pin_rotated: rotate });
  } catch (err) {
    console.error('❌ resend-credentials:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ENVIAR BRIEFING STAFF (S208j) ─────────────────────────────────────────────
router.post('/:id/staff/:staffId/send-briefing', auth, async (req, res) => {
  const pool = global.pool;
  const force = req.query.force === '1';
  try {
    const ctx = await pool.query(
      `SELECT s.id, s.name, s.email, s.phone, s.role, s.pin, s.custom_briefing, s.briefing_sent_at, s.locale,
              e.id AS event_id, e.name AS event_name, e.slug, e.starts_at, e.timezone, e.venue_name, e.venue_address,
              u.name AS producer_name, u.email AS producer_email
       FROM events.event_staff s
       JOIN events.events e ON e.id = s.event_id
       JOIN public.users u  ON u.id = e.user_id
       WHERE s.id = $1 AND s.event_id = $2 AND s.user_id = $3`,
      [req.params.staffId, req.params.id, req.user.id]
    );
    if (!ctx.rowCount) return res.status(404).json({ error: 'Staff no encontrado' });
    const row = ctx.rows[0];
    if (!row.email) return res.status(400).json({ error: 'staff sin email' });
    if (row.briefing_sent_at && !force) {
      return res.status(409).json({ error: 'briefing_already_sent', sent_at: row.briefing_sent_at });
    }

    const staff = { id: row.id, name: row.name, email: row.email, role: row.role, custom_briefing: row.custom_briefing, locale: row.locale };
    const event = { id: row.event_id, name: row.event_name, slug: row.slug, starts_at: row.starts_at, timezone: row.timezone, venue_name: row.venue_name, venue_address: row.venue_address };
    const producer = { name: row.producer_name, email: row.producer_email };
    await sendStaffBriefingEmail(staff, event, producer);

    const upd = await pool.query(
      `UPDATE events.event_staff SET briefing_sent_at = NOW() WHERE id = $1 RETURNING briefing_sent_at`,
      [row.id]
    );
    res.json({ ok: true, sent_at: upd.rows[0].briefing_sent_at });
  } catch (err) {
    console.error('❌ send-briefing:', err.message);
    res.status(500).json({ error: err.message });
  }
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

    const sid = String(req.query.session_id || 'all');
    let scopeFilter = '';
    const qParams = [req.params.id, tz];
    if (sid === 'general') {
      scopeFilter = ` AND EXISTS (SELECT 1 FROM events.registration_checkins c2 WHERE c2.registration_id = r.id AND c2.session_id IS NULL)`;
    } else if (sid !== 'all') {
      scopeFilter = ` AND EXISTS (SELECT 1 FROM events.registration_checkins c2 WHERE c2.registration_id = r.id AND c2.session_id = $3)`;
      qParams.push(sid);
    }

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
       WHERE r.event_id = $1 ${scopeFilter}
       ORDER BY r.created_at ASC`,
      qParams
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
      (() => {
        const sid = String(req.query.session_id || 'all');
        let scopeFilter = '';
        const qp = [req.params.id, tz];
        if (sid === 'general') {
          scopeFilter = ` AND EXISTS (SELECT 1 FROM events.registration_checkins c2 WHERE c2.registration_id = r.id AND c2.session_id IS NULL)`;
        } else if (sid !== 'all') {
          scopeFilter = ` AND EXISTS (SELECT 1 FROM events.registration_checkins c2 WHERE c2.registration_id = r.id AND c2.session_id = $3)`;
          qp.push(sid);
        }
        return pool.query(
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
           WHERE r.event_id = $1 ${scopeFilter}
           ORDER BY r.created_at ASC`,
          qp
        );
      })(),
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
          assigned_staff_id, observations, speaker_name, visibility } = req.body;
  if (starts_at && ends_at && ends_at <= starts_at) {
    return res.status(400).json({ error: 'ends_at debe ser posterior a starts_at' });
  }
  if (visibility !== undefined && !['public','private','invite_only'].includes(visibility)) {
    return res.status(400).json({ error: 'visibility inválido' });
  }
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
         speaker_name      = COALESCE($12, speaker_name),
         visibility        = COALESCE($13::varchar, visibility),
         share_token       = CASE
           WHEN COALESCE($13::varchar, visibility) = 'invite_only' AND share_token IS NULL THEN gen_random_uuid()
           ELSE share_token
         END
       WHERE id = $1 AND event_id = $2 RETURNING *`,
      [req.params.sessionId, req.params.id,
       name?.trim() || null, starts_at || null, ends_at || null,
       capacity !== undefined ? (capacity || null) : undefined,
       venue_zone || null, description || null, tz,
       assigned_staff_id || null, observations || null,
       (speaker_name && String(speaker_name).trim()) || null,
       visibility || null]
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

// ── E3.5: asignación manual de sesión a un registro (productor) ───────────────
// Permite al productor asignar sesiones private/invite_only a un asistente ya
// registrado. 'public' también se acepta por conveniencia (idempotente).
router.post('/:id/registrations/:regId/sessions', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  const sessionIds = Array.isArray(req.body?.session_ids) ? req.body.session_ids : [];
  if (!sessionIds.length) return res.status(400).json({ error: 'session_ids requerido' });
  try {
    const owner = isAdmin ? [req.params.id] : [req.params.id, req.user.id];
    const ev = await pool.query(
      `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      owner
    );
    if (!ev.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const reg = await pool.query(
      `SELECT id FROM events.registrations WHERE id = $1 AND event_id = $2`,
      [req.params.regId, req.params.id]
    );
    if (!reg.rowCount) return res.status(404).json({ error: 'Registro no encontrado' });
    const sess = await pool.query(
      `SELECT id FROM events.event_sessions
       WHERE event_id = $1 AND status != 'cancelled' AND id = ANY($2::uuid[])`,
      [req.params.id, sessionIds]
    );
    const valid = sess.rows.map(r => r.id);
    const inserted = await withTransaction(pool, async (client) => {
      const out = [];
      for (const sid of valid) {
        const r = await client.query(
          `INSERT INTO events.registration_sessions (registration_id, session_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING session_id`,
          [req.params.regId, sid]
        );
        if (r.rows[0]) out.push(r.rows[0].session_id);
      }
      return out;
    });
    res.json({ assigned: inserted, skipped: valid.length - inserted.length });
  } catch (err) {
    console.error('❌ POST /registrations/:regId/sessions:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET sesiones asignadas a un registro (para UI de asignación manual)
router.get('/:id/registrations/:regId/sessions', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const owner = isAdmin ? [req.params.id] : [req.params.id, req.user.id];
    const ev = await pool.query(
      `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      owner
    );
    if (!ev.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const { rows } = await pool.query(
      `SELECT session_id FROM events.registration_sessions
       WHERE registration_id = $1`,
      [req.params.regId]
    );
    res.json({ session_ids: rows.map(r => r.session_id) });
  } catch (err) {
    console.error('❌ GET /registrations/:regId/sessions:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.delete('/:id/registrations/:regId/sessions/:sessionId', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const owner = isAdmin ? [req.params.id] : [req.params.id, req.user.id];
    const ev = await pool.query(
      `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      owner
    );
    if (!ev.rowCount) return res.status(404).json({ error: 'Evento no encontrado' });
    const del = await pool.query(
      `DELETE FROM events.registration_sessions
       WHERE registration_id = $1 AND session_id = $2`,
      [req.params.regId, req.params.sessionId]
    );
    res.json({ removed: del.rowCount });
  } catch (err) {
    console.error('❌ DELETE /registrations/:regId/sessions/:sessionId:', err);
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
        `SELECT s.name AS supplier_name, s.contact_email, s.locale, e.name AS event_name, e.config AS event_config
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
            locale: supR.rows[0].locale,
          }, eCfgAcc).catch(e => console.error('⚠️ Email aceptación proveedor:', e.message));
        }
      }).catch(() => {});
    }
    if ((payment_status === 'partial' || payment_status === 'paid') && rows[0].supplier_id) {
      pool.query(
        `SELECT s.name AS supplier_name, s.contact_email, s.locale, e.name AS event_name, e.config AS event_config
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
              locale:            supR.rows[0].locale,
            }, eCfg).catch(e => console.error('⚠️ Email abono proveedor:', e.message));
          } else {
            sendSupplierPaidEmail({
              supplier_name:     supR.rows[0].supplier_name,
              contact_email:     supR.rows[0].contact_email,
              event_name:        supR.rows[0].event_name,
              contracted_amount: rows[0].contracted_amount,
              payment_proof_url: rows[0].payment_proof_url,
              locale:            supR.rows[0].locale,
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
              s.name AS supplier_name, s.contact_email, s.locale,
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
    // Borrar eventos externos antes del CASCADE (non-fatal)
    try { await deleteEventFromCalendars(pool, req.params.id, { purgeRows: false }); }
    catch (e) { console.error('⚠️ cal.delete on event-delete:', e.message); }
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

// ── BRIEF PDF (información general + sesiones + enlaces) ──────────────────
router.get('/:id/brief/pdf', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const evRes = await pool.query(
      `SELECT id, name, slug, status, starts_at, ends_at, timezone, venue_name, venue_address,
              cover_image_url, config
       FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!evRes.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    const ev = evRes.rows[0];
    const tz = ev.timezone || 'America/Bogota';

    const sessionsRes = await pool.query(
      `SELECT s.name, s.description, s.observations, s.speaker_name, s.venue_zone, s.capacity,
              s.starts_at, s.ends_at, st.name AS responsible_name
       FROM events.event_sessions s
       LEFT JOIN events.event_staff st ON st.id = s.assigned_staff_id
       WHERE s.event_id = $1 AND s.status != 'cancelled'
       ORDER BY s.starts_at ASC`,
      [req.params.id]
    );
    const sessions = sessionsRes.rows;

    const base = (process.env.CMS_URL || 'https://cms.sonoro.com.co').replace(/\/$/, '');
    const publicUrl = `${base}/evento/${ev.slug}`;
    const staffUrl  = `${publicUrl}/staff`;
    const kioskoUrl = `${publicUrl}/kiosko`;

    const cfg = ev.config || {};
    const ticketTypes = Array.isArray(cfg.ticket_types) ? cfg.ticket_types : [];
    const maxCap = cfg.max_capacity ? parseInt(cfg.max_capacity) : null;
    const desc = cfg.description || cfg.event_description || '';

    const filename = `brief_${ev.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 0, size: 'A4', bufferPages: true });
    doc.pipe(res);

    const PAGE_W = 595;
    const PAGE_H = 842;
    // Marco tipo "contenedor email": fondo cálido con card blanco centrado
    const OUTER_PAD  = 24;        // gutter alrededor del card
    const CARD_X     = OUTER_PAD;
    const CARD_W     = PAGE_W - OUTER_PAD * 2;
    const CARD_PAD_X = 40;        // padding horizontal interno del card (como email)
    const M          = CARD_X + CARD_PAD_X;
    const W          = CARD_W - CARD_PAD_X * 2;

    // Paleta: hereda emails
    const MAGENTA  = '#FF1B8D';
    const HEADER   = '#0F0F0F';
    const PAGE_BG  = '#F4F4F4';
    const CARD_BG  = '#FFFFFF';
    const FOOTER_BG= '#F9F9F9';
    const RULE     = '#EEEEEE';
    const DARK     = '#111827';
    const GRAY     = '#666666';
    const GRAY_2   = '#999999';
    const SUB      = '#B0B0B0';

    const fmtDateLong = (d) => d ? new Date(d).toLocaleDateString('es-CO',
      { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }) : '—';
    const fmtDateShort = (d) => d ? new Date(d).toLocaleDateString('es-CO',
      { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    const fmtTime = (d) => d ? new Date(d).toLocaleTimeString('es-CO',
      { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
    const statusLbl = s => s === 'published' ? 'Publicado' : s === 'live' ? 'En vivo'
                        : s === 'closed' ? 'Cerrado' : s === 'archived' ? 'Archivado' : 'Borrador';

    // Fondo cálido de página (todas las páginas)
    const paintPageBg = () => {
      doc.save();
      doc.rect(0, 0, PAGE_W, PAGE_H).fill(PAGE_BG);
      doc.roundedRect(CARD_X, OUTER_PAD, CARD_W, PAGE_H - OUTER_PAD * 2, 12).fill(CARD_BG);
      doc.restore();
    };
    paintPageBg();

    // ── HEADER (negro + wordmark + hairline gradient) ────────────────────────
    const HEADER_H = 96;
    // Recorte redondeado superior del header (imita el card email)
    doc.save();
    doc.roundedRect(CARD_X, OUTER_PAD, CARD_W, HEADER_H, 12).clip();
    doc.rect(CARD_X, OUTER_PAD, CARD_W, HEADER_H).fill(HEADER);
    doc.restore();

    // Wordmark: SONORO. (punto magenta)
    doc.font('Helvetica-Bold').fontSize(28).fillColor('#FFFFFF')
       .text('SONORO', CARD_X, OUTER_PAD + 24, { width: CARD_W, align: 'center' });
    const wmW = doc.widthOfString('SONORO');
    doc.fillColor(MAGENTA)
       .text('.', (PAGE_W + wmW) / 2 - 2, OUTER_PAD + 24, { lineBreak: false });
    // Sublabel
    doc.font('Helvetica-Bold').fontSize(9).fillColor(SUB)
       .text('BRIEF DEL EVENTO', CARD_X, OUTER_PAD + 62,
             { width: CARD_W, align: 'center', characterSpacing: 3 });

    // Hairline gradient de 3px (firma de marca)
    const grad = doc.linearGradient(CARD_X, 0, CARD_X + CARD_W, 0);
    grad.stop(0, '#FF1B8D').stop(0.55, '#FF8C00').stop(1, '#FFE566');
    doc.rect(CARD_X, OUTER_PAD + HEADER_H, CARD_W, 3).fill(grad);

    // ── SUB-HEADER: nombre evento + meta ────────────────────────────────────
    let y = OUTER_PAD + HEADER_H + 3 + 32;
    const dateRange = ev.starts_at && ev.ends_at && fmtDateShort(ev.starts_at) !== fmtDateShort(ev.ends_at)
      ? `${fmtDateLong(ev.starts_at)} a ${fmtDateLong(ev.ends_at)}`
      : fmtDateLong(ev.starts_at);
    const genAt = new Date().toLocaleString('es-CO',
      { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });

    doc.font('Helvetica-Bold').fontSize(20).fillColor(DARK)
       .text(ev.name, M, y, { width: W });
    y += doc.heightOfString(ev.name, { width: W }) + 6;
    doc.font('Helvetica').fontSize(11).fillColor(GRAY)
       .text(`${dateRange}. ${ev.venue_name || 'Sin sede'}. Estado: ${statusLbl(ev.status)}.`,
             M, y, { width: W });
    y += doc.heightOfString(`${dateRange}. ${ev.venue_name || 'Sin sede'}. Estado: ${statusLbl(ev.status)}.`, { width: W }) + 4;
    doc.fillColor(GRAY_2).fontSize(9)
       .text(`Generado el ${genAt}`, M, y, { width: W });
    y += 24;

    // Rule sutil separador
    doc.strokeColor(RULE).lineWidth(1).moveTo(M, y).lineTo(M + W, y).stroke();
    y += 24;

    // ── Section helper (label uppercase + título, sin línea de color) ─────────
    const section = (title) => {
      if (y > PAGE_H - 140) { doc.addPage(); paintPageBg(); y = OUTER_PAD + 40; }
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY_2)
         .text(title.toUpperCase(), M, y, { width: W, characterSpacing: 2 });
      y += 20;
    };
    const kv = (label, value) => {
      if (y > PAGE_H - 80) { doc.addPage(); paintPageBg(); y = OUTER_PAD + 40; }
      const val = String(value || '—');
      doc.font('Helvetica').fontSize(9).fillColor(GRAY_2).text(label, M, y, { width: 130 });
      doc.font('Helvetica').fontSize(11).fillColor(DARK).text(val, M + 140, y, { width: W - 140 });
      const h = doc.heightOfString(val, { width: W - 140 });
      y += Math.max(20, h + 6);
    };

    // ── INFORMACIÓN GENERAL ──────────────────────────────────────────────────
    section('Información general');
    kv('Fechas', dateRange);
    kv('Horario', `${fmtTime(ev.starts_at)} a ${fmtTime(ev.ends_at)}`);
    kv('Zona horaria', tz);
    kv('Sede', ev.venue_name);
    if (ev.venue_address) kv('Dirección', ev.venue_address);
    kv('Capacidad máxima', maxCap ? `${maxCap} asistentes` : 'Sin límite');
    kv('Tipos de entrada', ticketTypes.length ? ticketTypes.join(', ') : 'General');
    kv('Estado', statusLbl(ev.status));
    if (desc) kv('Descripción', desc);
    y += 14;

    // Rule
    doc.strokeColor(RULE).lineWidth(1).moveTo(M, y).lineTo(M + W, y).stroke();
    y += 24;

    // ── ENLACES DEL EVENTO ───────────────────────────────────────────────────
    section('Enlaces del evento');
    const linkBlock = (title, url, hint) => {
      const hintH = doc.font('Helvetica').fontSize(10).heightOfString(hint, { width: W });
      const blockH = 18 + 14 + hintH + 8;
      if (y + blockH > PAGE_H - 80) { doc.addPage(); paintPageBg(); y = OUTER_PAD + 40; }
      doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK)
         .text(title, M, y, { width: W });
      y += 18;
      doc.font('Helvetica').fontSize(10).fillColor(MAGENTA)
         .text(url, M, y, { width: W, link: url, underline: true });
      y += 14;
      doc.font('Helvetica').fontSize(10).fillColor(GRAY)
         .text(hint, M, y, { width: W });
      y += hintH + 16;
    };
    linkBlock('Registro público',
      publicUrl,
      'Formulario de inscripción para asistentes. Comparte este enlace en tus campañas, redes sociales o correos de invitación.');
    linkBlock('App Staff (tablet)',
      staffUrl,
      'Interfaz para el equipo de recepción. Acceso por PIN. Escaneo de QR para check-in y validación de servicios.');
    linkBlock('Kiosko de check-in',
      kioskoUrl,
      'Auto check-in por escaneo de QR. Configurar en tablet o monitor a la entrada del evento en modo kiosko.');
    y += 6;

    // Rule
    doc.strokeColor(RULE).lineWidth(1).moveTo(M, y).lineTo(M + W, y).stroke();
    y += 24;

    // ── SESIONES ─────────────────────────────────────────────────────────────
    section(`Sesiones y jornadas (${sessions.length})`);
    if (!sessions.length) {
      doc.font('Helvetica-Oblique').fontSize(11).fillColor(GRAY)
         .text('Sin sesiones creadas.', M, y, { width: W });
      y += 20;
    } else {
      sessions.forEach((s, idx) => {
        // Bloque tipográfico, separado por rule 1px (sin card).
        const notes = [s.description, s.observations].filter(Boolean).join('. ');
        const metaParts = [];
        metaParts.push(fmtDateShort(s.starts_at));
        metaParts.push(`${fmtTime(s.starts_at)} a ${fmtTime(s.ends_at)}`);
        if (s.venue_zone) metaParts.push(s.venue_zone);
        if (s.capacity) metaParts.push(`Cupo ${s.capacity}`);
        const rolesParts = [];
        if (s.speaker_name) rolesParts.push(`Orador: ${s.speaker_name}`);
        if (s.responsible_name) rolesParts.push(`Responsable: ${s.responsible_name}`);

        // Estimación de alto
        const nameH  = doc.font('Helvetica-Bold').fontSize(13).heightOfString(s.name || 'Sin nombre', { width: W });
        const metaH  = doc.font('Helvetica').fontSize(10).heightOfString(metaParts.join('  ·  '), { width: W });
        const rolesH = rolesParts.length ? doc.font('Helvetica').fontSize(10).heightOfString(rolesParts.join('  ·  '), { width: W }) : 0;
        const notesH = notes ? doc.font('Helvetica').fontSize(10).heightOfString(notes, { width: W }) : 0;
        const blockH = 12 + nameH + 6 + metaH + (rolesH ? 4 + rolesH : 0) + (notesH ? 8 + notesH : 0) + 18;

        if (y + blockH > PAGE_H - 80) { doc.addPage(); paintPageBg(); y = OUTER_PAD + 40; }

        // Etiqueta jornada (neutra, no coloreada)
        doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY_2)
           .text(`JORNADA ${String(idx + 1).padStart(2, '0')}`, M, y, { characterSpacing: 2 });
        y += 12;
        // Nombre
        doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK)
           .text(s.name || 'Sin nombre', M, y, { width: W });
        y += nameH + 6;
        // Meta
        doc.font('Helvetica').fontSize(10).fillColor(GRAY)
           .text(metaParts.join('  ·  '), M, y, { width: W });
        y += metaH;
        // Roles
        if (rolesParts.length) {
          y += 4;
          doc.font('Helvetica').fontSize(10).fillColor(DARK)
             .text(rolesParts.join('  ·  '), M, y, { width: W });
          y += rolesH;
        }
        // Notas
        if (notes) {
          y += 8;
          doc.font('Helvetica').fontSize(10).fillColor(GRAY)
             .text(notes, M, y, { width: W });
          y += notesH;
        }
        y += 14;

        // Separador entre sesiones (excepto la última)
        if (idx < sessions.length - 1) {
          doc.strokeColor(RULE).lineWidth(1).moveTo(M, y).lineTo(M + W, y).stroke();
          y += 14;
        }
      });
    }

    // ── FOOTER (todas las páginas: fondo gris cálido + copy marca) ───────────
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      const footerH = 44;
      const footerY = PAGE_H - OUTER_PAD - footerH;
      // Recorte esquinas inferiores redondeadas del card
      doc.save();
      doc.roundedRect(CARD_X, footerY, CARD_W, footerH, 12).clip();
      doc.rect(CARD_X, footerY, CARD_W, footerH).fill(FOOTER_BG);
      doc.restore();
      // Línea superior del footer
      doc.strokeColor(RULE).lineWidth(1)
         .moveTo(CARD_X, footerY).lineTo(CARD_X + CARD_W, footerY).stroke();
      // Copy izquierda + paginación derecha (sin chain para evitar bug annotate)
      doc.font('Helvetica').fontSize(9).fillColor(GRAY_2)
         .text('Este brief fue generado por SONORO CMS  ·  cms@sonoro.com.co',
               M, footerY + 16, { width: W, align: 'left', lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(GRAY_2)
         .text(`Página ${i + 1} de ${pages.count}`,
               M, footerY + 16, { width: W, align: 'right', lineBreak: false });
    }

    doc.end();
  } catch (err) {
    console.error('❌ GET brief/pdf:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Error interno' });
  }
});

// ── CHECK-IN STATS POR SESIÓN (para gráfica en dashboard) ──────────────────
// Detalle de check-ins por sesión (drill-down). session_id = 'all' | 'general' | <uuid>
router.get('/:id/checkin-detail', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const evRes = await pool.query(
      `SELECT user_id, timezone FROM events.events WHERE id = $1`,
      [req.params.id]
    );
    if (!evRes.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    if (evRes.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    const tz = evRes.rows[0].timezone || 'America/Bogota';
    const sid = String(req.query.session_id || 'all');

    let where = 'c.event_id = $1';
    const params = [req.params.id];
    if (sid === 'general') {
      where += ' AND c.session_id IS NULL';
    } else if (sid !== 'all') {
      where += ' AND c.session_id = $2';
      params.push(sid);
    }

    const { rows } = await pool.query(
      `SELECT c.id, c.registration_id, c.session_id, c.event_day,
              c.checked_in_at,
              to_char(c.checked_in_at AT TIME ZONE '${tz.replace(/'/g, "''")}', 'HH12:MI AM') AS checked_in_at_label,
              a.name AS attendee_name, a.email, a.phone,
              COALESCE(s.name, 'Entrada general') AS session_name
         FROM events.registration_checkins c
         JOIN events.registrations r ON r.id = c.registration_id
         JOIN events.attendees a      ON a.id = r.attendee_id
         LEFT JOIN events.event_sessions s ON s.id = c.session_id
        WHERE ${where}
        ORDER BY c.checked_in_at DESC
        LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /api/events/:id/checkin-detail:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

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
    kind = 'individual',
    prefill = {},
    quota,
    session_scope = 'event_wide', session_ids = [],
    expires_at,
    label, ticket_type = 'invitation',
    notes,
  } = req.body;
  if (!['individual','group'].includes(kind)) return res.status(400).json({ error: 'kind inválido' });
  if (!['event_wide','specific_sessions'].includes(session_scope)) return res.status(400).json({ error: 'session_scope inválido' });
  const sessIds = Array.isArray(session_ids) ? session_ids.filter(Boolean) : [];
  if (session_scope === 'specific_sessions' && sessIds.length === 0) {
    return res.status(400).json({ error: 'Debes seleccionar al menos una sesión' });
  }

  const pfName  = (prefill?.name  || '').trim();
  const pfEmail = (prefill?.email || '').trim().toLowerCase();
  const pfPhone = (prefill?.phone || '').trim();
  if (!pfName)  return res.status(400).json({ error: 'Nombre del invitado/responsable es requerido' });
  if (!pfEmail) return res.status(400).json({ error: 'Email del invitado/responsable es requerido' });

  const quotaNum = kind === 'individual' ? 1 : parseInt(quota);
  if (!quotaNum || quotaNum < 1) return res.status(400).json({ error: 'Cupo debe ser ≥ 1' });
  if (kind === 'group' && quotaNum < 2) return res.status(400).json({ error: 'Grupo debe tener al menos 2 cupos' });

  const batchLabel = (label && label.trim()) || (kind === 'individual' ? pfName : `Grupo de ${pfName}`);

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

    const prefillJson = { name: pfName, email: pfEmail, phone: pfPhone || null };
    const { rows } = await pool.query(
      `INSERT INTO events.registration_invitation_batches
         (event_id, user_id, label, ticket_type, quota,
          assigned_to_name, assigned_to_email, assigned_to_phone,
          auto_approve, notes, expires_at,
          mode, session_scope, session_ids,
          kind, prefill)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [ev.id, ev.user_id, batchLabel, ticket_type, quotaNum,
       pfName, pfEmail, pfPhone || null,
       true, notes || null, expires_at || null,
       'claim', session_scope, sessIds,
       kind, prefillJson]
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
          assigned_to_name, assigned_to_email, assigned_to_phone,
          prefill, session_scope, session_ids } = req.body;
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

    // Construir prefill nuevo si vino en payload
    let prefillJson = null;
    let newPfName = null, newPfEmail = null, newPfPhone = null;
    if (prefill && typeof prefill === 'object') {
      newPfName  = (prefill.name  || '').trim();
      newPfEmail = (prefill.email || '').trim().toLowerCase();
      newPfPhone = (prefill.phone || '').trim();
      if (!newPfName || !newPfEmail) return res.status(400).json({ error: 'prefill requiere name y email' });
      prefillJson = { name: newPfName, email: newPfEmail, phone: newPfPhone || null };
    }
    const sessIds = Array.isArray(session_ids) ? session_ids.filter(Boolean) : null;
    if (session_scope && !['event_wide','specific_sessions'].includes(session_scope)) {
      return res.status(400).json({ error: 'session_scope inválido' });
    }
    if (session_scope === 'specific_sessions' && (!sessIds || sessIds.length === 0)) {
      return res.status(400).json({ error: 'Debes seleccionar al menos una sesión' });
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
         prefill           = COALESCE($9::jsonb, prefill),
         session_scope     = COALESCE($10, session_scope),
         session_ids       = COALESCE($11, session_ids),
         updated_at        = NOW()
       WHERE id = $12 AND event_id = $13
       RETURNING *`,
      [label || null, quota ? parseInt(quota) : null,
       auto_approve === undefined ? null : !!auto_approve,
       notes === undefined ? null : notes,
       expires_at === undefined ? b.expires_at : expires_at,
       prefillJson ? newPfName  : (assigned_to_name  === undefined ? null : assigned_to_name),
       prefillJson ? newPfEmail : (assigned_to_email === undefined ? null : assigned_to_email),
       prefillJson ? newPfPhone : (assigned_to_phone === undefined ? null : assigned_to_phone),
       prefillJson ? JSON.stringify(prefillJson) : null,
       session_scope || null,
       sessIds,
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

// S210-exec #5 — Billing upgrade (events.licenses only, NUNCA public.licenses)
// Aislamiento duro: ver docs/CLAUDE.md §Regla dura + docs/EVENTS-FRAMEWORK.md §0.1
const TIER_RANK_EV = { trial: 0, lite: 1, pro: 2, masivo: 3 };
const PAID_TIERS_EV = new Set(['lite', 'pro', 'masivo']);
const BILLING_PERIODS_EV = new Set(['monthly', 'annual']);

router.post('/billing/upgrade', auth, async (req, res) => {
  try {
    const pool = global.pool;
    const { target_tier, billing_period, payment_method, payment_reference } = req.body || {};

    if (!PAID_TIERS_EV.has(target_tier)) {
      return res.status(400).json({ error: 'target_tier inválido', code: 'INVALID_TIER' });
    }
    if (!BILLING_PERIODS_EV.has(billing_period)) {
      return res.status(400).json({ error: 'billing_period inválido', code: 'INVALID_PERIOD' });
    }

    const result = await withTransaction(pool, async (client) => {
      const cur = await client.query(
        `SELECT id, tier, status, currency FROM events.licenses
          WHERE user_id = $1 AND status IN ('active','grace','readonly')
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [req.user.id]
      );
      if (!cur.rows.length) {
        const e = new Error('No hay licencia Events activa para convertir'); e.httpStatus = 404; throw e;
      }
      const current = cur.rows[0];

      if (current.tier === target_tier && current.status === 'active') {
        const e = new Error('Ya estás en ese tier'); e.httpStatus = 409; throw e;
      }
      if (current.tier !== 'trial' && TIER_RANK_EV[target_tier] <= TIER_RANK_EV[current.tier]) {
        const e = new Error('Downgrade no soportado en este endpoint'); e.httpStatus = 400; throw e;
      }

      await client.query(
        `UPDATE events.licenses SET status='converted', end_date=NOW(), updated_at=NOW() WHERE id=$1`,
        [current.id]
      );

      const interval = billing_period === 'annual' ? "INTERVAL '365 days'" : "INTERVAL '30 days'";
      const currency = current.currency || 'COP';
      const metadata = {
        usage: { attendees: 0, events: 0 },
        payment: { method: payment_method || 'manual', reference: payment_reference || null, converted_from: current.id }
      };

      const ins = await client.query(
        `INSERT INTO events.licenses
           (user_id, tier, status, currency, billing_period, start_date, end_date, trial_days, metadata, created_by)
         VALUES ($1, $2, 'active', $3, $4, NOW(), NOW() + ${interval}, 0, $5::jsonb, $1)
         RETURNING *`,
        [req.user.id, target_tier, currency, billing_period, JSON.stringify(metadata)]
      );
      return { previous_id: current.id, license: ins.rows[0] };
    });

    res.status(201).json(result);
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message, code: err.code });
    console.error('❌ POST /billing/upgrade:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// S210e #14 — GET /license/status
// UI "Mis Licencias" card Events. Lectura pura filtrada por user_id.
// Admin → is_admin_bypass:true. Sin licencia → status:'no_license'.
// Aislamiento duro: solo events.licenses, nunca public.licenses.
// Montado fuera del gate (ver requireEventsAccess.js SAFE_PATHS).
router.get('/license/status', auth, async (req, res) => {
  try {
    const pool = global.pool;

    if (req.user.role === 'admin') {
      return res.json({ status: 'admin_bypass', is_admin_bypass: true });
    }

    const feature_on = req.user.features?.events_v1 === true;

    const { rows } = await pool.query(
      `SELECT id, tier, status, currency, billing_period,
              start_date, end_date, trial_days, metadata
         FROM events.licenses
        WHERE user_id = $1 AND status IN ('active','grace','readonly')
        ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );

    if (!rows.length) {
      return res.json({ status: 'no_license', feature_on });
    }

    const lic = rows[0];
    const now = Date.now();
    const endMs = lic.end_date ? new Date(lic.end_date).getTime() : null;
    const days_left = endMs !== null ? Math.ceil((endMs - now) / 86400000) : null;

    return res.json({
      status: lic.status,
      tier: lic.tier,
      currency: lic.currency,
      billing_period: lic.billing_period,
      start_date: lic.start_date,
      end_date: lic.end_date,
      days_left,
      trial_days: lic.trial_days,
      feature_on
    });
  } catch (err) {
    console.error('❌ GET /license/status:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ANALYTICS — Panel resumen agregado (Pro / Masivo / Admin)
// ═══════════════════════════════════════════════════════════════════

async function requireAnalyticsAccess(req, res, next) {
  try {
    if (req.user.role === 'admin') { req._licTier = 'admin'; return next(); }
    const pool = global.pool;
    const { rows } = await pool.query(
      `SELECT tier, status FROM events.licenses
        WHERE user_id = $1 AND status IN ('active','grace','readonly')
        ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(403).json({ error: 'Sin licencia Events', code: 'no_license' });
    if (!['pro', 'masivo'].includes(rows[0].tier)) {
      return res.status(403).json({ error: 'Panel resumen disponible solo en Pro y Masivo', code: 'tier_locked', tier: rows[0].tier });
    }
    req._licTier = rows[0].tier;
    next();
  } catch (err) {
    console.error('❌ requireAnalyticsAccess:', err);
    res.status(500).json({ error: 'Error interno' });
  }
}

function parseAnalyticsRange(q) {
  // Devuelve { from: Date, to: Date } con default = últimos 12 meses.
  // Soporta ?from=&to= (ISO) o ?range=last30d|last90d|last12m|ytd|all.
  const now = new Date();
  if (q.from || q.to) {
    let to = q.to ? new Date(q.to) : now;
    let from = q.from ? new Date(q.from) : new Date(now.getTime() - 365 * 86400000);
    if (isNaN(from.getTime())) from = new Date(now.getTime() - 365 * 86400000);
    if (isNaN(to.getTime())) to = now;
    return { from, to };
  }
  const r = String(q.range || 'last12m');
  if (r === 'last30d')  return { from: new Date(now.getTime() -  30*86400000), to: now };
  if (r === 'last90d')  return { from: new Date(now.getTime() -  90*86400000), to: now };
  if (r === 'ytd')      return { from: new Date(now.getFullYear(), 0, 1), to: now };
  if (r === 'all')      return { from: new Date(2020, 0, 1), to: now };
  return { from: new Date(now.getTime() - 365*86400000), to: now };
}

// Carga el payload de /analytics/overview. Reutilizado por GET + export.xlsx + export.pdf.
async function loadAnalyticsOverview(pool, userId, from, to) {
  const eventsAgg = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE status IN ('closed','archived') OR ends_at < NOW()) AS done,
        COUNT(*) FILTER (WHERE status IN ('draft','published','live') AND ends_at >= NOW()) AS scheduled,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        COUNT(*) AS total
       FROM events.events
      WHERE user_id = $1 AND starts_at >= $2 AND starts_at <= $3`,
    [userId, from, to]
  );
  const curAgg = await pool.query(
    `SELECT currency FROM events.licenses
       WHERE user_id = $1 AND status IN ('active','grace','readonly')
       ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const currency = curAgg.rows[0]?.currency || 'COP';
  const attAgg = await pool.query(
    `WITH past_events AS (
       SELECT id FROM events.events
        WHERE user_id = $1 AND starts_at >= $2 AND starts_at <= $3
          AND ends_at < NOW()
     ),
     regs AS (
       SELECT r.id, r.status
         FROM events.registrations r
         JOIN past_events pe ON pe.id = r.event_id
        WHERE r.status != 'cancelled'
     ),
     checkins AS (
       SELECT DISTINCT c.registration_id
         FROM events.registration_checkins c
         JOIN regs r ON r.id = c.registration_id
     )
     SELECT (SELECT COUNT(*) FROM regs) AS registered,
            (SELECT COUNT(*) FROM checkins) AS checkin`,
    [userId, from, to]
  );
  const registered = parseInt(attAgg.rows[0]?.registered || 0, 10);
  const checkin = parseInt(attAgg.rows[0]?.checkin || 0, 10);
  const noshow = Math.max(registered - checkin, 0);
  const projAgg = await pool.query(
    `SELECT COALESCE(SUM((config->>'total_budget')::NUMERIC), 0) AS projected
       FROM events.events
      WHERE user_id = $1 AND starts_at >= $2 AND starts_at <= $3
        AND (config->>'total_budget') ~ '^[0-9]+(\\.[0-9]+)?$'`,
    [userId, from, to]
  );
  const paidAgg = await pool.query(
    `SELECT COALESCE(SUM(s.contracted_amount), 0) AS paid
       FROM events.event_suppliers s
       JOIN events.events e ON e.id = s.event_id
      WHERE e.user_id = $1 AND e.starts_at >= $2 AND e.starts_at <= $3
        AND s.currency = $4 AND s.payment_status = 'paid'`,
    [userId, from, to, currency]
  );
  const projected = parseFloat(projAgg.rows[0]?.projected || 0);
  const paid = parseFloat(paidAgg.rows[0]?.paid || 0);
  const pending = Math.max(projected - paid, 0);
  const top5 = await pool.query(
    `SELECT e.id, e.name, e.slug, e.starts_at, e.ends_at, e.venue_name,
            COUNT(DISTINCT c.registration_id) AS attendees
       FROM events.events e
       LEFT JOIN events.registrations r ON r.event_id = e.id AND r.status != 'cancelled'
       LEFT JOIN events.registration_checkins c ON c.registration_id = r.id
      WHERE e.user_id = $1 AND e.starts_at >= $2 AND e.starts_at <= $3
        AND e.ends_at < NOW()
      GROUP BY e.id
      ORDER BY attendees DESC NULLS LAST, e.starts_at DESC
      LIMIT 5`,
    [userId, from, to]
  );
  const monthly = await pool.query(
    `SELECT TO_CHAR(DATE_TRUNC('month', starts_at), 'YYYY-MM') AS month,
            COUNT(*) AS count
       FROM events.events
      WHERE user_id = $1 AND starts_at >= $2 AND starts_at <= $3
        AND status != 'cancelled'
      GROUP BY 1 ORDER BY 1`,
    [userId, from, to]
  );
  const doneN = parseInt(eventsAgg.rows[0]?.done || 0, 10);
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    currency,
    events: {
      done: doneN,
      scheduled: parseInt(eventsAgg.rows[0]?.scheduled || 0, 10),
      cancelled: parseInt(eventsAgg.rows[0]?.cancelled || 0, 10),
      total: parseInt(eventsAgg.rows[0]?.total || 0, 10)
    },
    attendees: { registered, checkin, noshow },
    budget: { projected, paid, pending, avg: doneN > 0 ? projected / doneN : 0 },
    top5: top5.rows.map(r => ({
      id: r.id, name: r.name, slug: r.slug,
      starts_at: r.starts_at, ends_at: r.ends_at, venue: r.venue_name,
      attendees: parseInt(r.attendees || 0, 10)
    })),
    monthly: monthly.rows.map(r => ({ month: r.month, count: parseInt(r.count, 10) }))
  };
}

const ANALYTICS_EXPORT_LABELS = {
  es: { title:'Panel resumen Events', range:'Rango', from:'Desde', to:'Hasta', currency:'Moneda',
        events:'Eventos', done:'Realizados', scheduled:'Programados', cancelled:'Cancelados', total:'Total',
        attendees:'Asistentes', registered:'Inscritos', checkin:'Check-in', noshow:'No-show',
        budget:'Presupuesto', projected:'Proyectado', paid:'Pagado', pending:'Por pagar', avg:'Promedio/evento',
        top5:'Top 5 por asistencia', col_rank:'#', col_name:'Evento', col_date:'Fecha', col_venue:'Lugar', col_att:'Asistentes',
        monthly:'Eventos por mes', col_month:'Mes', col_count:'Eventos', generated:'Generado' },
  en: { title:'Events overview', range:'Range', from:'From', to:'To', currency:'Currency',
        events:'Events', done:'Done', scheduled:'Scheduled', cancelled:'Cancelled', total:'Total',
        attendees:'Attendees', registered:'Registered', checkin:'Check-in', noshow:'No-show',
        budget:'Budget', projected:'Projected', paid:'Paid', pending:'Pending', avg:'Avg/event',
        top5:'Top 5 by attendance', col_rank:'#', col_name:'Event', col_date:'Date', col_venue:'Venue', col_att:'Attendees',
        monthly:'Events per month', col_month:'Month', col_count:'Events', generated:'Generated' },
  pt: { title:'Painel resumo Events', range:'Período', from:'De', to:'Até', currency:'Moeda',
        events:'Eventos', done:'Realizados', scheduled:'Programados', cancelled:'Cancelados', total:'Total',
        attendees:'Participantes', registered:'Inscritos', checkin:'Check-in', noshow:'No-show',
        budget:'Orçamento', projected:'Projetado', paid:'Pago', pending:'A pagar', avg:'Média/evento',
        top5:'Top 5 por participação', col_rank:'#', col_name:'Evento', col_date:'Data', col_venue:'Local', col_att:'Participantes',
        monthly:'Eventos por mês', col_month:'Mês', col_count:'Eventos', generated:'Gerado' },
};
function analyticsExportLocale(req) {
  const l = String(req.query.locale || 'es').slice(0,2).toLowerCase();
  return ANALYTICS_EXPORT_LABELS[l] ? l : 'es';
}
function fmtDateShort(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}
function fmtMoney(n, currency) {
  const v = Number(n) || 0;
  try { return new Intl.NumberFormat('es-CO', { style:'currency', currency, maximumFractionDigits:0 }).format(v); }
  catch(_) { return `${currency} ${Math.round(v).toLocaleString('es-CO')}`; }
}

router.get('/analytics/overview', auth, requireAnalyticsAccess, async (req, res) => {
  try {
    const pool = global.pool;
    const { from, to } = parseAnalyticsRange(req.query);
    const data = await loadAnalyticsOverview(pool, req.user.id, from, to);
    res.json({ ...data, tier: req._licTier });
  } catch (err) {
    console.error('❌ GET /analytics:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── EXPORT XLSX / PDF del panel resumen (S210g Fase B) ───────────────────────
router.get('/analytics/overview/export.xlsx', auth, requireAnalyticsAccess, async (req, res) => {
  try {
    const pool = global.pool;
    const { from, to } = parseAnalyticsRange(req.query);
    const loc = analyticsExportLocale(req);
    const L = ANALYTICS_EXPORT_LABELS[loc];
    const d = await loadAnalyticsOverview(pool, req.user.id, from, to);

    const wb = XLSX.utils.book_new();
    const resumen = [
      [L.title],
      [L.range, `${fmtDateShort(from)} → ${fmtDateShort(to)}`],
      [L.currency, d.currency],
      [],
      [L.events],
      [L.done, d.events.done],
      [L.scheduled, d.events.scheduled],
      [L.cancelled, d.events.cancelled],
      [L.total, d.events.total],
      [],
      [L.attendees],
      [L.registered, d.attendees.registered],
      [L.checkin, d.attendees.checkin],
      [L.noshow, d.attendees.noshow],
      [],
      [L.budget],
      [L.projected, fmtMoney(d.budget.projected, d.currency)],
      [L.paid, fmtMoney(d.budget.paid, d.currency)],
      [L.pending, fmtMoney(d.budget.pending, d.currency)],
      [L.avg, fmtMoney(d.budget.avg, d.currency)],
      [],
      [L.generated, new Date().toISOString()],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumen), L.title.slice(0, 31));

    const top5Rows = [[L.col_rank, L.col_name, L.col_date, L.col_venue, L.col_att]];
    d.top5.forEach((r, i) => top5Rows.push([i + 1, r.name || '', fmtDateShort(r.starts_at), r.venue || '', r.attendees]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(top5Rows), L.top5.slice(0, 31));

    const monthlyRows = [[L.col_month, L.col_count]];
    d.monthly.forEach(m => monthlyRows.push([m.month, m.count]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(monthlyRows), L.monthly.slice(0, 31));

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fname = `events-overview-${fmtDateShort(from)}_${fmtDateShort(to)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(buf);
  } catch (err) {
    console.error('❌ GET /analytics/overview/export.xlsx:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/analytics/overview/export.pdf', auth, requireAnalyticsAccess, async (req, res) => {
  try {
    const pool = global.pool;
    const { from, to } = parseAnalyticsRange(req.query);
    const loc = analyticsExportLocale(req);
    const L = ANALYTICS_EXPORT_LABELS[loc];
    const d = await loadAnalyticsOverview(pool, req.user.id, from, to);

    const doc = new PDFDocument({ margin: 48, size: 'A4', bufferPages: true });
    const fname = `events-overview-${fmtDateShort(from)}_${fmtDateShort(to)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    doc.pipe(res);

    // Header SONORO
    doc.rect(0, 0, doc.page.width, 60).fill('#111');
    doc.fillColor('#FFD400').fontSize(18).font('Helvetica-Bold').text('SONORO', 48, 20);
    doc.fillColor('#fff').fontSize(10).font('Helvetica').text(L.title, 48, 42);
    doc.moveDown(3).fillColor('#111');

    doc.fontSize(10).fillColor('#444').text(`${L.range}: ${fmtDateShort(from)} → ${fmtDateShort(to)}  ·  ${L.currency}: ${d.currency}`);
    doc.moveDown(0.8);

    const section = (title) => { doc.moveDown(0.4); doc.fontSize(12).fillColor('#111').font('Helvetica-Bold').text(title); doc.font('Helvetica').fontSize(10).fillColor('#333'); };
    const kv = (k, v) => doc.text(`${k}: `, { continued: true }).font('Helvetica-Bold').text(String(v)).font('Helvetica');

    section(L.events);
    kv(L.done, d.events.done); kv(L.scheduled, d.events.scheduled); kv(L.cancelled, d.events.cancelled); kv(L.total, d.events.total);

    section(L.attendees);
    kv(L.registered, d.attendees.registered); kv(L.checkin, d.attendees.checkin); kv(L.noshow, d.attendees.noshow);

    section(L.budget);
    kv(L.projected, fmtMoney(d.budget.projected, d.currency));
    kv(L.paid, fmtMoney(d.budget.paid, d.currency));
    kv(L.pending, fmtMoney(d.budget.pending, d.currency));
    kv(L.avg, fmtMoney(d.budget.avg, d.currency));

    section(L.top5);
    if (!d.top5.length) doc.fillColor('#888').text('—');
    else d.top5.forEach((r, i) => doc.fillColor('#333').text(`${i + 1}. ${r.name || ''} — ${fmtDateShort(r.starts_at)} — ${r.venue || ''} — ${r.attendees} ${L.col_att}`));

    section(L.monthly);
    if (!d.monthly.length) doc.fillColor('#888').text('—');
    else d.monthly.forEach(m => doc.fillColor('#333').text(`${m.month}: ${m.count}`));

    doc.moveDown(1).fontSize(8).fillColor('#999').text(`${L.generated}: ${new Date().toISOString()}`);
    doc.end();
  } catch (err) {
    console.error('❌ GET /analytics/overview/export.pdf:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Error interno' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-10 · Reporte postrueda (v3)
// GET /api/events/:id/analytics/postrueda
// Devuelve 6 bloques: pipeline, agenda, delegates, compromisos, heatmap, brechas.
// Protegido por requireAnalyticsAccess (misma gate que /analytics/overview).
// ──────────────────────────────────────────────────────────────────────────────
async function assertEventOwner(pool, eventId, userId) {
  const r = await pool.query(
    'SELECT id, user_id, name, starts_at, ends_at FROM events.events WHERE id = $1',
    [eventId]
  );
  if (!r.rows.length) { const e = new Error('Evento no encontrado'); e.httpStatus = 404; throw e; }
  const ev = r.rows[0];
  if (String(ev.user_id) !== String(userId)) { const e = new Error('Prohibido'); e.httpStatus = 403; throw e; }
  return ev;
}

router.get('/:id/analytics/postrueda', auth, requireAnalyticsAccess, async (req, res) => {
  const pool = global.pool;
  try {
    const eventId = req.params.id;
    if (req.user.role !== 'admin') await assertEventOwner(pool, eventId, req.user.id);

    // ── 1) PIPELINE: outcomes agregados por result ─────────────────────────────
    const pipelineAgg = await pool.query(
      `SELECT o.result, COUNT(*) AS n
         FROM events.rn_meeting_outcomes o
         JOIN events.rn_meetings m ON m.id = o.meeting_id
        WHERE m.event_id = $1
        GROUP BY o.result`,
      [eventId]
    );
    const pipelineTotal = pipelineAgg.rows.reduce((s, r) => s + Number(r.n), 0);
    const pipeline = { total: pipelineTotal, by_result: {}, top: {} };
    for (const row of pipelineAgg.rows) {
      pipeline.by_result[row.result] = { n: Number(row.n), pct: pipelineTotal ? Number(row.n) / pipelineTotal : 0 };
    }

    // Top 3 compromisos por result (match/conditional/needs_info) con due_at más próximo
    for (const result of ['match', 'conditional', 'needs_info']) {
      const r = await pool.query(
        `SELECT o.meeting_id, o.due_at, o.next_step,
                ra.company_name AS company_a, rb.company_name AS company_b
           FROM events.rn_meeting_outcomes o
           JOIN events.rn_meetings m ON m.id = o.meeting_id
           JOIN events.registrations ra ON ra.id = m.company_a_id
           JOIN events.registrations rb ON rb.id = m.company_b_id
          WHERE m.event_id = $1 AND o.result = $2 AND o.completed_at IS NULL
          ORDER BY COALESCE(o.due_at, NOW() + INTERVAL '99 years') ASC
          LIMIT 3`,
        [eventId, result]
      );
      pipeline.top[result] = r.rows;
    }
    // Top 3 razones para no_match: usar dim con 'poor' más frecuente
    const noMatchReasons = await pool.query(
      `SELECT k.dim, COUNT(*) AS n
         FROM events.rn_meeting_feedback f
         JOIN events.rn_meetings m ON m.id = f.meeting_id
         JOIN LATERAL (VALUES
            ('fit', f.dim_fit), ('docs', f.dim_docs), ('price', f.dim_price),
            ('capacity', f.dim_capacity), ('timing', f.dim_timing), ('clarity', f.dim_clarity)
         ) AS k(dim, val) ON TRUE
        WHERE m.event_id = $1 AND k.val = 'poor'
        GROUP BY k.dim
        ORDER BY n DESC
        LIMIT 3`,
      [eventId]
    );
    pipeline.top.no_match_reasons = noMatchReasons.rows;
    // Concentración de no_show (ronda + mesa)
    const nsRound = await pool.query(
      `SELECT rr.round_number, COUNT(*) AS n
         FROM events.rn_meeting_outcomes o
         JOIN events.rn_meetings m ON m.id = o.meeting_id
         JOIN events.rn_rounds rr ON rr.id = m.round_id
        WHERE m.event_id = $1 AND o.result = 'no_show'
        GROUP BY rr.round_number
        ORDER BY n DESC LIMIT 3`,
      [eventId]
    );
    pipeline.top.no_show_rounds = nsRound.rows;

    // ── 2) APROVECHAMIENTO AGENDA ─────────────────────────────────────────────
    const agendaOverall = await pool.query(
      `SELECT
          COUNT(*) AS scheduled,
          COUNT(*) FILTER (WHERE status IN ('completed','active')) AS effective
         FROM events.rn_meetings
        WHERE event_id = $1`,
      [eventId]
    );
    const agendaByRound = await pool.query(
      `SELECT rr.round_number, rr.label,
              COUNT(m.id) AS scheduled,
              COUNT(m.id) FILTER (WHERE m.status IN ('completed','active')) AS effective
         FROM events.rn_rounds rr
         LEFT JOIN events.rn_meetings m ON m.round_id = rr.id
        WHERE rr.event_id = $1
        GROUP BY rr.id, rr.round_number, rr.label
        ORDER BY rr.round_number`,
      [eventId]
    );
    const agendaByTable = await pool.query(
      `SELECT t.label, t.display_order,
              COUNT(m.id) AS scheduled,
              COUNT(m.id) FILTER (WHERE m.status IN ('completed','active')) AS effective
         FROM events.rn_tables t
         LEFT JOIN events.rn_meetings m ON m.table_id = t.id
        WHERE t.event_id = $1 AND t.active = TRUE
        GROUP BY t.id, t.label, t.display_order
        ORDER BY t.display_order, t.label`,
      [eventId]
    );
    const agenda = {
      overall: agendaOverall.rows[0] || { scheduled: 0, effective: 0 },
      by_round: agendaByRound.rows,
      by_table: agendaByTable.rows,
    };

    // ── 3) DELEGADOS ANCLA Y COLA LARGA ───────────────────────────────────────
    const anchors = await pool.query(
      `SELECT r.id AS registration_id, r.company_name,
              COUNT(*) FILTER (WHERE o.result IN ('match','conditional')) AS positives,
              COUNT(*) AS total_outcomes
         FROM events.rn_meeting_outcomes o
         JOIN events.rn_meetings m ON m.id = o.meeting_id
         JOIN events.registrations r ON r.id = CASE WHEN o.side = 'A' THEN m.company_a_id ELSE m.company_b_id END
        WHERE m.event_id = $1
        GROUP BY r.id, r.company_name
        HAVING COUNT(*) FILTER (WHERE o.result IN ('match','conditional')) > 0
        ORDER BY positives DESC, total_outcomes DESC
        LIMIT 5`,
      [eventId]
    );
    const longtail = await pool.query(
      `SELECT r.id AS registration_id, r.company_name,
              COUNT(*) FILTER (WHERE o.result = 'no_match') AS negatives,
              COUNT(*) AS total_outcomes
         FROM events.rn_meeting_outcomes o
         JOIN events.rn_meetings m ON m.id = o.meeting_id
         JOIN events.registrations r ON r.id = CASE WHEN o.side = 'A' THEN m.company_a_id ELSE m.company_b_id END
        WHERE m.event_id = $1
        GROUP BY r.id, r.company_name
        HAVING COUNT(*) FILTER (WHERE o.result IN ('match','conditional')) = 0
        ORDER BY total_outcomes DESC
        LIMIT 5`,
      [eventId]
    );
    const delegates = { anchors: anchors.rows, longtail: longtail.rows };

    // ── 4) COMPROMISOS ACTIVOS ────────────────────────────────────────────────
    const compromisos = await pool.query(
      `SELECT o.meeting_id, o.side, o.next_step, o.owner_side, o.due_at, o.result,
              ra.company_name AS company_a, rb.company_name AS company_b,
              rr.round_number
         FROM events.rn_meeting_outcomes o
         JOIN events.rn_meetings m ON m.id = o.meeting_id
         JOIN events.rn_rounds rr ON rr.id = m.round_id
         JOIN events.registrations ra ON ra.id = m.company_a_id
         JOIN events.registrations rb ON rb.id = m.company_b_id
        WHERE m.event_id = $1 AND o.next_step <> 'none' AND o.completed_at IS NULL
        ORDER BY COALESCE(o.due_at, NOW() + INTERVAL '99 years') ASC
        LIMIT 100`,
      [eventId]
    );

    // ── 5) HEATMAP mesa × ronda (outcomes positivos) ──────────────────────────
    const heatmap = await pool.query(
      `SELECT t.label AS table_label, t.display_order,
              rr.round_number,
              COUNT(o.*) FILTER (WHERE o.result IN ('match','conditional')) AS positives,
              COUNT(m.id) AS total
         FROM events.rn_meetings m
         JOIN events.rn_tables  t  ON t.id  = m.table_id
         JOIN events.rn_rounds  rr ON rr.id = m.round_id
         LEFT JOIN events.rn_meeting_outcomes o ON o.meeting_id = m.id
        WHERE m.event_id = $1
        GROUP BY t.id, t.label, t.display_order, rr.round_number
        ORDER BY t.display_order, rr.round_number`,
      [eventId]
    );

    // ── 6) BRECHAS por tag (demanda sin oferta / oferta sin demanda) ──────────
    // Simplificación v1: contamos regs únicas que demandan/ofrecen cada tag en este evento.
    const tagsAgg = await pool.query(
      `SELECT t.id, t.label, t.category,
              COUNT(DISTINCT CASE WHEN rt.kind = 'demand' THEN rt.registration_id END) AS n_demand,
              COUNT(DISTINCT CASE WHEN rt.kind = 'offer'  THEN rt.registration_id END) AS n_offer
         FROM events.rn_tags t
         JOIN events.rn_registration_tags rt ON rt.tag_id = t.id
         JOIN events.registrations r ON r.id = rt.registration_id
        WHERE r.event_id = $1
        GROUP BY t.id, t.label, t.category`,
      [eventId]
    );
    const demandWithoutOffer = tagsAgg.rows
      .filter(r => Number(r.n_demand) > 0 && Number(r.n_offer) === 0)
      .sort((a, b) => Number(b.n_demand) - Number(a.n_demand))
      .slice(0, 20);
    const offerWithoutDemand = tagsAgg.rows
      .filter(r => Number(r.n_offer) > 0 && Number(r.n_demand) === 0)
      .sort((a, b) => Number(b.n_offer) - Number(a.n_offer))
      .slice(0, 20);
    const brechas = { demand_without_offer: demandWithoutOffer, offer_without_demand: offerWithoutDemand };

    res.json({
      event_id: eventId,
      generated_at: new Date().toISOString(),
      pipeline,
      agenda,
      delegates,
      compromisos: compromisos.rows,
      heatmap: heatmap.rows,
      brechas,
    });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('❌ GET /analytics/postrueda:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
