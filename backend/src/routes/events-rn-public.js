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
const { sendRnWelcomeEmail, sendRnDelegateInvitedEmail } = require('../services/email');

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

    const customFields = {
      company_name: companyName,
      pitch: pitch ? String(pitch).trim().slice(0, 1000) : null,
      website: website ? String(website).trim().slice(0, 300) : null,
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

module.exports = router;
