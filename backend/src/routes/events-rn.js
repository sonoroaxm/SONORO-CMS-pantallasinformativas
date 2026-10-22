// Rueda de Negocios v1 — Rutas setup productor (/api/rn/*)
// Framework: docs/EVENTS-RUEDA-NEGOCIOS-FRAMEWORK.md v1.1
// Fase: E-RN-1 (setup + inscripción productor-side)
// P-2: todo filtro incluye user_id vía JOIN events.events
// P-3: mutaciones ≥2 tablas usan withTransaction

'use strict';
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { withTransaction } = require('../db/withTransaction');
const solver = require('../services/matchmaking-solver');

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
    `SELECT id, user_id, config FROM events.events WHERE id = $1`, [eventId]
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
        const r = await client.query(
          `INSERT INTO events.rn_tables (event_id, zone_id, label, display_order, active)
           VALUES ($1, $2, $3, COALESCE($4, $5), TRUE)
           RETURNING *`,
          [req.params.eventId, it.zone_id || null, it.label, it.display_order, i]
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
    const { starts_at, meeting_minutes = 20, total_rounds = 10, break_every = 0, break_minutes = 10 } = req.body || {};
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
        if (break_every > 0 && i < total_rounds && i % break_every === 0) {
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
    const { label, category } = req.body || {};
    if (!label) return res.status(400).json({ error: 'label requerido' });
    const slug = slugify(label);
    const r = await pool.query(
      `INSERT INTO events.rn_tags (user_id, slug, label, category)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, slug, label, category || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { handleError(res, err, 'POST tag'); }
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
    const result = await withTransaction(pool, async (client) => solver.resetMeetings(client, req.params.eventId));
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

    const result = await withTransaction(pool, async (client) =>
      solver.runRuntimeRound(client, { eventId: req.params.eventId, roundId: req.params.roundId })
    );
    console.log(`[rn-solver] runtime event=${req.params.eventId} round=${req.params.roundId} deferred=${result.deferred_count}`);
    res.json(result);
  } catch (err) { handleError(res, err, 'POST rounds/open'); }
});

module.exports = router;
