// Rueda de Negocios v1 — Rutas setup productor (/api/rn/*)
// Framework: docs/EVENTS-RUEDA-NEGOCIOS-FRAMEWORK.md v1.1
// Fase: E-RN-1 (setup + inscripción productor-side)
// P-2: todo filtro incluye user_id vía JOIN events.events
// P-3: mutaciones ≥2 tablas usan withTransaction

'use strict';
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const { withTransaction } = require('../db/withTransaction');
const solver = require('../services/matchmaking-solver');
const tagsSvc = require('../services/matchmaking-tags');

const uploadTags = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
}

function slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function assertRnEventOwned(pool, eventId, userId) {
  const r = await pool.query(
    `SELECT id, user_id, name, status, config, default_locale FROM events.events WHERE id = $1`, [eventId]
  );
  if (r.rowCount === 0) {
    const err = new Error('Evento no encontrado'); err.httpStatus = 404; throw err;
  }
  const ev = r.rows[0];
  if (ev.user_id !== userId) {
    const err = new Error('No autorizado'); err.httpStatus = 403; throw err;
  }
  const type = ev.config && ev.config.event_type;
  if (type !== 'matchmaking') {
    const err = new Error('Evento no es rueda de negocios'); err.httpStatus = 400; throw err;
  }
  return ev;
}

function handleError(res, err, where) {
  if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'Registro duplicado' });
  if (err.code === '23503') return res.status(409).json({ error: 'Referencia inválida o en uso' });
  console.error('[rn]', where, err);
  res.status(500).json({ error: 'Error interno' });
}

// ------------------------------------------------------------------
// Zonas
// ------------------------------------------------------------------
router.get('/events/:eventId/zones', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const r = await pool.query(
      `SELECT * FROM events.rn_zones WHERE event_id = $1 ORDER BY display_order, name`,
      [req.params.eventId]
    );
    res.json(r.rows);
  } catch (err) { handleError(res, err, 'GET zones'); }
});

router.post('/events/:eventId/zones', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const { name, venue_label, color_hex, display_order } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name requerido' });
    const slug = slugify(name);
    const r = await pool.query(
      `INSERT INTO events.rn_zones (event_id, slug, name, venue_label, color_hex, display_order)
       VALUES ($1, $2, $3, $4, COALESCE($5, '#4F46E5'), COALESCE($6, 0))
       RETURNING *`,
      [req.params.eventId, slug, name, venue_label || null, color_hex || null, display_order]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { handleError(res, err, 'POST zone'); }
});

router.put('/events/:eventId/zones/:zoneId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const { name, venue_label, color_hex, display_order } = req.body || {};
    const r = await pool.query(
      `UPDATE events.rn_zones
       SET name = COALESCE($1, name),
           venue_label = COALESCE($2, venue_label),
           color_hex = COALESCE($3, color_hex),
           display_order = COALESCE($4, display_order)
       WHERE id = $5 AND event_id = $6
       RETURNING *`,
      [name, venue_label, color_hex, display_order, req.params.zoneId, req.params.eventId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Zona no encontrada' });
    res.json(r.rows[0]);
  } catch (err) { handleError(res, err, 'PUT zone'); }
});

router.delete('/events/:eventId/zones/:zoneId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const r = await pool.query(
      `DELETE FROM events.rn_zones WHERE id = $1 AND event_id = $2`,
      [req.params.zoneId, req.params.eventId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Zona no encontrada' });
    res.status(204).end();
  } catch (err) { handleError(res, err, 'DELETE zone'); }
});

// ------------------------------------------------------------------
// Mesas (bulk soportado)
// ------------------------------------------------------------------
router.get('/events/:eventId/tables', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const r = await pool.query(
      `SELECT t.*, z.name AS zone_name, z.color_hex AS zone_color
       FROM events.rn_tables t
       LEFT JOIN events.rn_zones z ON z.id = t.zone_id
       WHERE t.event_id = $1
       ORDER BY t.display_order, t.label`,
      [req.params.eventId]
    );
    res.json(r.rows);
  } catch (err) { handleError(res, err, 'GET tables'); }
});

router.post('/events/:eventId/tables', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const items = Array.isArray(req.body?.tables) ? req.body.tables : [req.body];
    if (!items.length || !items[0] || !items[0].label) {
      return res.status(400).json({ error: 'label requerido' });
    }
    const result = await withTransaction(pool, async (client) => {
      const inserted = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it.label) {
          const err = new Error('label vacío en item ' + i); err.httpStatus = 400; throw err;
        }
        const displayOrder = Number.isInteger(it.display_order) ? it.display_order : i;
        const r = await client.query(
          `INSERT INTO events.rn_tables (event_id, zone_id, label, display_order, active)
           VALUES ($1, $2, $3, $4, TRUE)
           RETURNING *`,
          [req.params.eventId, it.zone_id || null, it.label, displayOrder]
        );
        inserted.push(r.rows[0]);
      }
      return inserted;
    });
    res.status(201).json(result);
  } catch (err) { handleError(res, err, 'POST tables'); }
});

router.put('/events/:eventId/tables/:tableId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const { label, zone_id, display_order, active } = req.body || {};
    const r = await pool.query(
      `UPDATE events.rn_tables
       SET label = COALESCE($1, label),
           zone_id = $2,
           display_order = COALESCE($3, display_order),
           active = COALESCE($4, active)
       WHERE id = $5 AND event_id = $6
       RETURNING *`,
      [label, zone_id || null, display_order, active, req.params.tableId, req.params.eventId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Mesa no encontrada' });
    res.json(r.rows[0]);
  } catch (err) { handleError(res, err, 'PUT table'); }
});

router.delete('/events/:eventId/tables/:tableId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const r = await pool.query(
      `DELETE FROM events.rn_tables WHERE id = $1 AND event_id = $2`,
      [req.params.tableId, req.params.eventId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Mesa no encontrada' });
    res.status(204).end();
  } catch (err) { handleError(res, err, 'DELETE table'); }
});

// ------------------------------------------------------------------
// Rondas — generación por plan
// ------------------------------------------------------------------
router.get('/events/:eventId/rounds', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const r = await pool.query(
      `SELECT * FROM events.rn_rounds WHERE event_id = $1 ORDER BY starts_at`,
      [req.params.eventId]
    );
    res.json(r.rows);
  } catch (err) { handleError(res, err, 'GET rounds'); }
});

router.post('/events/:eventId/rounds/plan', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const { starts_at, meeting_minutes = 20, total_rounds = 10, break_every = 0, break_count = 0, break_minutes = 10 } = req.body || {};
    if (!starts_at) return res.status(400).json({ error: 'starts_at requerido' });
    if (!Number.isInteger(total_rounds) || total_rounds < 1 || total_rounds > 50) {
      return res.status(400).json({ error: 'total_rounds inválido (1..50)' });
    }
    if (!Number.isInteger(meeting_minutes) || meeting_minutes < 5 || meeting_minutes > 120) {
      return res.status(400).json({ error: 'meeting_minutes inválido (5..120)' });
    }

    const result = await withTransaction(pool, async (client) => {
      const existing = await client.query(
        `SELECT COUNT(*)::int AS c FROM events.rn_rounds WHERE event_id = $1`,
        [req.params.eventId]
      );
      if (existing.rows[0].c > 0) {
        const err = new Error('Rondas ya planificadas — reset primero'); err.httpStatus = 409; throw err;
      }

      const rounds = [];
      let cursor = new Date(starts_at);
      if (isNaN(cursor.getTime())) {
        const err = new Error('starts_at inválido'); err.httpStatus = 400; throw err;
      }
      // Distribución equidistante: break_count prevalece sobre break_every (legacy).
      // Con break_count=N y total_rounds=T, los breaks se insertan tras las rondas
      // round(T*k/(N+1)) para k=1..N. Ej: T=10,N=1 → tras ronda 5. T=10,N=2 → tras 3 y 7.
      const breakAfterSet = new Set();
      const bc = Number.isInteger(break_count) && break_count > 0 ? break_count : 0;
      if (bc > 0 && bc < total_rounds) {
        for (let k = 1; k <= bc; k++) {
          const pos = Math.round((total_rounds * k) / (bc + 1));
          if (pos >= 1 && pos < total_rounds) breakAfterSet.add(pos);
        }
      }
      let roundNum = 1;
      for (let i = 1; i <= total_rounds; i++) {
        const ends = new Date(cursor.getTime() + meeting_minutes * 60000);
        const ins = await client.query(
          `INSERT INTO events.rn_rounds (event_id, round_number, starts_at, ends_at, kind)
           VALUES ($1, $2, $3, $4, 'meeting')
           RETURNING *`,
          [req.params.eventId, roundNum++, cursor.toISOString(), ends.toISOString()]
        );
        rounds.push(ins.rows[0]);
        cursor = ends;
        const insertBreak = breakAfterSet.has(i)
          || (bc === 0 && break_every > 0 && i < total_rounds && i % break_every === 0);
        if (insertBreak && i < total_rounds) {
          const brEnds = new Date(cursor.getTime() + break_minutes * 60000);
          const br = await client.query(
            `INSERT INTO events.rn_rounds (event_id, round_number, starts_at, ends_at, kind, label)
             VALUES ($1, $2, $3, $4, 'break', 'Coffee break')
             RETURNING *`,
            [req.params.eventId, roundNum++, cursor.toISOString(), brEnds.toISOString()]
          );
          rounds.push(br.rows[0]);
          cursor = brEnds;
        }
      }
      return rounds;
    });
    res.status(201).json(result);
  } catch (err) { handleError(res, err, 'POST rounds/plan'); }
});

// Capacidad/planning stats — modelo matchmaking:
//   rondas_min = max_requests_per_attendee  (asistente solo puede estar en 1 reunión por ronda)
//   mesas_sug  = ceil(asistentes_activos / 2)  (capacidad paralela máxima por ronda)
router.get('/events/:eventId/stats/planning', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const eventId = req.params.eventId;
    const regs = await pool.query(
      `SELECT COUNT(*)::int AS c
         FROM events.registrations
        WHERE event_id = $1 AND ticket_type = 'rueda' AND status IN ('approved','confirmed')`,
      [eventId]
    );
    const totalReq = await pool.query(
      `SELECT COUNT(*)::int AS c
         FROM events.rn_meeting_requests
        WHERE event_id = $1 AND status = 'accepted'`,
      [eventId]
    );
    const perAttendeeMax = await pool.query(
      `SELECT COALESCE(MAX(cnt),0)::int AS m FROM (
         SELECT COUNT(*) AS cnt FROM (
           SELECT from_registration_id AS r FROM events.rn_meeting_requests
            WHERE event_id = $1 AND status = 'accepted'
           UNION ALL
           SELECT to_registration_id FROM events.rn_meeting_requests
            WHERE event_id = $1 AND status = 'accepted'
         ) x
         GROUP BY r
       ) y`,
      [eventId]
    );
    const activeAttendees = regs.rows[0].c;
    const acceptedRequests = totalReq.rows[0].c;
    const maxPerAttendee = perAttendeeMax.rows[0].m;
    const suggestedRondas = maxPerAttendee;
    const suggestedMesas = Math.max(1, Math.ceil(activeAttendees / 2));
    const configuredRounds = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE kind='meeting')::int AS meetings,
              COUNT(*) FILTER (WHERE kind='break')::int   AS breaks
         FROM events.rn_rounds WHERE event_id = $1`, [eventId]
    );
    const configuredTables = await pool.query(
      `SELECT COUNT(*)::int AS c FROM events.rn_tables WHERE event_id = $1 AND active`, [eventId]
    );
    res.json({
      active_attendees: activeAttendees,
      accepted_requests: acceptedRequests,
      max_requests_per_attendee: maxPerAttendee,
      suggested_rondas: suggestedRondas,
      suggested_mesas: suggestedMesas,
      configured_rounds: configuredRounds.rows[0].meetings,
      configured_breaks: configuredRounds.rows[0].breaks,
      configured_tables: configuredTables.rows[0].c,
      total_slots: configuredRounds.rows[0].meetings * configuredTables.rows[0].c,
    });
  } catch (err) { handleError(res, err, 'GET stats/planning'); }
});

router.delete('/events/:eventId/rounds', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const meetings = await pool.query(
      `SELECT COUNT(*)::int AS c FROM events.rn_meetings WHERE event_id = $1`,
      [req.params.eventId]
    );
    if (meetings.rows[0].c > 0) {
      return res.status(409).json({ error: 'Hay reuniones persistidas — reset solver primero' });
    }
    await pool.query(`DELETE FROM events.rn_rounds WHERE event_id = $1`, [req.params.eventId]);
    res.status(204).end();
  } catch (err) { handleError(res, err, 'DELETE rounds'); }
});

// ------------------------------------------------------------------
// Tags (por tenant)
// ------------------------------------------------------------------
router.get('/tags', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const r = await pool.query(
      `SELECT * FROM events.rn_tags WHERE user_id = $1 ORDER BY category NULLS LAST, label`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (err) { handleError(res, err, 'GET tags'); }
});

router.post('/tags', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const label = tagsSvc.cleanLabel(req.body && req.body.label);
    if (!label) return res.status(400).json({ error: 'label requerido' });
    const slug = tagsSvc.normalizeTagSlug(label);
    if (!slug) return res.status(400).json({ error: 'label no genera slug válido' });
    const category = tagsSvc.cleanLabel(req.body && req.body.category) || null;
    const r = await pool.query(
      `INSERT INTO events.rn_tags (user_id, slug, label, category)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, slug, label, category]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { handleError(res, err, 'POST tag'); }
});

router.patch('/tags/:tagId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const own = await pool.query(
      `SELECT id FROM events.rn_tags WHERE id = $1 AND user_id = $2`,
      [req.params.tagId, req.user.id]
    );
    if (own.rowCount === 0) return res.status(404).json({ error: 'Tag no encontrado' });

    const fields = [];
    const values = [];
    if (req.body && typeof req.body.label === 'string') {
      const label = tagsSvc.cleanLabel(req.body.label);
      if (!label) return res.status(400).json({ error: 'label vacío' });
      values.push(label); fields.push(`label = $${values.length}`);
      const slug = tagsSvc.normalizeTagSlug(label);
      values.push(slug); fields.push(`slug = $${values.length}`);
    }
    if (req.body && 'category' in req.body) {
      values.push(tagsSvc.cleanLabel(req.body.category) || null);
      fields.push(`category = $${values.length}`);
    }
    if (fields.length === 0) return res.status(400).json({ error: 'nada que actualizar' });

    values.push(req.params.tagId, req.user.id);
    const r = await pool.query(
      `UPDATE events.rn_tags SET ${fields.join(', ')}
         WHERE id = $${values.length - 1} AND user_id = $${values.length}
         RETURNING *`,
      values
    );
    res.json(r.rows[0]);
  } catch (err) { handleError(res, err, 'PATCH tag'); }
});

router.delete('/tags/:tagId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const r = await pool.query(
      `DELETE FROM events.rn_tags WHERE id = $1 AND user_id = $2`,
      [req.params.tagId, req.user.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Tag no encontrado' });
    res.status(204).end();
  } catch (err) { handleError(res, err, 'DELETE tag'); }
});

// ------------------------------------------------------------------
// B.0 Taxonomía — fuzzy, bulk, export, template
// ------------------------------------------------------------------

// Fuzzy similar — modal "nuevo manual: ¿quisiste decir X?"
router.get('/tags/similar', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const label = tagsSvc.cleanLabel(req.query && req.query.label);
    if (!label) return res.status(400).json({ error: 'label requerido' });
    const r = await pool.query(
      `SELECT id, slug, label, category, similarity(label, $2) AS score
         FROM events.rn_tags
        WHERE user_id = $1 AND similarity(label, $2) >= $3
        ORDER BY score DESC
        LIMIT 5`,
      [req.user.id, label, tagsSvc.SIMILARITY_THRESHOLD]
    );
    res.json({ label, threshold: tagsSvc.SIMILARITY_THRESHOLD,
               candidates: r.rows.map(x => ({ ...x, score: Number(x.score.toFixed(3)) })) });
  } catch (err) { handleError(res, err, 'GET tags/similar'); }
});

// Template xlsx
router.get('/tags/template.xlsx', auth, async (req, res) => {
  try {
    const buf = tagsSvc.buildTemplateBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sonoro-tags-template.xlsx"');
    res.send(buf);
  } catch (err) { handleError(res, err, 'GET tags/template'); }
});

// Export catálogo actual
router.get('/events/:eventId/tags/export', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const r = await pool.query(
      `SELECT label, category FROM events.rn_tags
        WHERE user_id = $1 ORDER BY category NULLS LAST, label`,
      [req.user.id]
    );
    const buf = tagsSvc.buildExportBuffer(r.rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sonoro-tags-export.xlsx"');
    res.send(buf);
  } catch (err) { handleError(res, err, 'GET tags/export'); }
});

// Bulk preview — parse y diffing, NO persiste
router.post('/events/:eventId/tags/bulk', auth, uploadTags.single('file'), async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'file requerido' });

    let parsed;
    try { parsed = tagsSvc.parseBulkBuffer(req.file.buffer); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const client = await pool.connect();
    try {
      const preview = await tagsSvc.buildBulkPreview(client, req.user.id, parsed);
      res.json(preview);
    } finally { client.release(); }
  } catch (err) { handleError(res, err, 'POST tags/bulk'); }
});

// Bulk confirm — persiste resolución del productor
router.post('/events/:eventId/tags/bulk/confirm', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const rows = (req.body && req.body.rows) || [];
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows debe ser array' });

    const stats = await withTransaction(pool, async (client) => {
      return tagsSvc.persistBulkRows(client, req.user.id, rows);
    });
    res.json({ ok: true, ...stats });
  } catch (err) { handleError(res, err, 'POST tags/bulk/confirm'); }
});

// ------------------------------------------------------------------
// Anchors (modo Zonificado)
// ------------------------------------------------------------------
router.post('/events/:eventId/anchors', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const { registration_id, table_id } = req.body || {};
    if (!registration_id || !table_id) {
      return res.status(400).json({ error: 'registration_id y table_id requeridos' });
    }
    const check = await pool.query(
      `SELECT
         (SELECT 1 FROM events.registrations WHERE id = $1 AND event_id = $3) AS reg_ok,
         (SELECT 1 FROM events.rn_tables    WHERE id = $2 AND event_id = $3) AS tab_ok`,
      [registration_id, table_id, req.params.eventId]
    );
    if (!check.rows[0].reg_ok || !check.rows[0].tab_ok) {
      return res.status(400).json({ error: 'registration o mesa no pertenecen al evento' });
    }
    const r = await pool.query(
      `INSERT INTO events.rn_registration_anchors (registration_id, table_id, assigned_by)
       VALUES ($1, $2, 'manual')
       ON CONFLICT (registration_id)
       DO UPDATE SET table_id = EXCLUDED.table_id, assigned_by = 'manual', assigned_at = NOW()
       RETURNING *`,
      [registration_id, table_id]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { handleError(res, err, 'POST anchor'); }
});

router.delete('/events/:eventId/anchors/:regId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const r = await pool.query(
      `DELETE FROM events.rn_registration_anchors a
       USING events.registrations r
       WHERE a.registration_id = $1 AND a.registration_id = r.id AND r.event_id = $2`,
      [req.params.regId, req.params.eventId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Ancla no encontrada' });
    res.status(204).end();
  } catch (err) { handleError(res, err, 'DELETE anchor'); }
});

// ------------------------------------------------------------------
// Delegados bulk — carga masiva productor (E-RN-1b · framework §3.10 D-RN-13)
// Body: { items: [{ registration_id, full_name, email, phone?, role_title? }, ...] }
// Crea rn_delegates secundarios por lote. Trigger email a cada uno.
// Nunca marca is_primary=TRUE (el primario ya existe desde inscripción).
// ------------------------------------------------------------------
router.post('/events/:eventId/delegates/bulk', auth, async (req, res) => {
  const pool = global.pool;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  try {
    const ev = await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items || !items.length) return res.status(400).json({ error: 'items[] requerido' });
    if (items.length > 500) return res.status(400).json({ error: 'Máximo 500 por lote' });

    // Pre-validar formato de todos los items ANTES de abrir transacción
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      if (!it.registration_id || !UUID_RE.test(String(it.registration_id))) {
        return res.status(400).json({ error: `items[${i}].registration_id inválido` });
      }
      if (!it.full_name || !String(it.full_name).trim()) {
        return res.status(400).json({ error: `items[${i}].full_name requerido` });
      }
      if (!it.email || !EMAIL_RE.test(String(it.email))) {
        return res.status(400).json({ error: `items[${i}].email inválido` });
      }
    }

    const { sendRnDelegateInvitedEmail } = require('../services/email');
    const baseUrl = (process.env.CMS_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    const result = await withTransaction(pool, async (client) => {
      // Validar que todos los registration_id pertenecen al evento
      const regIds = [...new Set(items.map(i => i.registration_id))];
      const regCheck = await client.query(
        `SELECT id FROM events.registrations WHERE event_id = $1 AND id = ANY($2::uuid[])`,
        [req.params.eventId, regIds]
      );
      const validRegs = new Set(regCheck.rows.map(r => r.id));
      const invalid = regIds.filter(id => !validRegs.has(id));
      if (invalid.length) {
        const err = new Error(`registration_id no pertenece al evento: ${invalid[0]}`);
        err.httpStatus = 400; throw err;
      }

      // Cargar primarios para enriquecer el email con inviter + company
      const primariesRes = await client.query(
        `SELECT d.registration_id, d.full_name AS inviter_name, d.id AS primary_id,
                r.custom_fields->>'company_name' AS company_name
           FROM events.rn_delegates d
           JOIN events.registrations r ON r.id = d.registration_id
          WHERE d.registration_id = ANY($1::uuid[]) AND d.is_primary = TRUE`,
        [regIds]
      );
      const primaries = {};
      for (const p of primariesRes.rows) primaries[p.registration_id] = p;

      const inserted = [];
      const skipped = [];
      for (const it of items) {
        const cleanEmail = String(it.email).toLowerCase().trim();
        const cleanName  = String(it.full_name).trim();
        const dup = await client.query(
          `SELECT 1 FROM events.rn_delegates
            WHERE registration_id = $1 AND LOWER(email) = $2`,
          [it.registration_id, cleanEmail]
        );
        if (dup.rowCount > 0) {
          skipped.push({ email: cleanEmail, registration_id: it.registration_id, reason: 'duplicate' });
          continue;
        }
        const prim = primaries[it.registration_id] || null;
        const r = await client.query(
          `INSERT INTO events.rn_delegates
             (registration_id, full_name, email, phone, role_title, is_primary, can_manage_team, invited_by, invited_at)
           VALUES ($1,$2,$3,$4,$5,FALSE,FALSE,$6,NOW())
           RETURNING id, agenda_token`,
          [it.registration_id, cleanName, cleanEmail, it.phone || null, it.role_title || null, prim?.primary_id || null]
        );
        inserted.push({
          delegate_id: r.rows[0].id,
          registration_id: it.registration_id,
          email: cleanEmail,
          agenda_token: r.rows[0].agenda_token,
          inviter_name: prim?.inviter_name || null,
          company_name: prim?.company_name || null,
          full_name: cleanName,
        });
      }
      return { inserted, skipped };
    });

    // Dispara emails fuera de la transacción (no bloquea respuesta)
    for (const d of result.inserted) {
      const agendaUrl = `${baseUrl}/rueda/mi-agenda/${d.agenda_token}`;
      sendRnDelegateInvitedEmail({
        to: d.email,
        delegateName: d.full_name,
        inviterName: d.inviter_name || 'Productor',
        companyName: d.company_name || '',
        eventName: ev.config?.event_name || '',
        agendaUrl,
        locale: d.locale || ev.default_locale || 'es',
      }).catch(e => console.error('⚠️ Email bulk invite fallido:', e.message));
    }

    console.log(`[rn] bulk delegates event=${req.params.eventId} inserted=${result.inserted.length} skipped=${result.skipped.length}`);
    res.status(201).json({
      inserted_count: result.inserted.length,
      skipped_count:  result.skipped.length,
      inserted: result.inserted.map(d => ({
        delegate_id: d.delegate_id,
        registration_id: d.registration_id,
        email: d.email,
      })),
      skipped: result.skipped,
    });
  } catch (err) { handleError(res, err, 'POST delegates/bulk'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-3 — Solver (preview · run · reset · runtime per round)
// ──────────────────────────────────────────────────────────────────────────────
router.post('/events/:eventId/solver/preview', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const manual = Array.isArray(req.body?.manual_meetings) ? req.body.manual_meetings : [];
    const result = await withTransaction(pool, async (client) => {
      // Advisory lock por event_id — serializa solver concurrente (S211j, Hallazgo B).
      // El lock se libera auto al COMMIT/ROLLBACK (incluido __dryRun).
      const lk = await client.query(
        `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS got`,
        [req.params.eventId]
      );
      if (!lk.rows[0].got) {
        const e = new Error('solver_already_running'); e.httpStatus = 409; throw e;
      }
      const out = await solver.runPreEvent(client, {
        eventId: req.params.eventId,
        dryRun: true,
        manualMeetings: manual,
      });
      // Dry-run: rollback forzado para no escribir nada
      const e = new Error('__dry_run__'); e.__dryRun = true; e.payload = out;
      throw e;
    }).catch(e => {
      if (e.__dryRun) return e.payload;
      throw e;
    });
    if (!result.ok) return res.status(400).json({ error: 'setup_incompleto', details: result.errors });
    res.json(result);
  } catch (err) { handleError(res, err, 'POST solver/preview'); }
});

router.post('/events/:eventId/solver/run', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const manual = Array.isArray(req.body?.manual_meetings) ? req.body.manual_meetings : [];
    const result = await withTransaction(pool, async (client) => {
      // Advisory lock por event_id — serializa solver concurrente (S211j, Hallazgo B).
      const lk = await client.query(
        `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS got`,
        [req.params.eventId]
      );
      if (!lk.rows[0].got) {
        const e = new Error('solver_already_running'); e.httpStatus = 409; throw e;
      }
      return solver.runPreEvent(client, {
        eventId: req.params.eventId,
        dryRun: false,
        manualMeetings: manual,
      });
    });
    if (!result.ok) return res.status(400).json({ error: 'setup_incompleto', details: result.errors });
    console.log(`[rn-solver] event=${req.params.eventId} meetings=${result.stats.meetings_total} rounds=${result.stats.total_rounds_effective}`);
    res.json(result);
  } catch (err) { handleError(res, err, 'POST solver/run'); }
});

router.post('/events/:eventId/solver/reset', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const result = await withTransaction(pool, async (client) => {
      // Advisory lock por event_id — serializa reset vs solver preview/run concurrente (B.2).
      const lk = await client.query(
        `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS got`,
        [req.params.eventId]
      );
      if (!lk.rows[0].got) {
        const e = new Error('solver_already_running'); e.httpStatus = 409; throw e;
      }
      return solver.resetMeetings(client, req.params.eventId);
    });
    console.log(`[rn-solver] reset event=${req.params.eventId} deleted=${result.deleted}`);
    res.json(result);
  } catch (err) { handleError(res, err, 'POST solver/reset'); }
});

// Runtime re-entrant: productor abre una ronda específica → solver evalúa presencia
router.post('/events/:eventId/rounds/:roundId/open', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    // Verificar round pertenece al evento
    const chk = await pool.query(
      `SELECT 1 FROM events.rn_rounds WHERE id = $1 AND event_id = $2`,
      [req.params.roundId, req.params.eventId]
    );
    if (chk.rowCount === 0) return res.status(404).json({ error: 'Ronda no encontrada' });

    const result = await withTransaction(pool, async (client) => {
      // Advisory lock por event_id — evita doble procesamiento ante doble-click
      // y serializa runtime vs solver pre-event (B.2).
      const lk = await client.query(
        `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS got`,
        [req.params.eventId]
      );
      if (!lk.rows[0].got) {
        const e = new Error('solver_already_running'); e.httpStatus = 409; throw e;
      }
      return solver.runRuntimeRound(client, { eventId: req.params.eventId, roundId: req.params.roundId });
    });
    console.log(`[rn-solver] runtime event=${req.params.eventId} round=${req.params.roundId} deferred=${result.deferred_count}`);
    global.io?.to(`event_rueda_${req.params.eventId}`).emit('rn.round.opened', {
      event_id: req.params.eventId,
      round_id: req.params.roundId,
      deferred_count: result.deferred_count,
      at: new Date().toISOString(),
    });
    res.json(result);
  } catch (err) { handleError(res, err, 'POST rounds/open'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-7a — Listado de meetings para UI productor
// ──────────────────────────────────────────────────────────────────────────────
router.get('/events/:eventId/meetings', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const r = await pool.query(
      `SELECT m.id, m.round_id, m.table_id, m.origin, m.locked, m.status,
              m.tag_overlap_score,
              rd.round_number,
              t.label AS table_label,
              ra.custom_fields->>'company_name' AS company_a,
              rb.custom_fields->>'company_name' AS company_b
         FROM events.rn_meetings m
         JOIN events.rn_rounds rd ON rd.id = m.round_id
         JOIN events.rn_tables t  ON t.id  = m.table_id
         JOIN events.registrations ra ON ra.id = m.company_a_id
         JOIN events.registrations rb ON rb.id = m.company_b_id
        WHERE m.event_id = $1
        ORDER BY rd.round_number ASC, t.display_order ASC NULLS LAST, t.label ASC`,
      [req.params.eventId]
    );
    res.json(r.rows);
  } catch (err) { handleError(res, err, 'GET meetings'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-7b-1 — Stats agregadas para panel productor
// ──────────────────────────────────────────────────────────────────────────────
router.get('/events/:eventId/stats', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const eventId = req.params.eventId;

    // Registrations + role mix (ofrece/busca/ambos/incompletas) via LEFT JOIN tags
    const roleQ = await pool.query(
      `WITH r AS (
         SELECT id FROM events.registrations WHERE event_id=$1 AND status <> 'cancelled'
       ), tagged AS (
         SELECT r.id,
                bool_or(rt.kind='offer')  AS has_offer,
                bool_or(rt.kind='demand') AS has_demand,
                COUNT(rt.*) AS tag_count
           FROM r
           LEFT JOIN events.rn_registration_tags rt ON rt.registration_id = r.id
          GROUP BY r.id
       )
       SELECT
         COUNT(*)::int                                                         AS total,
         COUNT(*) FILTER (WHERE has_offer AND NOT has_demand)::int             AS ofrece,
         COUNT(*) FILTER (WHERE has_demand AND NOT has_offer)::int             AS busca,
         COUNT(*) FILTER (WHERE has_offer AND has_demand)::int                 AS ambos,
         COUNT(*) FILTER (WHERE tag_count >= 1)::int                           AS completas,
         COUNT(*) FILTER (WHERE tag_count = 0)::int                            AS incompletas
       FROM tagged`,
      [eventId]
    );
    const roles = roleQ.rows[0];

    const reqQ = await pool.query(
      `SELECT status, COUNT(*)::int AS n
         FROM events.rn_meeting_requests WHERE event_id=$1 GROUP BY status`, [eventId]);
    const requests = { total: 0, pending: 0, accepted: 0, rejected: 0, expired: 0 };
    for (const row of reqQ.rows) { requests[row.status] = row.n; requests.total += row.n; }

    const slotQ = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM events.rn_tables WHERE event_id=$1)   AS tables_total,
         (SELECT COUNT(*)::int FROM events.rn_rounds WHERE event_id=$1 AND kind='meeting') AS rounds_total,
         (SELECT COUNT(*)::int FROM events.rn_meetings WHERE event_id=$1) AS meetings_total`,
      [eventId]
    );
    const slots = slotQ.rows[0];
    const slotsAvailable = (slots.tables_total || 0) * (slots.rounds_total || 0);
    const utilizationPct = slotsAvailable > 0 ? Math.round((slots.meetings_total * 100) / slotsAvailable) : 0;

    const totalEligible = roles.total || 0;
    const completenessPct = totalEligible > 0 ? Math.round((roles.completas * 100) / totalEligible) : 0;

    res.json({
      registrations: { total: totalEligible, completas: roles.completas, incompletas: roles.incompletas, completeness_pct: completenessPct },
      role_mix: { ofrece: roles.ofrece, busca: roles.busca, ambos: roles.ambos },
      requests,
      slots: { tables_total: slots.tables_total, rounds_total: slots.rounds_total, meetings_total: slots.meetings_total, available: slotsAvailable, utilization_pct: utilizationPct },
    });
  } catch (err) { handleError(res, err, 'GET stats'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-7b-3 · Directorio productor (listado de registrations con tags + requests)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/events/:eventId/registrations', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const r = await pool.query(
      `SELECT
         r.id,
         r.status,
         r.custom_fields->>'company_name' AS company_name,
         r.custom_fields->>'contact_name' AS contact_name,
         a.email,
         a.phone,
         a.name AS attendee_name,
         COALESCE(off.tags, ARRAY[]::text[]) AS offer_tags,
         COALESCE(dem.tags, ARRAY[]::text[]) AS demand_tags,
         COALESCE(reqs_in.n, 0)::int  AS requests_received,
         COALESCE(reqs_out.n, 0)::int AS requests_sent
       FROM events.registrations r
       JOIN events.attendees a ON a.id = r.attendee_id
       LEFT JOIN (
         SELECT rt.registration_id, array_agg(t.label ORDER BY t.label) AS tags
           FROM events.rn_registration_tags rt
           JOIN events.rn_tags t ON t.id = rt.tag_id
          WHERE rt.kind = 'offer' GROUP BY rt.registration_id
       ) off ON off.registration_id = r.id
       LEFT JOIN (
         SELECT rt.registration_id, array_agg(t.label ORDER BY t.label) AS tags
           FROM events.rn_registration_tags rt
           JOIN events.rn_tags t ON t.id = rt.tag_id
          WHERE rt.kind = 'demand' GROUP BY rt.registration_id
       ) dem ON dem.registration_id = r.id
       LEFT JOIN (
         SELECT to_registration_id AS rid, COUNT(*) AS n
           FROM events.rn_meeting_requests
          WHERE event_id = $1 GROUP BY to_registration_id
       ) reqs_in ON reqs_in.rid = r.id
       LEFT JOIN (
         SELECT from_registration_id AS rid, COUNT(*) AS n
           FROM events.rn_meeting_requests
          WHERE event_id = $1 GROUP BY from_registration_id
       ) reqs_out ON reqs_out.rid = r.id
       WHERE r.event_id = $1 AND r.ticket_type = 'rueda'
       ORDER BY r.created_at ASC`,
      [req.params.eventId]
    );
    res.json(r.rows);
  } catch (err) { handleError(res, err, 'GET registrations'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-9c #6 · Editar / eliminar inscrito del directorio
// ──────────────────────────────────────────────────────────────────────────────
router.patch('/events/:eventId/registrations/:regId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const { status, company_name, contact_name } = req.body || {};
    if (status && !['pending','approved','confirmed','cancelled'].includes(status)) {
      return res.status(400).json({ error: 'status inválido' });
    }
    const sets = [];
    const params = [];
    if (status !== undefined) { params.push(status); sets.push(`status = $${params.length}`); }
    if (company_name !== undefined || contact_name !== undefined) {
      const patch = {};
      if (company_name !== undefined) patch.company_name = company_name;
      if (contact_name !== undefined) patch.contact_name = contact_name;
      params.push(JSON.stringify(patch));
      sets.push(`custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $${params.length}::jsonb`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
    params.push(req.params.regId, req.params.eventId);
    const r = await pool.query(
      `UPDATE events.registrations SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length-1} AND event_id = $${params.length} AND ticket_type = 'rueda'
         RETURNING id`,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Inscrito no encontrado' });
    res.json({ ok: true });
  } catch (err) { handleError(res, err, 'PATCH registration'); }
});

router.delete('/events/:eventId/registrations/:regId', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const { eventId, regId } = req.params;
    const result = await withTransaction(pool, async (client) => {
      const chk = await client.query(
        `SELECT id FROM events.registrations WHERE id = $1 AND event_id = $2 AND ticket_type = 'rueda'`,
        [regId, eventId]
      );
      if (!chk.rows[0]) { const e = new Error('Inscrito no encontrado'); e.httpStatus = 404; throw e; }
      // Bloquea si tiene redenciones de servicio (histórico operativo)
      const red = await client.query(
        `SELECT 1 FROM events.service_redemptions WHERE registration_id = $1 LIMIT 1`, [regId]
      );
      if (red.rows[0]) {
        const e = new Error('No se puede eliminar: la inscripción tiene servicios canjeados.');
        e.httpStatus = 409; throw e;
      }
      // Limpia dependencias RN con NO ACTION
      await client.query(`DELETE FROM events.rn_meetings WHERE event_id = $1 AND (company_a_id = $2 OR company_b_id = $2 OR initiated_by = $2)`, [eventId, regId]);
      await client.query(`DELETE FROM events.rn_meeting_requests WHERE event_id = $1 AND (from_registration_id = $2 OR to_registration_id = $2)`, [eventId, regId]);
      // Las tablas con CASCADE (rn_registration_tags/anchors/zones/blocklist/delegates/checkins/sessions/certificates/action_tokens) caen solas
      const del = await client.query(
        `DELETE FROM events.registrations WHERE id = $1 AND event_id = $2 AND ticket_type = 'rueda' RETURNING id`,
        [regId, eventId]
      );
      return del.rows[0];
    });
    res.json({ ok: true, id: result.id });
  } catch (err) { handleError(res, err, 'DELETE registration'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-7b-3 · Live callboard productor (rondas + meetings de ronda activa)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/events/:eventId/live', auth, async (req, res) => {
  const pool = global.pool;
  try {
    await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const eventId = req.params.eventId;
    const rounds = await pool.query(
      `SELECT id, round_number, starts_at, ends_at, kind, label, opened_at
         FROM events.rn_rounds WHERE event_id = $1 ORDER BY round_number ASC`,
      [eventId]
    );
    const openRow = rounds.rows.find(r => r.opened_at && r.kind === 'meeting') || null;
    const activeId = openRow ? openRow.id : null;
    let meetings = [];
    if (activeId) {
      const m = await pool.query(
        `SELECT m.id, m.table_id, m.status, m.origin, m.locked,
                t.label AS table_label,
                ra.custom_fields->>'company_name' AS company_a,
                rb.custom_fields->>'company_name' AS company_b
           FROM events.rn_meetings m
           JOIN events.rn_tables t ON t.id = m.table_id
           JOIN events.registrations ra ON ra.id = m.company_a_id
           JOIN events.registrations rb ON rb.id = m.company_b_id
          WHERE m.event_id = $1 AND m.round_id = $2
          ORDER BY t.display_order ASC NULLS LAST, t.label ASC`,
        [eventId, activeId]
      );
      meetings = m.rows;
    }
    const chk = await pool.query(
      `SELECT COUNT(*)::int AS n FROM events.rn_checkins WHERE event_id = $1`, [eventId]);
    res.json({
      rounds: rounds.rows,
      active_round: openRow,
      meetings,
      checkins_total: chk.rows[0].n,
    });
  } catch (err) { handleError(res, err, 'GET live'); }
});

// E-RN-6a · Reporte post-evento productor (D-RN-9 + D-RN-15)
router.get('/events/:eventId/report', auth, async (req, res) => {
  const pool = global.pool;
  try {
    const ev = await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const topN = Math.min(Math.max(parseInt(req.query.top_n, 10) || 10, 1), 50);
    const eventId = req.params.eventId;

    // Per-meeting value computed server-side siguiendo §5.5.1:
    //   bilateral → AVG(a,b) · unilateral → el único lado · nunca SUM(a+b)
    const perMeetingSql = `
      WITH per_meeting AS (
        SELECT
          m.id,
          m.round_id,
          m.table_id,
          m.company_a_id,
          m.company_b_id,
          m.expected_value_a_amount AS a_amt,
          m.expected_value_b_amount AS b_amt,
          m.expected_value_a_currency AS a_cur,
          m.expected_value_b_currency AS b_cur,
          m.expected_value_a_horizon AS a_hor,
          m.expected_value_b_horizon AS b_hor,
          CASE
            WHEN m.expected_value_a_amount IS NOT NULL AND m.expected_value_b_amount IS NOT NULL
              THEN (m.expected_value_a_amount + m.expected_value_b_amount) / 2.0
            WHEN m.expected_value_a_amount IS NOT NULL THEN m.expected_value_a_amount
            WHEN m.expected_value_b_amount IS NOT NULL THEN m.expected_value_b_amount
          END AS meeting_value,
          CASE
            WHEN m.expected_value_a_amount IS NOT NULL AND m.expected_value_b_amount IS NOT NULL THEN 'bilateral'
            WHEN m.expected_value_a_amount IS NOT NULL OR  m.expected_value_b_amount IS NOT NULL THEN 'unilateral'
            ELSE 'empty'
          END AS fill_type,
          CASE
            WHEN m.expected_value_a_amount IS NOT NULL AND m.expected_value_b_amount IS NOT NULL
                 AND m.expected_value_a_horizon = m.expected_value_b_horizon THEN m.expected_value_a_horizon
            WHEN m.expected_value_a_amount IS NOT NULL AND m.expected_value_b_amount IS NOT NULL THEN 'mixed'
            WHEN m.expected_value_a_amount IS NOT NULL THEN m.expected_value_a_horizon
            WHEN m.expected_value_b_amount IS NOT NULL THEN m.expected_value_b_horizon
          END AS horizon_label
        FROM events.rn_meetings m
        WHERE m.event_id = $1
      )
      SELECT * FROM per_meeting
    `;

    const perMeeting = (await pool.query(perMeetingSql, [eventId])).rows;

    const total       = perMeeting.length;
    const withEbv     = perMeeting.filter(r => r.fill_type !== 'empty');
    const bilateral   = perMeeting.filter(r => r.fill_type === 'bilateral');
    const unilateral  = perMeeting.filter(r => r.fill_type === 'unilateral');
    const values      = withEbv.map(r => Number(r.meeting_value)).sort((a, b) => a - b);
    const coverage    = total > 0 ? withEbv.length / total : 0;
    const sum         = values.reduce((s, v) => s + v, 0);
    const avg         = values.length ? sum / values.length : null;
    const min         = values.length ? values[0] : null;
    const max         = values.length ? values[values.length - 1] : null;
    const median      = values.length
      ? (values.length % 2
          ? values[(values.length - 1) / 2]
          : (values[values.length / 2 - 1] + values[values.length / 2]) / 2)
      : null;

    // Horizon breakdown
    const horizonBreakdown = { short: 0, long: 0, mixed: 0, unknown: 0 };
    for (const r of withEbv) {
      const h = r.horizon_label;
      if (h === 'short' || h === 'long' || h === 'mixed') horizonBreakdown[h]++;
      else horizonBreakdown.unknown++;
    }

    // Currency sanity: v1 asume moneda base única (COP). Flag si hay mezcla.
    const currencies = new Set();
    for (const r of withEbv) {
      if (r.a_cur) currencies.add(r.a_cur);
      if (r.b_cur) currencies.add(r.b_cur);
    }
    const mixedCurrencies = currencies.size > 1;

    // Top N nombrado
    const topIds = withEbv
      .slice()
      .sort((a, b) => Number(b.meeting_value) - Number(a.meeting_value))
      .slice(0, topN)
      .map(r => r.id);
    let topRows = [];
    if (topIds.length) {
      topRows = (await pool.query(
        `SELECT m.id,
                rd.round_number,
                t.label AS table_label,
                ra.custom_fields->>'company_name' AS company_a,
                rb.custom_fields->>'company_name' AS company_b
           FROM events.rn_meetings m
           JOIN events.rn_rounds rd ON rd.id = m.round_id
           JOIN events.rn_tables t  ON t.id  = m.table_id
           JOIN events.registrations ra ON ra.id = m.company_a_id
           JOIN events.registrations rb ON rb.id = m.company_b_id
          WHERE m.id = ANY($1::uuid[])`,
        [topIds]
      )).rows;
    }
    const topRowsById = Object.fromEntries(topRows.map(r => [r.id, r]));
    const top = withEbv
      .slice()
      .sort((a, b) => Number(b.meeting_value) - Number(a.meeting_value))
      .slice(0, topN)
      .map(r => ({
        meeting_id:  r.id,
        value:       Number(r.meeting_value),
        fill_type:   r.fill_type,
        horizon:     r.horizon_label,
        round:       topRowsById[r.id]?.round_number ?? null,
        table_label: topRowsById[r.id]?.table_label  ?? null,
        company_a:   topRowsById[r.id]?.company_a    ?? null,
        company_b:   topRowsById[r.id]?.company_b    ?? null,
      }));

    res.json({
      event: {
        id: ev.id,
        name: ev.name,
        status: ev.status,
      },
      meetings: {
        total,
        with_ebv: withEbv.length,
        bilateral: bilateral.length,
        unilateral: unilateral.length,
        empty: total - withEbv.length,
      },
      ebv: {
        total_estimated: sum || null,
        avg_per_meeting: avg,
        median_per_meeting: median,
        min, max,
        horizon_breakdown: horizonBreakdown,
        coverage,
        referential: coverage < 0.20,          // D-RN-15 flag
        mixed_currencies: mixedCurrencies,     // v1 asume COP; v2 FX
      },
      top,
    });
  } catch (err) { handleError(res, err, 'GET report productor'); }
});

// E-RN-6b · Trigger emails post-evento (D-RN-9 §7)
router.post('/events/:eventId/report/send', auth, async (req, res) => {
  const pool = global.pool;
  const email = require('../services/email.js');
  try {
    const ev = await assertRnEventOwned(pool, req.params.eventId, req.user.id);
    const eventId = ev.id;
    const baseUrl = (process.env.CMS_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    // S211o · Idempotencia — si ya se envió y no viene ?force=1 → 409
    const prevSentAt = ev.config?.rn_report_sent_at || null;
    const prevSentCount = ev.config?.rn_report_sent_count || 0;
    const force = req.query.force === '1' || req.query.force === 'true';
    if (prevSentAt && !force) {
      return res.status(409).json({
        error: 'Reporte ya enviado',
        sent_at: prevSentAt,
        sent_count: prevSentCount,
        hint: 'Usa ?force=1 para reenviar',
      });
    }

    // Payload productor (reusa misma semántica del GET /report)
    const perMeeting = (await pool.query(
      `SELECT m.id,
              CASE
                WHEN m.expected_value_a_amount IS NOT NULL AND m.expected_value_b_amount IS NOT NULL
                  THEN (m.expected_value_a_amount + m.expected_value_b_amount) / 2.0
                WHEN m.expected_value_a_amount IS NOT NULL THEN m.expected_value_a_amount
                WHEN m.expected_value_b_amount IS NOT NULL THEN m.expected_value_b_amount
              END AS meeting_value,
              CASE
                WHEN m.expected_value_a_amount IS NOT NULL AND m.expected_value_b_amount IS NOT NULL THEN 'bilateral'
                WHEN m.expected_value_a_amount IS NOT NULL OR  m.expected_value_b_amount IS NOT NULL THEN 'unilateral'
                ELSE 'empty' END AS fill_type
         FROM events.rn_meetings m WHERE m.event_id = $1`,
      [eventId]
    )).rows;
    const totalMeetings = perMeeting.length;
    const withEbv = perMeeting.filter(r => r.fill_type !== 'empty');
    const vals = withEbv.map(r => Number(r.meeting_value)).sort((a, b) => a - b);
    const sumAgg = vals.reduce((s, v) => s + v, 0);
    const coverage = totalMeetings > 0 ? withEbv.length / totalMeetings : 0;
    const metrics = {
      total: totalMeetings, with_ebv: withEbv.length,
      total_estimated: sumAgg || null, coverage, referential: coverage < 0.20,
    };

    // Top 10 nombrado
    const topIds = withEbv.slice().sort((a,b)=>Number(b.meeting_value)-Number(a.meeting_value)).slice(0,10).map(r=>r.id);
    let topRows = [];
    if (topIds.length) {
      topRows = (await pool.query(
        `SELECT m.id, ra.custom_fields->>'company_name' AS company_a, rb.custom_fields->>'company_name' AS company_b
           FROM events.rn_meetings m
           JOIN events.registrations ra ON ra.id=m.company_a_id
           JOIN events.registrations rb ON rb.id=m.company_b_id
          WHERE m.id = ANY($1::uuid[])`, [topIds])).rows;
    }
    const byId = Object.fromEntries(topRows.map(r=>[r.id, r]));
    const top = withEbv.slice().sort((a,b)=>Number(b.meeting_value)-Number(a.meeting_value)).slice(0,10)
      .map(r => ({ value: Number(r.meeting_value), company_a: byId[r.id]?.company_a, company_b: byId[r.id]?.company_b }));

    // Email productor
    const producerEmail = (await pool.query(
      `SELECT u.email, u.name FROM public.users u WHERE u.id=$1`, [req.user.id])).rows[0];
    let sentProducer = 0;
    if (producerEmail?.email) {
      try {
        await email.sendRnProducerSummaryEmail({
          to: producerEmail.email,
          producerName: producerEmail.name || 'Productor',
          eventName: ev.name,
          metrics, top,
          reportUrl: `${baseUrl}/dashboard.html#events-tab`,
          locale: ev.default_locale || 'es',
        });
        sentProducer = 1;
      } catch (e) { console.error('[rn-report/send] producer email error:', e.message); }
    }

    // Delegados primarios: una fila por registration con el delegado primario aceptado
    const delegates = (await pool.query(
      `SELECT d.id              AS delegate_id,
              d.full_name,
              d.email,
              d.agenda_token,
              d.locale,
              r.id              AS registration_id,
              r.custom_fields->>'company_name' AS company_name
         FROM events.rn_delegates d
         JOIN events.registrations r ON r.id = d.registration_id
        WHERE r.event_id = $1 AND d.is_primary = TRUE AND d.accepted_at IS NOT NULL`,
      [eventId]
    )).rows;

    let sentDelegates = 0;
    for (const d of delegates) {
      const regId = d.registration_id;
      const myMeetings = (await pool.query(
        `SELECT m.id,
                rd.round_number,
                t.label AS table_label,
                CASE WHEN m.company_a_id=$1 THEN m.expected_value_a_amount
                     ELSE m.expected_value_b_amount END AS my_amount,
                CASE WHEN m.company_a_id=$1 THEN rb.custom_fields->>'company_name'
                     ELSE ra.custom_fields->>'company_name' END AS counterpart_company
           FROM events.rn_meetings m
           JOIN events.rn_rounds rd ON rd.id=m.round_id
           JOIN events.rn_tables t  ON t.id=m.table_id
           JOIN events.registrations ra ON ra.id=m.company_a_id
           JOIN events.registrations rb ON rb.id=m.company_b_id
          WHERE m.event_id=$2 AND (m.company_a_id=$1 OR m.company_b_id=$1)
          ORDER BY rd.round_number ASC`,
        [regId, eventId]
      )).rows;

      const myFilled = myMeetings.filter(r => r.my_amount != null);
      const mySum = myFilled.reduce((s, r) => s + Number(r.my_amount), 0);

      try {
        await email.sendRnEventSummaryEmail({
          to: d.email,
          delegateName: d.full_name,
          companyName: d.company_name,
          eventName: ev.name,
          agendaUrl: `${baseUrl}/rueda/mi-agenda/${d.agenda_token}`,
          meetings: myMeetings.map(m => ({
            counterpart_company: m.counterpart_company,
            round: m.round_number,
            table_label: m.table_label,
          })),
          myEbv: { sum: mySum || null, filled: myFilled.length },
          aggregate: {
            total_meetings: totalMeetings,
            with_ebv: withEbv.length,
            total_estimated: metrics.total_estimated,
            referential: metrics.referential,
          },
          locale: d.locale || ev.default_locale || 'es',
        });
        sentDelegates++;
      } catch (e) { console.error(`[rn-report/send] delegate email error ${d.email}:`, e.message); }
    }

    // S211o · Marcar enviado (idempotencia). jsonb_set aditivo, no reescribe otras keys.
    const sentAt = new Date().toISOString();
    await pool.query(
      `UPDATE events.events
          SET config = jsonb_set(
            jsonb_set(COALESCE(config,'{}'::jsonb), '{rn_report_sent_at}', to_jsonb($2::text), TRUE),
            '{rn_report_sent_count}', to_jsonb(($3::int)), TRUE)
        WHERE id = $1`,
      [eventId, sentAt, prevSentCount + 1]
    );

    res.json({
      event_id: eventId,
      sent_to_delegates: sentDelegates,
      delegates_total: delegates.length,
      sent_to_producer: sentProducer,
      sent_at: sentAt,
      sent_count: prevSentCount + 1,
      resend: force && prevSentAt != null,
    });
  } catch (err) { handleError(res, err, 'POST report/send'); }
});

module.exports = router;
