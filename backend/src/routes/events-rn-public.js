// Rueda de Negocios v1 — Rutas públicas (/api/rn/public/*)
// Framework: docs/EVENTS-RUEDA-NEGOCIOS-FRAMEWORK.md v1.1 — Fase E-RN-1b
// Sin JWT. Dos modos de auth:
//   (a) Rate-limited público — POST /:eventSlug/register (inscripción empresa)
//   (b) Token-based — delegates/* usan ?token=<agenda_token UUID>
// P-2 multi-tenancy: user_id derivado del evento (slug) o del delegado (token)
// P-3 transaccionalidad: register + delegate + email trigger via withTransaction

'use strict';
const express   = require('express');
const crypto    = require('crypto');
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
            d.locale           AS delegate_locale,
            d.visible_in_directory,
            r.event_id,
            r.user_id,
            e.name             AS event_name,
            e.slug             AS event_slug,
            e.status           AS event_status,
            e.config           AS event_config,
            e.timezone         AS event_timezone,
            e.default_locale   AS event_default_locale
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
    consent_text,                // S211t B.1: texto literal mostrado al titular (SHA-256)
    consent_policy_version,      // S211t B.1: versión política vigente (ej. '1.0')
    hp_field = '',
    locale: rawLocale,
  } = req.body || {};
  const locale = ['es', 'en', 'pt'].includes(rawLocale) ? rawLocale
               : rawLocale === 'pt-BR' ? 'pt' : null;

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
      `SELECT id, name, slug, user_id, timezone, config, status, default_locale
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

      // S211t B.1: audit trail del consentimiento (Ley 1581)
      const consentHash = consent_text
        ? crypto.createHash('sha256').update(String(consent_text), 'utf8').digest('hex')
        : null;
      const consentIp = (req.headers['x-forwarded-for'] || req.ip || '')
        .toString().split(',')[0].trim() || null;
      const consentUa = (req.headers['user-agent'] || '').toString().slice(0, 500) || null;
      const consentVersion = (typeof consent_policy_version === 'string' && consent_policy_version.length <= 20)
        ? consent_policy_version : '1.0';

      // Insert registration (una empresa × evento)
      const regRes = await client.query(
        `INSERT INTO events.registrations
           (event_id, attendee_id, user_id, ticket_type, origin, custom_fields, accepted_terms, status,
            consent_accepted, consent_accepted_at, consent_ip, consent_user_agent,
            consent_text_hash, consent_policy_version)
         VALUES ($1,$2,$3,'rueda','web_form',$4,TRUE,'confirmed',
                 TRUE, NOW(), $5, $6, $7, $8)
         ON CONFLICT (event_id, attendee_id) DO NOTHING
         RETURNING id, qr_token`,
        [event.id, attendee_id, event.user_id, JSON.stringify(customFields),
         consentIp, consentUa, consentHash, consentVersion]
      );
      if (!regRes.rows[0]) {
        const e = new Error('Esta empresa ya está inscrita en la rueda');
        e.httpStatus = 409; throw e;
      }
      const registration = regRes.rows[0];

      // Insert rn_delegates primario
      const delegateLocaleDb = locale;
      const delRes = await client.query(
        `INSERT INTO events.rn_delegates
           (registration_id, full_name, email, phone, role_title, is_primary, can_manage_team, accepted_at, locale)
         VALUES ($1,$2,$3,$4,$5,TRUE,TRUE,NOW(),$6)
         RETURNING id, agenda_token`,
        [registration.id, delegateName, cleanEmail, delegate.phone || null, delegate.role_title || null, delegateLocaleDb]
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
    // E-RN-9 Opción C: delegate.locale → event.default_locale → 'es'
    const emailLocale = locale || event.default_locale || 'es';
    sendRnWelcomeEmail({
      to: cleanEmail,
      delegateName,
      companyName,
      eventName: event.name,
      eventSlug: event.slug,
      agendaUrl: url,
      locale: emailLocale,
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
    // E-RN-9: nuevo delegado aún sin locale → fallback event.default_locale → 'es'
    const inviteLocale = ctx.event_default_locale || 'es';
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
      locale: inviteLocale,
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
    const { full_name, phone, role_title, locale: rawLocale } = req.body || {};
    // E-RN-9: normalize + validate locale ('pt-BR' → 'pt'; else must be es|en|pt or ignored)
    let localeDb = null;
    if (rawLocale != null) {
      const s = String(rawLocale).toLowerCase();
      if (s === 'pt-br' || s === 'pt') localeDb = 'pt';
      else if (s === 'es' || s === 'en') localeDb = s;
    }
    const r = await pool.query(
      `UPDATE events.rn_delegates
          SET full_name   = COALESCE($1, full_name),
              phone       = COALESCE($2, phone),
              role_title  = COALESCE($3, role_title),
              locale      = COALESCE($5, locale),
              accepted_at = COALESCE(accepted_at, NOW())
        WHERE id = $4
        RETURNING id, full_name, email, phone, role_title, is_primary, accepted_at, locale`,
      [full_name || null, phone || null, role_title || null, ctx.delegate_id, localeDb]
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
        locale: ctx.delegate_locale,
        visible_in_directory: ctx.visible_in_directory !== false,
      },
      event: {
        name: ctx.event_name,
        slug: ctx.event_slug,
        timezone: ctx.event_timezone,
        status: ctx.event_status,
        default_locale: ctx.event_default_locale,
      },
    });
  } catch (err) { handleError(res, err, 'GET /me'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// S211t B.1 · "Mis tags" post-registro
// GET /api/rn/public/delegates/me/tags?token=<agenda_token>
// PUT /api/rn/public/delegates/me/tags?token=<agenda_token>  body: { offer:[], demand:[] }
// Solo el delegado primario puede editar los tags de la empresa.
// ──────────────────────────────────────────────────────────────────────────────
router.get('/delegates/me/tags', rnReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    const mm = (ctx.event_config || {}).matchmaking || {};
    const matchingMode = mm.matching_mode || (ctx.event_config || {}).matching_mode || 'tags';
    const { rows: available } = await pool.query(
      `SELECT id, slug, label, category FROM events.rn_tags
        WHERE user_id = $1 ORDER BY category NULLS LAST, label`,
      [ctx.user_id]
    );
    const { rows: mine } = await pool.query(
      `SELECT tag_id, kind FROM events.rn_registration_tags WHERE registration_id = $1`,
      [ctx.registration_id]
    );
    res.json({
      matching_mode: matchingMode,
      available,
      mine: {
        offer:  mine.filter(r => r.kind === 'offer').map(r => r.tag_id),
        demand: mine.filter(r => r.kind === 'demand').map(r => r.tag_id),
      },
      can_edit: !!ctx.is_primary,
    });
  } catch (err) { handleError(res, err, 'GET /me/tags'); }
});

router.put('/delegates/me/tags', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!ctx.is_primary) return res.status(403).json({ error: 'Solo el delegado primario puede editar tags' });
    const mm = (ctx.event_config || {}).matchmaking || {};
    const matchingMode = mm.matching_mode || (ctx.event_config || {}).matching_mode || 'tags';
    if (matchingMode === 'manual_only') return res.status(400).json({ error: 'Esta rueda no usa tags' });

    const { offer = [], demand = [] } = req.body || {};
    const offerIds  = Array.isArray(offer)  ? offer.filter(x => UUID_RE.test(String(x)))  : [];
    const demandIds = Array.isArray(demand) ? demand.filter(x => UUID_RE.test(String(x))) : [];
    const allIds = [...new Set([...offerIds, ...demandIds])];

    let validOffer = [], validDemand = [];
    if (allIds.length) {
      const chk = await pool.query(
        `SELECT id FROM events.rn_tags WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [ctx.user_id, allIds]
      );
      const ok = new Set(chk.rows.map(r => r.id));
      validOffer  = offerIds.filter(id => ok.has(id));
      validDemand = demandIds.filter(id => ok.has(id));
    }

    await withTransaction(pool, async (client) => {
      await client.query(`DELETE FROM events.rn_registration_tags WHERE registration_id = $1`, [ctx.registration_id]);
      for (const tagId of validOffer) {
        await client.query(
          `INSERT INTO events.rn_registration_tags (registration_id, tag_id, kind) VALUES ($1,$2,'offer')`,
          [ctx.registration_id, tagId]
        );
      }
      for (const tagId of validDemand) {
        await client.query(
          `INSERT INTO events.rn_registration_tags (registration_id, tag_id, kind) VALUES ($1,$2,'demand')`,
          [ctx.registration_id, tagId]
        );
      }
    });

    global.io?.to(`event_${ctx.event_id}`).emit('rn.tags_updated', {
      user_id: ctx.user_id, event_id: ctx.event_id, registration_id: ctx.registration_id,
    });

    console.log(`[rn-public] tags updated event=${ctx.event_slug} delegate=${ctx.delegate_email} offer=${validOffer.length} demand=${validDemand.length}`);
    res.json({ ok: true, offer: validOffer, demand: validDemand });
  } catch (err) { handleError(res, err, 'PUT /me/tags'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// S211w · Visibility en directorio público (modo privado — ≠ opt_out)
// PATCH /api/rn/public/delegates/me/visibility?token=<agenda_token>  body: { visible:boolean }
// Solo delegado primario. Oculta a la empresa del listado /directory sin cancelar registro.
// ──────────────────────────────────────────────────────────────────────────────
router.patch('/delegates/me/visibility', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!ctx.is_primary) return res.status(403).json({ error: 'Solo el delegado primario puede cambiar la visibilidad' });
    const visible = !!(req.body && req.body.visible);
    await pool.query(
      `UPDATE events.rn_delegates
          SET visible_in_directory = $1
        WHERE registration_id = $2 AND is_primary = TRUE`,
      [visible, ctx.registration_id]
    );
    try {
      const io = global.io;
      if (io) io.to(`event_${ctx.event_id}`).emit('rn.visibility_updated', {
        registration_id: ctx.registration_id, visible,
      });
    } catch(_){}
    console.log(`[rn-public] visibility event=${ctx.event_slug} reg=${ctx.registration_id} visible=${visible}`);
    res.json({ ok: true, visible });
  } catch (err) { handleError(res, err, 'PATCH /me/visibility'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// S211t B.1 · ARCO-O · opt-out matchmaking (sin borrar registro)
// POST /api/rn/public/delegates/me/opt-out?token=<agenda_token>  body: { reason? }
// ──────────────────────────────────────────────────────────────────────────────
router.post('/delegates/me/opt-out', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    const reason = (req.body && typeof req.body.reason === 'string')
      ? req.body.reason.slice(0, 200) : null;
    await pool.query(
      `UPDATE events.rn_delegates
          SET opt_out = TRUE, opt_out_at = NOW(), opt_out_reason = $1
        WHERE id = $2`,
      [reason, ctx.delegate_id]
    );
    console.log(`[rn-public] opt-out event=${ctx.event_slug} delegate=${ctx.delegate_email}`);
    res.json({ ok: true });
  } catch (err) { handleError(res, err, 'POST /me/opt-out'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-2 · Público — tags del tenant (para el formulario de inscripción)
// GET /api/rn/public/:eventSlug/tags → lista tags disponibles del productor
// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────
// S211t B.1 · GET /api/rn/public/:eventSlug
// Metadata pública mínima para renderizar la landing de registro.
// Nunca expone emails/PII/tokens — solo datos del evento + organizador legal.
// ──────────────────────────────────────────────────────────────────────────────
const RESERVED_SLUGS = new Set(['meetings','requests','report','delegates','directory','callboard','tags']);
router.get('/:eventSlug', rnReadLimiter, async (req, res, next) => {
  if (RESERVED_SLUGS.has(req.params.eventSlug)) return next();
  const pool = global.pool;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, status, timezone, starts_at, ends_at, venue_name, venue_address,
              config,
              organizer_legal_name, organizer_country,
              privacy_policy_source, privacy_policy_url, privacy_policy_version
         FROM events.events
        WHERE slug = $1 AND status IN ('published','live')`,
      [req.params.eventSlug]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rueda no encontrada' });
    const ev = rows[0];
    const cfg = ev.config || {};
    if (cfg.event_type !== 'matchmaking') {
      return res.status(400).json({ error: 'Este evento no es una rueda de negocios' });
    }
    const mm = cfg.matchmaking || {};
    const vis = mm.visibility || cfg.visibility || 'public';
    const matching_mode = mm.matching_mode || cfg.matching_mode || 'tags';
    const defaultPrivacyUrl = `${(process.env.CMS_URL || '').replace(/\/$/, '')}/legal/privacidad-events.html`;
    res.json({
      event: {
        id: ev.id,
        name: ev.name,
        slug: ev.slug,
        timezone: ev.timezone,
        starts_at: ev.starts_at,
        ends_at: ev.ends_at,
        venue_name: ev.venue_name,
        venue_address: ev.venue_address,
        languages: cfg.languages || ['es'],
        max_capacity: cfg.max_capacity || null,
        registration_open: cfg.registration_open !== false,
        matchmaking: { visibility: vis, matching_mode },
      },
      organizer: {
        legal_name: ev.organizer_legal_name || null,
        country: ev.organizer_country || 'CO',
      },
      privacy: {
        source: ev.privacy_policy_source || 'sonoro_template',
        url: ev.privacy_policy_url || defaultPrivacyUrl,
        version: ev.privacy_policy_version || '1.0',
      },
    });
  } catch (err) { handleError(res, err, 'GET event info'); }
});

router.get('/:eventSlug/tags', rnReadLimiter, async (req, res, next) => {
  if (RESERVED_SLUGS.has(req.params.eventSlug)) return next();
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

    // Sentinel UUID para que PG pueda inferir uuid[] cuando mi perfil no tiene tags.
    const NIL_UUID = '00000000-0000-0000-0000-000000000000';
    const myDemandP = myDemand.length ? myDemand : [NIL_UUID];
    const myOfferP  = myOffer.length  ? myOffer  : [NIL_UUID];
    const params = [ctx.event_id, myDemandP, myOfferP];
    let where = `r.event_id = $1 AND r.id <> $4 AND r.status != 'cancelled'`;
    params.push(ctx.registration_id);

    // visibility='mixed' → solo quienes marcaron rn_visibility='public'
    if (eventVis === 'mixed') {
      where += ` AND (r.custom_fields->>'rn_visibility') = 'public'`;
    }

    // S211w — Visibility: ocultar empresas cuyo delegado primario marcó visible_in_directory=FALSE
    where += ` AND EXISTS (
      SELECT 1 FROM events.rn_delegates d
      WHERE d.registration_id = r.id
        AND d.is_primary = TRUE
        AND d.visible_in_directory = TRUE
    )`;

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

    // Cast tautológico fuerza inferencia de tipos uuid[] para $2/$3 cuando no se referencian abajo (view='all').
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM events.registrations r
         WHERE ${where} AND ($2::uuid[] IS NOT NULL) AND ($3::uuid[] IS NOT NULL)`,
      params
    );
    const total = countRes.rows[0].c;

    const orderBy = `score DESC NULLS LAST, LOWER(COALESCE(r.custom_fields->>'company_name', a.organization, a.name)) ASC`;

    const offset = (page - 1) * PAGE_SIZE;
    params.push(PAGE_SIZE); params.push(offset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const listRes = await pool.query(
      `SELECT r.id,
              COALESCE(r.custom_fields->>'company_name', a.organization, a.name) AS company_name,
              r.custom_fields->>'pitch'        AS pitch,
              r.custom_fields->>'website'      AS website,
              ${scoreSelect}
         FROM events.registrations r
         JOIN events.attendees a ON a.id = r.attendee_id
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
      `SELECT full_name, email, agenda_token, locale FROM events.rn_delegates
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
        // E-RN-9 Opción C: delegate → event.default_locale → 'es'
        const recvLocale = primary.rows[0].locale || ctx.event_default_locale || 'es';
        sendRnRequestReceivedEmail({
          to: primary.rows[0].email,
          delegateName: primary.rows[0].full_name,
          fromCompanyName: fromCompanyRow.rows[0]?.c || '',
          eventName: ctx.event_name,
          agendaUrl: agendaUrl(req, primary.rows[0].agenda_token),
          message: message || null,
          locale: recvLocale,
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
      `SELECT d.email, d.full_name, d.agenda_token, d.locale,
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
      // E-RN-9 Opción C: delegate → event.default_locale → 'es'
      const respLocale = fromPrim.rows[0].locale || ctx.event_default_locale || 'es';
      const payload = {
        to: fromPrim.rows[0].email,
        delegateName: fromPrim.rows[0].full_name,
        targetCompanyName: fromPrim.rows[0].to_company || '',
        eventName: ctx.event_name,
        agendaUrl: agendaUrl(req, fromPrim.rows[0].agenda_token),
        locale: respLocale,
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
              COALESCE(r.custom_fields->>'company_name', a.organization, a.name) AS other_company
         FROM events.rn_meeting_requests q
         JOIN events.registrations r ON r.id = q.${otherCol}
         JOIN events.attendees a ON a.id = r.attendee_id
        WHERE q.${sideCol} = $1 AND q.event_id = $2
        ORDER BY q.created_at DESC`,
      [ctx.registration_id, ctx.event_id]
    );
    res.json({ direction, requests: rows });
  } catch (err) { handleError(res, err, 'GET requests'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-4 — Callboard público
// GET /api/rn/public/callboard/:eventSlug           Modo Clásico (todas las mesas)
// GET /api/rn/public/callboard/:eventSlug/:zoneSlug Modo Zonificado (filtra por zona)
//
// Devuelve estado para render fullscreen:
//   { event: {name,slug,status,timezone}, mode: 'classic'|'zoned',
//     zone?: {slug,name,color_hex,venue_label},
//     round: { current, next, total_estimated, timer: {starts_at, ends_at, now} },
//     meetings: [{ table_label, company_a, company_b, status }],
//     empty_tables: [table_label] }
//
// Framework §6.3 — WebSocket (sala `event_rueda_callboard_<eventId>_<zoneSlug?>`)
// se despliega en E-RN-5 junto con timer runtime; v1 el cliente puede hacer polling.
// ──────────────────────────────────────────────────────────────────────────────
router.get('/callboard/:eventSlug/:zoneSlug?', rnReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ev = await pool.query(
      `SELECT id, user_id, name, slug, status, config, timezone
         FROM events.events
        WHERE slug = $1`,
      [req.params.eventSlug]
    );
    if (ev.rowCount === 0) return res.status(404).json({ error: 'Evento no encontrado' });
    const event = ev.rows[0];
    const cfg = event.config || {};
    if ((cfg.event_type) !== 'matchmaking') {
      return res.status(400).json({ error: 'Evento no es rueda de negocios' });
    }

    const mode = (cfg.matchmaking && cfg.matchmaking.mode) || 'classic';
    let zone = null;
    if (req.params.zoneSlug) {
      const zq = await pool.query(
        `SELECT id, slug, name, venue_label, color_hex
           FROM events.rn_zones
          WHERE event_id = $1 AND slug = $2`,
        [event.id, req.params.zoneSlug]
      );
      if (zq.rowCount === 0) return res.status(404).json({ error: 'Zona no encontrada' });
      zone = zq.rows[0];
    }

    // Rondas (filtra 'meeting' kind). current = una ronda ongoing (now ∈ [starts_at, ends_at)),
    // o si ninguna, la próxima que arranque.
    const rounds = (await pool.query(
      `SELECT id, round_number, starts_at, ends_at, kind, label
         FROM events.rn_rounds
        WHERE event_id = $1
        ORDER BY round_number`,
      [event.id]
    )).rows;
    const now = new Date();
    let current = null, next = null;
    for (const r of rounds) {
      const starts = new Date(r.starts_at), ends = new Date(r.ends_at);
      if (now >= starts && now < ends) { current = r; }
      else if (now < starts && !next) { next = r; }
      if (current && next) break;
    }
    const totalEstimated = (cfg.matchmaking && cfg.matchmaking.total_rounds_estimated) || rounds.length;

    // Mesas (opcionalmente filtradas por zona)
    const tablesQ = zone
      ? await pool.query(
          `SELECT id, label, zone_id FROM events.rn_tables
            WHERE event_id = $1 AND zone_id = $2 AND active = TRUE
            ORDER BY display_order, label`,
          [event.id, zone.id])
      : await pool.query(
          `SELECT id, label, zone_id FROM events.rn_tables
            WHERE event_id = $1 AND active = TRUE
            ORDER BY display_order, label`,
          [event.id]);
    const tables = tablesQ.rows;

    // Meetings de la ronda current (si existe)
    let meetings = [];
    if (current) {
      const meetingsQ = await pool.query(
        `SELECT m.id, m.table_id, m.status,
                t.label AS table_label,
                ra.custom_fields->>'company_name' AS company_a,
                rb.custom_fields->>'company_name' AS company_b
           FROM events.rn_meetings m
           JOIN events.rn_tables t          ON t.id = m.table_id
           JOIN events.registrations ra     ON ra.id = m.company_a_id
           JOIN events.registrations rb     ON rb.id = m.company_b_id
          WHERE m.event_id = $1
            AND m.round_id = $2
            AND m.table_id = ANY($3::uuid[])`,
        [event.id, current.id, tables.map(t => t.id)]
      );
      meetings = meetingsQ.rows.map(r => ({
        table_label: r.table_label,
        company_a: r.company_a || '—',
        company_b: r.company_b || '—',
        status: r.status,
      }));
    }
    const occupiedTables = new Set(meetings.map(m => m.table_label));
    const emptyTables = tables.filter(t => !occupiedTables.has(t.label)).map(t => t.label);

    res.json({
      event: {
        id: event.id,
        name: event.name,
        slug: event.slug,
        status: event.status,
        timezone: event.timezone,
      },
      mode,
      zone,
      round: {
        current: current ? { number: current.round_number, label: current.label } : null,
        next: next ? { number: next.round_number, starts_at: next.starts_at } : null,
        total_estimated: totalEstimated,
        timer: current ? {
          starts_at: current.starts_at,
          ends_at: current.ends_at,
          now: now.toISOString(),
        } : null,
      },
      meetings,
      empty_tables: emptyTables,
    });
  } catch (err) { handleError(res, err, 'GET callboard'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-11 — Mini KPI de la Rueda para el bloque de la vista producción del evento padre
// GET /api/rn/public/mini-kpi/:ruedaId
// Payload compacto: ronda actual, mesas activas, reuniones en curso, check-ins.
// Público (no requiere auth) porque la vista producción del padre lo consume vía
// public token también; el id de la rueda ya es UUID impredecible.
// ──────────────────────────────────────────────────────────────────────────────
router.get('/mini-kpi/:ruedaId', rnReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ev = await pool.query(
      `SELECT id, name, slug, status, timezone, config
         FROM events.events
        WHERE id = $1`,
      [req.params.ruedaId]
    );
    if (ev.rowCount === 0) return res.status(404).json({ error: 'Rueda no encontrada' });
    const event = ev.rows[0];
    if ((event.config || {}).event_type !== 'matchmaking') {
      return res.status(400).json({ error: 'Evento no es rueda de negocios' });
    }

    const rounds = (await pool.query(
      `SELECT id, round_number, starts_at, ends_at
         FROM events.rn_rounds
        WHERE event_id = $1
        ORDER BY round_number`,
      [event.id]
    )).rows;
    const now = new Date();
    let current = null;
    for (const r of rounds) {
      const s = new Date(r.starts_at), e = new Date(r.ends_at);
      if (now >= s && now < e) { current = r; break; }
    }
    const totalEstimated = (event.config?.matchmaking?.total_rounds_estimated) || rounds.length;

    const tablesQ = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE active = TRUE)::int AS total
         FROM events.rn_tables WHERE event_id = $1`,
      [event.id]
    );
    const totalTables = tablesQ.rows[0].total;

    let activeMeetings = 0, activeTables = 0;
    if (current) {
      const mq = await pool.query(
        `SELECT COUNT(*)::int AS active,
                COUNT(DISTINCT table_id)::int AS tables_in_use
           FROM events.rn_meetings
          WHERE event_id = $1 AND round_id = $2
            AND status IN ('scheduled','in_progress')`,
        [event.id, current.id]
      );
      activeMeetings = mq.rows[0].active;
      activeTables = mq.rows[0].tables_in_use;
    }

    const regQ = await pool.query(
      `SELECT COUNT(*)::int AS total FROM events.registrations WHERE event_id = $1 AND status = 'confirmed'`,
      [event.id]
    );
    const checkinQ = await pool.query(
      `SELECT COUNT(*)::int AS done FROM events.rn_checkins WHERE event_id = $1`,
      [event.id]
    );

    res.json({
      event: { id: event.id, name: event.name, slug: event.slug, status: event.status },
      round: current
        ? { number: current.round_number, total: totalEstimated,
            starts_at: current.starts_at, ends_at: current.ends_at }
        : { number: null, total: totalEstimated, starts_at: null, ends_at: null },
      tables: { active: activeTables, total: totalTables },
      meetings: { in_progress: activeMeetings },
      checkins: { done: checkinQ.rows[0].done, total: regQ.rows[0].total },
      server_time: now.toISOString(),
    });
  } catch (err) { handleError(res, err, 'GET mini-kpi'); }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-5 — Runtime: check-in · start/end meeting · EBV capture (D-RN-15)
// ──────────────────────────────────────────────────────────────────────────────

// POST /checkin?token=<agenda_token>
// Marca al delegado como presente en el evento (idempotente por UNIQUE).
router.post('/checkin', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    const method = ['self','staff','qr','admin'].includes(req.body?.method) ? req.body.method : 'self';
    const r = await pool.query(
      `INSERT INTO events.rn_checkins (event_id, delegate_id, method)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id, delegate_id) DO UPDATE SET method = EXCLUDED.method
       RETURNING id, checked_in_at, method`,
      [ctx.event_id, ctx.delegate_id, method]
    );
    global.io?.to(`event_rueda_${ctx.event_id}`).emit('rn.checkin', {
      delegate_id: ctx.delegate_id, at: r.rows[0].checked_in_at,
    });
    res.json(r.rows[0]);
  } catch (err) { handleError(res, err, 'POST checkin'); }
});

// Helper: valida que el delegado tiene registration en la reunión
async function assertMeetingDelegate(pool, meetingId, delegateId) {
  const { rows } = await pool.query(
    `SELECT m.id, m.event_id, m.round_id, m.table_id, m.company_a_id, m.company_b_id,
            m.status, m.origin, d.registration_id AS my_reg
       FROM events.rn_meetings m
       JOIN events.rn_delegates d ON d.id = $2
      WHERE m.id = $1`,
    [meetingId, delegateId]
  );
  if (!rows[0]) {
    const e = new Error('Reunión no encontrada'); e.httpStatus = 404; throw e;
  }
  const m = rows[0];
  const myReg = m.my_reg;
  const isA = myReg === m.company_a_id;
  const isB = myReg === m.company_b_id;
  if (!isA && !isB) {
    const e = new Error('No eres parte de esta reunión'); e.httpStatus = 403; throw e;
  }
  return { meeting: m, side: isA ? 'a' : 'b' };
}

// POST /meetings/:id/start?token=<agenda_token>
// ──────────────────────────────────────────────────────────────────────────────
// S211t B.1 · GET /api/rn/public/meetings?token=<agenda_token>
// Agenda personal del delegado — reuniones (scheduled|active|completed) donde
// mi company es A o B, con horario (round) + mesa + contraparte.
// ──────────────────────────────────────────────────────────────────────────────
router.get('/meetings', rnReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    const { rows } = await pool.query(
      `SELECT m.id, m.status, m.origin, m.locked,
              m.started_at, m.ended_at, m.tag_overlap_score,
              r.round_number, r.starts_at AS round_starts_at, r.ends_at AS round_ends_at, r.kind AS round_kind, r.label AS round_label,
              t.label AS table_label,
              CASE WHEN m.company_a_id = $1 THEN 'a' ELSE 'b' END AS my_side,
              CASE WHEN m.company_a_id = $1 THEN m.company_b_id ELSE m.company_a_id END AS other_registration_id,
              CASE WHEN m.company_a_id = $1
                   THEN COALESCE(rb.custom_fields->>'company_name', ab.organization, ab.name)
                   ELSE COALESCE(ra.custom_fields->>'company_name', aa.organization, aa.name) END AS other_company,
              CASE WHEN m.company_a_id = $1
                   THEN rb.custom_fields->>'pitch'
                   ELSE ra.custom_fields->>'pitch' END AS other_pitch,
              CASE WHEN m.company_a_id = $1 THEN m.notes_a               ELSE m.notes_b               END AS my_notes,
              CASE WHEN m.company_a_id = $1 THEN m.expected_value_a_amount   ELSE m.expected_value_b_amount   END AS my_ebv_amount,
              CASE WHEN m.company_a_id = $1 THEN m.expected_value_a_currency ELSE m.expected_value_b_currency END AS my_ebv_currency,
              CASE WHEN m.company_a_id = $1 THEN m.expected_value_a_horizon  ELSE m.expected_value_b_horizon  END AS my_ebv_horizon
         FROM events.rn_meetings m
         JOIN events.rn_rounds r         ON r.id = m.round_id
         JOIN events.rn_tables t         ON t.id = m.table_id
         JOIN events.registrations ra    ON ra.id = m.company_a_id
         JOIN events.registrations rb    ON rb.id = m.company_b_id
         JOIN events.attendees aa        ON aa.id = ra.attendee_id
         JOIN events.attendees ab        ON ab.id = rb.attendee_id
        WHERE m.event_id = $2
          AND (m.company_a_id = $1 OR m.company_b_id = $1)
          AND m.status != 'cancelled'
        ORDER BY r.starts_at ASC, t.label ASC`,
      [ctx.registration_id, ctx.event_id]
    );
    res.json({
      event: { name: ctx.event_name, slug: ctx.event_slug, timezone: ctx.event_timezone },
      meetings: rows,
    });
  } catch (err) { handleError(res, err, 'GET meetings'); }
});

router.post('/meetings/:id/start', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    const { meeting } = await assertMeetingDelegate(pool, req.params.id, ctx.delegate_id);
    if (!['scheduled','active'].includes(meeting.status)) {
      return res.status(409).json({ error: `No puede iniciarse (status=${meeting.status})` });
    }
    const r = await pool.query(
      `UPDATE events.rn_meetings
          SET status = 'active',
              started_at = COALESCE(started_at, NOW()),
              initiated_by = COALESCE(initiated_by, $2)
        WHERE id = $1
        RETURNING id, status, started_at`,
      [req.params.id, ctx.registration_id]
    );
    global.io?.to(`event_rueda_${meeting.event_id}`).emit('rn.meeting.started', r.rows[0]);
    res.json(r.rows[0]);
  } catch (err) { handleError(res, err, 'POST meeting/start'); }
});

// POST /meetings/:id/end?token=<agenda_token>
router.post('/meetings/:id/end', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    const { meeting, side } = await assertMeetingDelegate(pool, req.params.id, ctx.delegate_id);
    if (meeting.status === 'completed') return res.json({ id: meeting.id, status: 'completed' });

    const notes = req.body?.notes ? String(req.body.notes).slice(0, 2000) : null;
    const notesCol = `notes_${side}`;
    const r = await pool.query(
      `UPDATE events.rn_meetings
          SET status = 'completed',
              ended_at = COALESCE(ended_at, NOW()),
              ${notesCol} = COALESCE($2, ${notesCol})
        WHERE id = $1
        RETURNING id, status, ended_at`,
      [req.params.id, notes]
    );
    global.io?.to(`event_rueda_${meeting.event_id}`).emit('rn.meeting.ended', r.rows[0]);
    res.json(r.rows[0]);
  } catch (err) { handleError(res, err, 'POST meeting/end'); }
});

// POST /meetings/:id/ebv?token=<agenda_token>  (D-RN-15)
// Guarda EBV en el lado del token (A o B). Nunca cross-lado. Editable hasta event.status='closed'.
router.post('/meetings/:id/ebv', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    if (ctx.event_status === 'closed') {
      return res.status(423).json({ error: 'Evento cerrado, EBV ya no editable' });
    }
    const amount   = parseFloat(req.body?.amount);
    const currency = (req.body?.currency || 'COP').toString().toUpperCase().slice(0, 3);
    const horizon  = ['short','long'].includes(req.body?.horizon) ? req.body.horizon : null;
    if (!isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'amount inválido' });
    }

    const { side } = await assertMeetingDelegate(pool, req.params.id, ctx.delegate_id);
    const amtCol = `expected_value_${side}_amount`;
    const curCol = `expected_value_${side}_currency`;
    const horCol = `expected_value_${side}_horizon`;
    const atCol  = `expected_value_${side}_at`;

    const r = await pool.query(
      `UPDATE events.rn_meetings
          SET ${amtCol} = $2, ${curCol} = $3, ${horCol} = $4, ${atCol} = NOW()
        WHERE id = $1
        RETURNING id, ${amtCol} AS amount, ${curCol} AS currency, ${horCol} AS horizon, ${atCol} AS at`,
      [req.params.id, amount, currency, horizon]
    );
    res.json({ side, ...r.rows[0] });
  } catch (err) { handleError(res, err, 'POST meeting/ebv'); }
});

// E-RN-6a · Reporte post-evento delegado (D-RN-9 + D-RN-15)
// Cifras propias del delegado + agregado anónimo del evento (sin desglose por empresa).
router.get('/report', rnReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    const regId = ctx.registration_id;
    const eventId = ctx.event_id;

    // Mis reuniones + EBV que yo (como lado A o B) escribí.
    // D-RN-15: nunca ve la contraparte — solo mi lado.
    const myMeetings = (await pool.query(
      `SELECT m.id,
              m.company_a_id,
              m.company_b_id,
              m.status,
              rd.round_number,
              t.label AS table_label,
              CASE WHEN m.company_a_id = $1 THEN m.expected_value_a_amount
                   WHEN m.company_b_id = $1 THEN m.expected_value_b_amount END AS my_amount,
              CASE WHEN m.company_a_id = $1 THEN m.expected_value_a_currency
                   WHEN m.company_b_id = $1 THEN m.expected_value_b_currency END AS my_currency,
              CASE WHEN m.company_a_id = $1 THEN m.expected_value_a_horizon
                   WHEN m.company_b_id = $1 THEN m.expected_value_b_horizon END AS my_horizon,
              CASE WHEN m.company_a_id = $1
                     THEN rb.custom_fields->>'company_name'
                     ELSE ra.custom_fields->>'company_name' END AS counterpart_company,
              CASE WHEN m.company_a_id = $1
                     THEN rb.id
                     ELSE ra.id END AS counterpart_registration_id
         FROM events.rn_meetings m
         JOIN events.rn_rounds rd ON rd.id = m.round_id
         JOIN events.rn_tables t  ON t.id  = m.table_id
         JOIN events.registrations ra ON ra.id = m.company_a_id
         JOIN events.registrations rb ON rb.id = m.company_b_id
        WHERE m.event_id = $2 AND (m.company_a_id = $1 OR m.company_b_id = $1)
        ORDER BY rd.round_number ASC`,
      [regId, eventId]
    )).rows;

    const myFilled = myMeetings.filter(r => r.my_amount != null);
    const myValues = myFilled.map(r => Number(r.my_amount)).sort((a, b) => a - b);
    const mySum    = myValues.reduce((s, v) => s + v, 0);
    const myAvg    = myValues.length ? mySum / myValues.length : null;

    // Agregado anónimo del evento (misma lógica que productor pero sin top ni nombres)
    const perMeeting = (await pool.query(
      `SELECT
         CASE
           WHEN m.expected_value_a_amount IS NOT NULL AND m.expected_value_b_amount IS NOT NULL
             THEN (m.expected_value_a_amount + m.expected_value_b_amount) / 2.0
           WHEN m.expected_value_a_amount IS NOT NULL THEN m.expected_value_a_amount
           WHEN m.expected_value_b_amount IS NOT NULL THEN m.expected_value_b_amount
         END AS meeting_value
       FROM events.rn_meetings m
       WHERE m.event_id = $1`,
      [eventId]
    )).rows;

    const total   = perMeeting.length;
    const withEbv = perMeeting.filter(r => r.meeting_value != null);
    const vals    = withEbv.map(r => Number(r.meeting_value)).sort((a, b) => a - b);
    const sum     = vals.reduce((s, v) => s + v, 0);
    const avg     = vals.length ? sum / vals.length : null;
    const median  = vals.length
      ? (vals.length % 2
          ? vals[(vals.length - 1) / 2]
          : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2)
      : null;
    const coverage = total > 0 ? withEbv.length / total : 0;

    res.json({
      event: {
        id: eventId,
        name: ctx.event_name,
        slug: ctx.event_slug,
        status: ctx.event_status,
      },
      me: {
        meetings_total: myMeetings.length,
        meetings_with_ebv: myFilled.length,
        sum: mySum || null,
        avg: myAvg,
        meetings: myMeetings.map(r => ({
          meeting_id: r.id,
          round: r.round_number,
          table_label: r.table_label,
          status: r.status,
          counterpart_company: r.counterpart_company,
          my_amount: r.my_amount != null ? Number(r.my_amount) : null,
          my_currency: r.my_currency,
          my_horizon: r.my_horizon,
        })),
      },
      event_aggregate_anonymous: {
        total_meetings: total,
        with_ebv: withEbv.length,
        total_estimated: sum || null,
        avg_per_meeting: avg,
        median_per_meeting: median,
        coverage,
        referential: coverage < 0.20,
      },
    });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('[rn-public] GET /report error:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// E-RN-10 · Expediente post-cita
// GET  /meetings/:id/outcome?token=<agenda_token>
// PUT  /meetings/:id/outcome?token=<agenda_token>  body:{result,next_step,owner_side?,due_at?,completed?,share_with_counterpart?,share_with_producer?}
// GET  /meetings/:id/feedback?token=<agenda_token>
// POST /meetings/:id/feedback?token=<agenda_token>  body:{dim_fit,dim_docs,dim_price,dim_capacity,dim_timing,dim_clarity,note?,visibility?}
// PATCH /delegates/me/comms-opt-out?token=<agenda_token>  body:{opt_out:boolean}
// Side ('A'/'B') se deriva de assertMeetingDelegate (lowercase → uppercase).
// Idempotencia: UNIQUE(meeting_id, side) permite upsert via ON CONFLICT.
// ──────────────────────────────────────────────────────────────────────────────

const RESULT_VALUES    = ['match','conditional','needs_info','no_match','no_show'];
const NEXT_STEP_VALUES = ['quote','sample','catalog','tech_spec','intro','second_meeting','pilot','none'];
const OWNER_VALUES     = ['A','B','both'];
const DIM_VALUES       = ['good','partial','poor','na'];
const VIS_VALUES       = ['counterpart','producer_only','both'];

router.get('/meetings/:id/outcome', rnReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    const { side: lcSide } = await assertMeetingDelegate(pool, req.params.id, ctx.delegate_id);
    const mySide = lcSide.toUpperCase();
    const otherSide = mySide === 'A' ? 'B' : 'A';

    const { rows } = await pool.query(
      `SELECT side, result, next_step, owner_side, due_at, completed_at,
              share_with_counterpart, share_with_producer, created_at, updated_at
         FROM events.rn_meeting_outcomes
        WHERE meeting_id = $1 AND side = ANY($2::varchar[])`,
      [req.params.id, [mySide, otherSide]]
    );
    const mine  = rows.find(r => r.side === mySide) || null;
    const otherRaw = rows.find(r => r.side === otherSide) || null;
    // Contraparte visible solo si marcó share_with_counterpart
    const other = otherRaw && otherRaw.share_with_counterpart ? {
      result: otherRaw.result,
      next_step: otherRaw.next_step,
      owner_side: otherRaw.owner_side,
      due_at: otherRaw.due_at,
      completed_at: otherRaw.completed_at,
      updated_at: otherRaw.updated_at,
    } : null;

    res.json({ meeting_id: req.params.id, my_side: mySide, mine, counterpart: other });
  } catch (err) { handleError(res, err, 'GET outcome'); }
});

router.put('/meetings/:id/outcome', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    const { meeting, side: lcSide } = await assertMeetingDelegate(pool, req.params.id, ctx.delegate_id);
    const mySide = lcSide.toUpperCase();

    const b = req.body || {};
    const result     = RESULT_VALUES.includes(b.result) ? b.result : null;
    const next_step  = NEXT_STEP_VALUES.includes(b.next_step) ? b.next_step : null;
    if (!result)     return res.status(400).json({ error: 'result inválido' });
    if (!next_step)  return res.status(400).json({ error: 'next_step inválido' });

    // no_match / no_show cierran ficha → forzamos next_step='none' + due null
    const closed = result === 'no_match' || result === 'no_show';
    const finalNext = closed ? 'none' : next_step;

    let owner = (b.owner_side != null && OWNER_VALUES.includes(String(b.owner_side).toUpperCase()))
      ? String(b.owner_side).toUpperCase() : null;
    if (closed || finalNext === 'none') owner = null;

    let due = null;
    if (!closed && finalNext !== 'none' && b.due_at) {
      const d = new Date(b.due_at);
      if (isFinite(d.getTime())) due = d.toISOString();
    }

    const completed = closed ? new Date().toISOString() : (b.completed === true ? new Date().toISOString() : null);
    const shareCp   = closed ? false : (b.share_with_counterpart === true);
    const shareProd = closed ? true  : (b.share_with_producer !== false);

    const r = await withTransaction(pool, async (client) => {
      const ins = await client.query(
        `INSERT INTO events.rn_meeting_outcomes
           (meeting_id, side, user_id, delegate_id, result, next_step, owner_side, due_at, completed_at,
            share_with_counterpart, share_with_producer, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (meeting_id, side) DO UPDATE SET
           result = EXCLUDED.result,
           next_step = EXCLUDED.next_step,
           owner_side = EXCLUDED.owner_side,
           due_at = EXCLUDED.due_at,
           completed_at = EXCLUDED.completed_at,
           share_with_counterpart = EXCLUDED.share_with_counterpart,
           share_with_producer = EXCLUDED.share_with_producer,
           updated_at = NOW()
         RETURNING id, side, result, next_step, owner_side, due_at, completed_at,
                   share_with_counterpart, share_with_producer, created_at, updated_at`,
        [req.params.id, mySide, ctx.user_id, ctx.delegate_id, result, finalNext, owner, due, completed, shareCp, shareProd]
      );
      return ins.rows[0];
    });

    global.io?.to(`event_rueda_${meeting.event_id}`).emit('rn.outcome.saved', {
      meeting_id: req.params.id, side: mySide, result, next_step: finalNext,
    });
    res.json(r);
  } catch (err) { handleError(res, err, 'PUT outcome'); }
});

router.get('/meetings/:id/feedback', rnReadLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    const { side: lcSide } = await assertMeetingDelegate(pool, req.params.id, ctx.delegate_id);
    const mySide = lcSide.toUpperCase();
    const otherSide = mySide === 'A' ? 'B' : 'A';

    const { rows } = await pool.query(
      `SELECT from_side, dim_fit, dim_docs, dim_price, dim_capacity, dim_timing, dim_clarity,
              note, visibility, created_at, updated_at
         FROM events.rn_meeting_feedback
        WHERE meeting_id = $1 AND from_side = ANY($2::varchar[])`,
      [req.params.id, [mySide, otherSide]]
    );
    const mine  = rows.find(r => r.from_side === mySide) || null;
    const otherRaw = rows.find(r => r.from_side === otherSide) || null;
    // Contraparte solo si visibility incluye 'counterpart' o 'both'
    const other = otherRaw && (otherRaw.visibility === 'counterpart' || otherRaw.visibility === 'both') ? {
      dim_fit: otherRaw.dim_fit, dim_docs: otherRaw.dim_docs, dim_price: otherRaw.dim_price,
      dim_capacity: otherRaw.dim_capacity, dim_timing: otherRaw.dim_timing, dim_clarity: otherRaw.dim_clarity,
      note: otherRaw.note, updated_at: otherRaw.updated_at,
    } : null;

    res.json({ meeting_id: req.params.id, my_side: mySide, mine, counterpart: other });
  } catch (err) { handleError(res, err, 'GET feedback'); }
});

router.post('/meetings/:id/feedback', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    const { side: lcSide } = await assertMeetingDelegate(pool, req.params.id, ctx.delegate_id);
    const mySide = lcSide.toUpperCase();

    const b = req.body || {};
    const dim = (k) => (DIM_VALUES.includes(b[k]) ? b[k] : null);
    const vals = {
      dim_fit:      dim('dim_fit'),
      dim_docs:     dim('dim_docs'),
      dim_price:    dim('dim_price'),
      dim_capacity: dim('dim_capacity'),
      dim_timing:   dim('dim_timing'),
      dim_clarity:  dim('dim_clarity'),
    };
    const note = b.note ? String(b.note).slice(0, 500) : null;
    const visibility = VIS_VALUES.includes(b.visibility) ? b.visibility : 'producer_only';

    const r = await pool.query(
      `INSERT INTO events.rn_meeting_feedback
         (meeting_id, from_side, user_id, delegate_id,
          dim_fit, dim_docs, dim_price, dim_capacity, dim_timing, dim_clarity,
          note, visibility, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (meeting_id, from_side) DO UPDATE SET
         dim_fit = EXCLUDED.dim_fit,
         dim_docs = EXCLUDED.dim_docs,
         dim_price = EXCLUDED.dim_price,
         dim_capacity = EXCLUDED.dim_capacity,
         dim_timing = EXCLUDED.dim_timing,
         dim_clarity = EXCLUDED.dim_clarity,
         note = EXCLUDED.note,
         visibility = EXCLUDED.visibility,
         updated_at = NOW()
       RETURNING id, from_side, dim_fit, dim_docs, dim_price, dim_capacity, dim_timing, dim_clarity,
                 note, visibility, created_at, updated_at`,
      [req.params.id, mySide, ctx.user_id, ctx.delegate_id,
       vals.dim_fit, vals.dim_docs, vals.dim_price, vals.dim_capacity, vals.dim_timing, vals.dim_clarity,
       note, visibility]
    );
    res.json(r.rows[0]);
  } catch (err) { handleError(res, err, 'POST feedback'); }
});

router.patch('/delegates/me/comms-opt-out', rnTokenMutationLimiter, async (req, res) => {
  const pool = global.pool;
  try {
    const ctx = await resolveToken(pool, req.query.token);
    const optOut = req.body?.opt_out === true;
    const r = await pool.query(
      `UPDATE events.rn_delegates
          SET comms_opt_out    = $2,
              comms_opt_out_at = CASE WHEN $2 THEN COALESCE(comms_opt_out_at, NOW()) ELSE NULL END
        WHERE id = $1
        RETURNING id, comms_opt_out, comms_opt_out_at`,
      [ctx.delegate_id, optOut]
    );
    res.json(r.rows[0]);
  } catch (err) { handleError(res, err, 'PATCH comms-opt-out'); }
});

module.exports = router;
