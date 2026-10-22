// Rueda de Negocios v1 — Rutas públicas (/api/rn/public/*)
// Framework: docs/EVENTS-RUEDA-NEGOCIOS-FRAMEWORK.md v1.1 — Fase E-RN-1b
// Sin JWT. Dos modos de auth:
//   (a) Rate-limited público — POST /:eventSlug/register (inscripción empresa)
//   (b) Token-based — delegates/* usan ?token=<agenda_token UUID>
// P-2 multi-tenancy: user_id derivado del evento (slug) o del delegado (token)
// P-3 transaccionalidad: register + delegate + email trigger via withTransaction

'use strict';
const express   = require('express');
const router    = express.Router();
const rateLimit = require('express-rate-limit');
const { withTransaction } = require('../db/withTransaction');
const {
  sendRnWelcomeEmail,
  sendRnDelegateInvitedEmail,
  sendRnRequestReceivedEmail,
  sendRnRequestAcceptedEmail,
  sendRnRequestRejectedEmail,
} = require('../services/email');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const rnReadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes' },
});
const rnRegisterLimiter = rateLimit({
  windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos de registro, reintenta en un momento' },
});
const rnTokenMutationLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas operaciones, reintenta en un momento' },
});

function handleError(res, err, where) {
  if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'Registro duplicado' });
  if (err.code === '23503') return res.status(409).json({ error: 'Referencia inválida' });
  console.error('[rn-public]', where, err);
  res.status(500).json({ error: 'Error interno' });
}

// Resuelve agenda_token → { delegate, registration, event }
// Throw con httpStatus si inválido. Siempre JOIN con event para P-2 user_id.
async function resolveToken(pool, token) {
  if (!token || !UUID_RE.test(token)) {
    const e = new Error('Token inválido'); e.httpStatus = 401; throw e;
  }
  const { rows } = await pool.query(
    `SELECT d.id              AS delegate_id,
            d.registration_id,
            d.full_name,
            d.email            AS delegate_email,
            d.is_primary,
            d.can_manage_team,
            d.accepted_at,
            r.event_id,
            r.user_id,
            e.name             AS event_name,
            e.slug             AS event_slug,
            e.status           AS event_status,
            e.config           AS event_config,
            e.timezone         AS event_timezone
       FROM events.rn_delegates d
       JOIN events.registrations r ON r.id = d.registration_id
       JOIN events.events e        ON e.id = r.event_id
      WHERE d.agenda_token = $1`,
    [token]
  );
  if (!rows[0]) {
    const e = new Error('Token no reconocido'); e.httpStatus = 404; throw e;
  }
  return rows[0];
}

function agendaUrl(req, token) {
  const base = process.env.CMS_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/rueda/mi-agenda/${token}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/rn/public/:eventSlug/register
// Inscripción pública de empresa a una Rueda de Negocios.
// Crea: attendees (upsert) + registrations + rn_delegates (primario). Email bienvenida.
// Body: { company_name, pitch?, website?, delegate: { full_name, email, phone?, role_title? }, accepted_terms, hp_field? }
// ──────────────────────────────────────────────────────────────────────────────
router.post('/:eventSlug/register', rnRegisterLimiter, async (req, res) => {
  const pool = global.pool;
  const {
    company_name,
    pitch,
    website,
    delegate = {},
    tags = {},                   // E-RN-2: {offer:[tagId,...], demand:[tagId,...]}
    visibility_choice,           // E-RN-2: 'public'|'private' solo si cfg.visibility='mixed'
    accepted_terms,
    hp_field = '',
    locale: rawLocale,
  } = req.body || {};
  const locale = ['es', 'en', 'pt-BR'].includes(rawLocale) ? rawLocale : 'es';

  if (hp_field !== '') return res.status(400).json({ error: 'Error de validación' });
  if (!accepted_terms) return res.status(400).json({ error: 'Debes aceptar los términos' });
  if (!company_name || !String(company_name).trim()) {
    return res.status(400).json({ error: 'El nombre de la empresa es requerido' });
  }
  if (!delegate.full_name || !String(delegate.full_name).trim()) {
    return res.status(400).json({ error: 'El nombre del delegado es requerido' });
  }
  if (!delegate.email || !EMAIL_RE.test(String(delegate.email))) {
    return res.status(400).json({ error: 'Email del delegado inválido' });
  }

  const cleanEmail = String(delegate.email).toLowerCase().trim();
  const companyName = String(company_name).trim();
  const delegateName = String(delegate.full_name).trim();

  try {
    const { rows: evRows } = await pool.query(
      `SELECT id, name, slug, user_id, timezone, config, status
         FROM events.events
        WHERE slug = $1 AND status IN ('published','live')`,
      [req.params.eventSlug]
    );
    if (!evRows[0]) return res.status(404).json({ error: 'Rueda no encontrada o no disponible' });
    const event = evRows[0];
    const cfg = event.config || {};
    if (cfg.event_type !== 'matchmaking') {
      return res.status(400).json({ error: 'Este evento no es una rueda de negocios' });
    }
    if (cfg.registration_open === false) {
      return res.status(409).json({ error: 'La inscripción está cerrada' });
    }

    const maxCap = cfg.max_capacity;
    if (maxCap) {
      const { rows: cap } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM events.registrations WHERE event_id = $1 AND status != 'cancelled'`,
        [event.id]
      );
      if (cap[0].c >= maxCap) {
        return res.status(409).json({ error: 'La rueda alcanzó su capacidad máxima' });
      }
    }

    // E-RN-2: visibility choice (solo relevante si cfg.visibility='mixed')
    const eventVis = (cfg.matchmaking && cfg.matchmaking.visibility) || cfg.visibility || 'public';
    let rnVisibility = null;
    if (eventVis === 'mixed') {
      rnVisibility = (visibility_choice === 'private') ? 'private' : 'public';
    }

    // E-RN-2: tags offer/demand — ignorados si matching_mode='manual_only'
    const matchingMode = (cfg.matchmaking && cfg.matchmaking.matching_mode) || cfg.matching_mode || 'tags';
    const offerIds  = Array.isArray(tags.offer)  ? tags.offer.filter(x => UUID_RE.test(String(x)))  : [];
    const demandIds = Array.isArray(tags.demand) ? tags.demand.filter(x => UUID_RE.test(String(x))) : [];
    let validOffer = [], validDemand = [];
    if (matchingMode !== 'manual_only' && (offerIds.length || demandIds.length)) {
      const allIds = [...new Set([...offerIds, ...demandIds])];
      const tagCheck = await pool.query(
        `SELECT id FROM events.rn_tags WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [event.user_id, allIds]
      );
      const ok = new Set(tagCheck.rows.map(r => r.id));
      validOffer  = offerIds.filter(id => ok.has(id));
      validDemand = demandIds.filter(id => ok.has(id));
    }

    const customFields = {
      company_name: companyName,
      pitch: pitch ? String(pitch).trim().slice(0, 1000) : null,
      website: website ? String(website).trim().slice(0, 300) : null,
      rn_visibility: rnVisibility,
    };

    const result = await withTransaction(pool, async (client) => {
      // Upsert attendee (CRM del tenant)
      const attRes = await client.query(
        `INSERT INTO events.attendees
           (user_id, email, name, phone, organization, job_title, locale)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, email) DO UPDATE SET
           name         = EXCLUDED.name,
           phone        = COALESCE(EXCLUDED.phone,        events.attendees.phone),
           organization = COALESCE(EXCLUDED.organization, events.attendees.organization),
           job_title    = COALESCE(EXCLUDED.job_title,    events.attendees.job_title),
           locale       = EXCLUDED.locale,
           updated_at   = NOW()
         RETURNING id`,
        [event.user_id, cleanEmail, delegateName, delegate.phone || null,
         companyName, delegate.role_title || null, locale]
      );
      const attendee_id = attRes.rows[0].id;

      // Insert registration (una empresa × evento)
      const regRes = await client.query(
        `INSERT INTO events.registrations
           (event_id, attendee_id, user_id, ticket_type, origin, custom_fields, accepted_terms, status)
         VALUES ($1,$2,$3,'rueda','web_form',$4,TRUE,'confirmed')
         ON CONFLICT (event_id, attendee_id) DO NOTHING
         RETURNING id, qr_token`,
        [event.id, attendee_id, event.user_id, JSON.stringify(customFields)]
      );
      if (!regRes.rows[0]) {
        const e = new Error('Esta empresa ya está inscrita en la rueda');
        e.httpStatus = 409; throw e;
      }
      const registration = regRes.rows[0];

      // Insert rn_delegates primario
      const delRes = await client.query(
        `INSERT INTO events.rn_delegates
           (registration_id, full_name, email, phone, role_title, is_primary, can_manage_team, accepted_at)
         VALUES ($1,$2,$3,$4,$5,TRUE,TRUE,NOW())
         RETURNING id, agenda_token`,
        [registration.id, delegateName, cleanEmail, delegate.phone || null, delegate.role_title || null]
      );

      // E-RN-2: tags offer/demand
      for (const tagId of validOffer) {
        await client.query(
          `INSERT INTO events.rn_registration_tags (registration_id, tag_id, kind)
           VALUES ($1,$2,'offer') ON CONFLICT DO NOTHING`,
          [registration.id, tagId]
        );
      }
      for (const tagId of validDemand) {
        await client.query(
          `INSERT INTO events.rn_registration_tags (registration_id, tag_id, kind)
           VALUES ($1,$2,'demand') ON CONFLICT DO NOTHING`,
          [registration.id, tagId]
        );
      }

      return { registration, delegate: delRes.rows[0], event };
    });

    const url = agendaUrl(req, result.delegate.agenda_token);
    sendRnWelcomeEmail({
      to: cleanEmail,
      delegateName,
      companyName,
      eventName: event.name,
      eventSlug: event.slug,
      agendaUrl: url,
      locale,
    }).catch(e => console.error('⚠️ Email rn-welcome fallido:', e.message));

    global.io?.to(`event_${event.id}`).emit('rn.registered', {
      user_id: event.user_id, event_id: event.id,
      registration_id: result.registration.id,
      company_name: companyName,
    });

    console.log(`[rn-public] register event=${event.slug} company="${companyName}" delegate=${cleanEmail}`);
    res.status(201).json({
      registration_id: result.registration.id,
      delegate_id: result.delegate.id,
      agenda_url: url,
      email_sent: true,
    });
  } catch (err) { handleError(res, err, 'POST register'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// Delegate CRUD por agenda_token
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/rn/public/delegates?token=<primary_token>  → lista equipo
router.get('/delegates', rnReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!ctx.is_primary || !ctx.can_manage_team) {
      return res.status(403).json({ error: 'Solo el delegado primario puede ver el equipo' });
    }
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone, role_title, is_primary,
              invited_at, accepted_at, created_at
         FROM events.rn_delegates
        WHERE registration_id = $1
        ORDER BY is_primary DESC, created_at ASC`,
      [ctx.registration_id]
    );
    res.json({ event: { name: ctx.event_name, slug: ctx.event_slug }, delegates: rows });
  } catch (err) { handleError(res, err, 'GET delegates'); }
});

// POST /api/rn/public/delegates?token=<primary_token>  → invita secundario
router.post('/delegates', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!ctx.is_primary || !ctx.can_manage_team) {
      return res.status(403).json({ error: 'Solo el delegado primario puede invitar' });
    }

    const { full_name, email, phone, role_title } = req.body || {};
    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ error: 'full_name requerido' });
    }
    if (!email || !EMAIL_RE.test(String(email))) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    const cleanEmail = String(email).toLowerCase().trim();
    const cleanName  = String(full_name).trim();

    // Verificar no duplicado dentro de la misma empresa
    const dup = await pool.query(
      `SELECT 1 FROM events.rn_delegates
        WHERE registration_id = $1 AND LOWER(email) = $2`,
      [ctx.registration_id, cleanEmail]
    );
    if (dup.rowCount > 0) {
      return res.status(409).json({ error: 'Ya existe un delegado con ese email en esta empresa' });
    }

    const { rows } = await pool.query(
      `INSERT INTO events.rn_delegates
         (registration_id, full_name, email, phone, role_title, is_primary, can_manage_team, invited_by, invited_at)
       VALUES ($1,$2,$3,$4,$5,FALSE,FALSE,$6,NOW())
       RETURNING id, agenda_token`,
      [ctx.registration_id, cleanName, cleanEmail, phone || null, role_title || null, ctx.delegate_id]
    );
    const newDel = rows[0];

    const url = agendaUrl(req, newDel.agenda_token);
    sendRnDelegateInvitedEmail({
      to: cleanEmail,
      delegateName: cleanName,
      inviterName: ctx.full_name,
      companyName: (await pool.query(
        `SELECT custom_fields->>'company_name' AS c FROM events.registrations WHERE id = $1`,
        [ctx.registration_id]
      )).rows[0]?.c || '',
      eventName: ctx.event_name,
      agendaUrl: url,
    }).catch(e => console.error('⚠️ Email rn-delegate-invited fallido:', e.message));

    console.log(`[rn-public] delegate invited event=${ctx.event_slug} by=${ctx.delegate_email} new=${cleanEmail}`);
    res.status(201).json({ delegate_id: newDel.id, agenda_url: url });
  } catch (err) { handleError(res, err, 'POST delegate'); }
});

// DELETE /api/rn/public/delegates/:delegateId?token=<primary_token>
router.delete('/delegates/:delegateId', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!ctx.is_primary || !ctx.can_manage_team) {
      return res.status(403).json({ error: 'Solo el delegado primario puede remover' });
    }
    if (!UUID_RE.test(req.params.delegateId)) {
      return res.status(400).json({ error: 'delegateId inválido' });
    }

    // El target debe pertenecer a la misma empresa y NO ser primario
    const r = await pool.query(
      `DELETE FROM events.rn_delegates
        WHERE id = $1 AND registration_id = $2 AND is_primary = FALSE
        RETURNING id`,
      [req.params.delegateId, ctx.registration_id]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'Delegado no encontrado o no removible' });
    }
    console.log(`[rn-public] delegate removed event=${ctx.event_slug} target=${req.params.delegateId}`);
    res.status(204).end();
  } catch (err) { handleError(res, err, 'DELETE delegate'); }
});

// PATCH /api/rn/public/delegates/me?token=<any_token>
// El delegado edita sus propios datos y marca accepted_at en primera visita.
router.patch('/delegates/me', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    const { full_name, phone, role_title } = req.body || {};
    const r = await pool.query(
      `UPDATE events.rn_delegates
          SET full_name   = COALESCE($1, full_name),
              phone       = COALESCE($2, phone),
              role_title  = COALESCE($3, role_title),
              accepted_at = COALESCE(accepted_at, NOW())
        WHERE id = $4
        RETURNING id, full_name, email, phone, role_title, is_primary, accepted_at`,
      [full_name || null, phone || null, role_title || null, ctx.delegate_id]
    );
    console.log(`[rn-public] delegate accepted/updated event=${ctx.event_slug} delegate=${ctx.delegate_email}`);
    res.json(r.rows[0]);
  } catch (err) { handleError(res, err, 'PATCH /me'); }
});

// GET /api/rn/public/delegates/me?token=<any_token> → self info (útil para pintar la agenda)
router.get('/delegates/me', rnReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    res.json({
      delegate: {
        id: ctx.delegate_id,
        full_name: ctx.full_name,
        email: ctx.delegate_email,
        is_primary: ctx.is_primary,
        can_manage_team: ctx.can_manage_team,
        accepted_at: ctx.accepted_at,
      },
      event: {
        name: ctx.event_name,
        slug: ctx.event_slug,
        timezone: ctx.event_timezone,
        status: ctx.event_status,
      },
    });
  } catch (err) { handleError(res, err, 'GET /me'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-2 · Público — tags del tenant (para el formulario de inscripción)
// GET /api/rn/public/:eventSlug/tags → lista tags disponibles del productor
// ──────────────────────────────────────────────────────────────────────────────
router.get('/:eventSlug/tags', rnReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const { rows: evRows } = await pool.query(
      `SELECT user_id, config FROM events.events
        WHERE slug = $1 AND status IN ('published','live')`,
      [req.params.eventSlug]
    );
    if (!evRows[0]) return res.status(404).json({ error: 'Rueda no encontrada' });
    const ev = evRows[0];
    const cfg = ev.config || {};
    const matchingMode = (cfg.matchmaking && cfg.matchmaking.matching_mode) || cfg.matching_mode || 'tags';
    if (matchingMode === 'manual_only') return res.json({ matching_mode: 'manual_only', tags: [] });

    const { rows } = await pool.query(
      `SELECT id, slug, label, category FROM events.rn_tags
        WHERE user_id = $1
        ORDER BY category NULLS LAST, label`,
      [ev.user_id]
    );
    res.json({ matching_mode: matchingMode, tags: rows });
  } catch (err) { handleError(res, err, 'GET tags'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-2 · Directorio (D-RN-16 views match/all · D-RN-17 matching_mode)
// GET /api/rn/public/directory/:eventSlug?token=<agenda_token>
//   &view=match|all  &q=  &tags=<csv>  &role=seller|buyer|both  &page=<n>
// ──────────────────────────────────────────────────────────────────────────────
router.get('/directory/:eventSlug', rnReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    // El token debe pertenecer al mismo evento del path
    if (ctx.event_slug !== req.params.eventSlug) {
      return res.status(403).json({ error: 'Token no corresponde a esta rueda' });
    }

    const cfg = ctx.event_config || {};
    const mm  = cfg.matchmaking || {};
    const eventVis   = mm.visibility || cfg.visibility || 'public';
    const matchingMode = mm.matching_mode || cfg.matching_mode || 'tags';
    const defaultView  = mm.directory_default_view || cfg.directory_default_view || 'match';
    const PAGE_SIZE = 24;

    if (eventVis === 'private') {
      return res.json({ view: 'match', total: 0, page: 1, page_size: PAGE_SIZE, results: [] });
    }

    const requestedView = String(req.query.view || defaultView);
    const view = (requestedView === 'all') ? 'all' : 'match';
    const q    = String(req.query.q || '').trim().slice(0, 100);
    const role = ['seller','buyer','both'].includes(req.query.role) ? req.query.role : null;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const tagFilter = String(req.query.tags || '')
      .split(',').map(s => s.trim()).filter(s => UUID_RE.test(s));

    // mis tags para calcular overlap
    const myTagsRes = await pool.query(
      `SELECT tag_id, kind FROM events.rn_registration_tags WHERE registration_id = $1`,
      [ctx.registration_id]
    );
    const myOffer  = myTagsRes.rows.filter(t => t.kind === 'offer').map(t => t.tag_id);
    const myDemand = myTagsRes.rows.filter(t => t.kind === 'demand').map(t => t.tag_id);

    // tag_overlap_score = count(their offer ∩ my demand) + count(their demand ∩ my offer)
    // Si matching_mode='manual_only' → siempre 0 (ignora tags en filtro y sort)
    const scoreSelect = (matchingMode === 'manual_only')
      ? `0 AS score`
      : `(
          SELECT COUNT(*)::int FROM events.rn_registration_tags rt
          WHERE rt.registration_id = r.id
            AND ((rt.kind = 'offer'  AND rt.tag_id = ANY($2::uuid[]))
              OR (rt.kind = 'demand' AND rt.tag_id = ANY($3::uuid[])))
        ) AS score`;

    const params = [ctx.event_id, myDemand, myOffer];
    let where = `r.event_id = $1 AND r.id <> $4 AND r.status != 'cancelled'`;
    params.push(ctx.registration_id);

    // visibility='mixed' → solo quienes marcaron rn_visibility='public'
    if (eventVis === 'mixed') {
      where += ` AND (r.custom_fields->>'rn_visibility') = 'public'`;
    }

    // Blocklist bidireccional — oculta ambos lados
    where += ` AND NOT EXISTS (
      SELECT 1 FROM events.rn_blocklist b
      WHERE (b.registration_id = $4 AND b.blocked_registration_id = r.id)
         OR (b.registration_id = r.id AND b.blocked_registration_id = $4)
    )`;

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where += ` AND (
        LOWER(r.custom_fields->>'company_name') LIKE $${params.length}
        OR LOWER(COALESCE(r.custom_fields->>'pitch','')) LIKE $${params.length}
      )`;
    }

    if (tagFilter.length && matchingMode !== 'manual_only') {
      params.push(tagFilter);
      where += ` AND EXISTS (
        SELECT 1 FROM events.rn_registration_tags rt
        WHERE rt.registration_id = r.id AND rt.tag_id = ANY($${params.length}::uuid[])
      )`;
    }

    // role filter (seller/buyer/both basado en qué kinds tiene la empresa)
    if (role) {
      if (role === 'seller') {
        where += ` AND EXISTS (SELECT 1 FROM events.rn_registration_tags rt WHERE rt.registration_id = r.id AND rt.kind = 'offer')`;
      } else if (role === 'buyer') {
        where += ` AND EXISTS (SELECT 1 FROM events.rn_registration_tags rt WHERE rt.registration_id = r.id AND rt.kind = 'demand')`;
      } else if (role === 'both') {
        where += ` AND EXISTS (SELECT 1 FROM events.rn_registration_tags rt WHERE rt.registration_id = r.id AND rt.kind = 'offer')
                   AND EXISTS (SELECT 1 FROM events.rn_registration_tags rt WHERE rt.registration_id = r.id AND rt.kind = 'demand')`;
      }
    }

    // view=match → threshold ≥ 1 (default). view=all → sin filtro mínimo (pero mantiene seller/both heurística).
    if (view === 'match' && matchingMode !== 'manual_only') {
      // threshold vive en cfg
      const threshold = Number(mm.default_tag_overlap_threshold || 1);
      // Lo aplicamos en HAVING-like via subquery abajo
      params.push(threshold);
      where += ` AND (
        SELECT COUNT(*) FROM events.rn_registration_tags rt
        WHERE rt.registration_id = r.id
          AND ((rt.kind = 'offer'  AND rt.tag_id = ANY($2::uuid[]))
            OR (rt.kind = 'demand' AND rt.tag_id = ANY($3::uuid[])))
      ) >= $${params.length}`;
    }

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM events.registrations r WHERE ${where}`,
      params
    );
    const total = countRes.rows[0].c;

    const orderBy = (view === 'all')
      ? `score DESC NULLS LAST, LOWER(r.custom_fields->>'company_name') ASC`
      : `score DESC NULLS LAST, LOWER(r.custom_fields->>'company_name') ASC`;

    const offset = (page - 1) * PAGE_SIZE;
    params.push(PAGE_SIZE); params.push(offset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const listRes = await pool.query(
      `SELECT r.id,
              r.custom_fields->>'company_name' AS company_name,
              r.custom_fields->>'pitch'        AS pitch,
              r.custom_fields->>'website'      AS website,
              ${scoreSelect}
         FROM events.registrations r
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    res.json({
      view, matching_mode: matchingMode, total,
      page, page_size: PAGE_SIZE,
      results: listRes.rows,
    });
  } catch (err) { handleError(res, err, 'GET directory'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-2 · Meeting requests (peer-to-peer)
// POST /api/rn/public/requests?token=<token>  Body: { to_registration_id, message? }
// POST /api/rn/public/requests/:id/respond?token=<token>  Body: { action: 'accept'|'reject' }
// GET  /api/rn/public/requests?token=<token>&direction=in|out
// ──────────────────────────────────────────────────────────────────────────────
router.post('/requests', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    const { to_registration_id, message } = req.body || {};
    if (!to_registration_id || !UUID_RE.test(String(to_registration_id))) {
      return res.status(400).json({ error: 'to_registration_id requerido' });
    }
    if (to_registration_id === ctx.registration_id) {
      return res.status(400).json({ error: 'No puedes pedir una reunión contigo mismo' });
    }

    // Target debe estar en el mismo evento + no cancelado + no bloqueado
    const tgt = await pool.query(
      `SELECT r.id, r.custom_fields->>'company_name' AS company_name,
              r.custom_fields->>'rn_visibility' AS rn_vis,
              EXISTS (
                SELECT 1 FROM events.rn_blocklist b
                 WHERE (b.registration_id = $1 AND b.blocked_registration_id = r.id)
                    OR (b.registration_id = r.id AND b.blocked_registration_id = $1)
              ) AS blocked
         FROM events.registrations r
        WHERE r.id = $2 AND r.event_id = $3 AND r.status != 'cancelled'`,
      [ctx.registration_id, to_registration_id, ctx.event_id]
    );
    if (!tgt.rows[0]) return res.status(404).json({ error: 'Empresa destino no encontrada' });
    if (tgt.rows[0].blocked) return res.status(403).json({ error: 'Esta empresa no está disponible' });

    // Email primario destino
    const primary = await pool.query(
      `SELECT full_name, email, agenda_token FROM events.rn_delegates
        WHERE registration_id = $1 AND is_primary = TRUE LIMIT 1`,
      [to_registration_id]
    );

    try {
      const ins = await pool.query(
        `INSERT INTO events.rn_meeting_requests
           (event_id, from_registration_id, to_registration_id, message)
         VALUES ($1,$2,$3,$4)
         RETURNING id, status, created_at`,
        [ctx.event_id, ctx.registration_id, to_registration_id,
         message ? String(message).slice(0, 500) : null]
      );
      const request = ins.rows[0];

      if (primary.rows[0]) {
        const fromCompanyRow = await pool.query(
          `SELECT custom_fields->>'company_name' AS c FROM events.registrations WHERE id = $1`,
          [ctx.registration_id]
        );
        sendRnRequestReceivedEmail({
          to: primary.rows[0].email,
          delegateName: primary.rows[0].full_name,
          fromCompanyName: fromCompanyRow.rows[0]?.c || '',
          eventName: ctx.event_name,
          agendaUrl: agendaUrl(req, primary.rows[0].agenda_token),
          message: message || null,
        }).catch(e => console.error('⚠️ Email rn-request-received fallido:', e.message));
      }

      console.log(`[rn-public] request event=${ctx.event_slug} from=${ctx.registration_id} to=${to_registration_id}`);
      res.status(201).json(request);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una solicitud pendiente a esta empresa' });
      throw err;
    }
  } catch (err) { handleError(res, err, 'POST request'); }
});

router.post('/requests/:id/respond', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });

    const action = req.body?.action;
    if (!['accept','reject'].includes(action)) {
      return res.status(400).json({ error: "action debe ser 'accept' o 'reject'" });
    }
    const newStatus = (action === 'accept') ? 'accepted' : 'rejected';

    const upd = await pool.query(
      `UPDATE events.rn_meeting_requests
          SET status = $1, responded_at = NOW()
        WHERE id = $2
          AND to_registration_id = $3
          AND status = 'pending'
        RETURNING id, from_registration_id, to_registration_id, status, message`,
      [newStatus, req.params.id, ctx.registration_id]
    );
    if (upd.rowCount === 0) {
      return res.status(404).json({ error: 'Solicitud no encontrada o ya respondida' });
    }
    const r = upd.rows[0];

    // Email al origen (delegado primario)
    const fromPrim = await pool.query(
      `SELECT d.email, d.full_name, d.agenda_token,
              rg.custom_fields->>'company_name' AS from_company,
              rt.custom_fields->>'company_name' AS to_company
         FROM events.rn_delegates d
         JOIN events.registrations rg ON rg.id = d.registration_id
         JOIN events.registrations rt ON rt.id = $2
        WHERE d.registration_id = $1 AND d.is_primary = TRUE
        LIMIT 1`,
      [r.from_registration_id, r.to_registration_id]
    );
    if (fromPrim.rows[0]) {
      const payload = {
        to: fromPrim.rows[0].email,
        delegateName: fromPrim.rows[0].full_name,
        targetCompanyName: fromPrim.rows[0].to_company || '',
        eventName: ctx.event_name,
        agendaUrl: agendaUrl(req, fromPrim.rows[0].agenda_token),
      };
      if (newStatus === 'accepted') {
        sendRnRequestAcceptedEmail(payload).catch(e => console.error('⚠️ Email rn-request-accepted:', e.message));
      } else {
        sendRnRequestRejectedEmail(payload).catch(e => console.error('⚠️ Email rn-request-rejected:', e.message));
      }
    }

    console.log(`[rn-public] request ${newStatus} event=${ctx.event_slug} id=${req.params.id}`);
    res.json(r);
  } catch (err) { handleError(res, err, 'POST request/respond'); }
});

router.get('/requests', rnReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    const direction = (req.query.direction === 'out') ? 'out' : 'in';
    const sideCol = (direction === 'in') ? 'to_registration_id' : 'from_registration_id';
    const otherCol = (direction === 'in') ? 'from_registration_id' : 'to_registration_id';

    const { rows } = await pool.query(
      `SELECT q.id, q.status, q.message, q.created_at, q.responded_at,
              q.${otherCol} AS other_registration_id,
              r.custom_fields->>'company_name' AS other_company
         FROM events.rn_meeting_requests q
         JOIN events.registrations r ON r.id = q.${otherCol}
        WHERE q.${sideCol} = $1 AND q.event_id = $2
        ORDER BY q.created_at DESC`,
      [ctx.registration_id, ctx.event_id]
    );
    res.json({ direction, requests: rows });
  } catch (err) { handleError(res, err, 'GET requests'); }
});

module.exports = router;
