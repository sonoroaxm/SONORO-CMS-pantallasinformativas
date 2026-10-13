// routes/events-calendar.js — OAuth connect flow Google/Outlook para events.staff_catalog
// S209b-1: generate-link, connect-info, auth redirect, callbacks, list, delete.
// Sync de eventos externos y webhooks: S209b-2.

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const oauth   = require('../services/calendar-oauth');

function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
}

function redirectUriFor(provider) {
  return `${process.env.CMS_URL}/api/events/calendar/${provider}/callback`;
}

const SUCCESS_URL = () => `${process.env.CMS_URL}/calendar-connect-success/`;
const ERROR_URL   = (code) => `${process.env.CMS_URL}/calendar-connect-error/?error=${encodeURIComponent(code)}`;

// POST /api/events/calendar/staff/:catId/generate-link
// Body: { provider: 'google'|'outlook' } (default google)
// Devuelve URL one-shot (24h) para que el staff conecte su calendario.
router.post('/staff/:catId/generate-link', auth, async (req, res) => {
  const pool = global.pool;
  const catId = parseInt(req.params.catId, 10);
  if (!catId) return res.status(400).json({ error: 'catId inválido' });
  const provider = (req.body && req.body.provider === 'outlook') ? 'outlook' : 'google';

  try {
    const own = await pool.query(
      `SELECT id, user_id, name, email FROM events.staff_catalog
       WHERE id = $1 AND user_id = $2`,
      [catId, req.user.id]
    );
    if (!own.rowCount) return res.status(404).json({ error: 'Staff no encontrado' });

    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomBytes(8).toString('hex');
    await pool.query(
      `INSERT INTO events.calendar_connect_tokens
         (token, staff_catalog_id, user_id, provider, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours')`,
      [token, catId, req.user.id, provider]
    );
    res.json({ url: `${process.env.CMS_URL}/calendar-connect/?token=${token}`, token, provider });
  } catch (err) {
    console.error('❌ POST /api/events/calendar/staff/:catId/generate-link:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/events/calendar/connect-info/:token — info pública del staff para la landing
router.get('/connect-info/:token', async (req, res) => {
  const pool = global.pool;
  try {
    const { rows } = await pool.query(
      `SELECT sc.name AS staff_name, sc.email AS staff_email, cct.provider
       FROM events.calendar_connect_tokens cct
       JOIN events.staff_catalog sc ON sc.id = cct.staff_catalog_id
       WHERE cct.token = $1 AND cct.expires_at > NOW() AND cct.used_at IS NULL`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Link inválido o expirado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ GET /api/events/calendar/connect-info:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/events/calendar/connect-link/:token/auth — inicia OAuth (redirect al provider)
router.get('/connect-link/:token/auth', async (req, res) => {
  const pool = global.pool;
  try {
    const { rows } = await pool.query(
      `SELECT staff_catalog_id, user_id, provider FROM events.calendar_connect_tokens
       WHERE token = $1 AND expires_at > NOW() AND used_at IS NULL`,
      [req.params.token]
    );
    if (!rows.length) return res.redirect(ERROR_URL('link_invalido'));
    const { staff_catalog_id, user_id, provider } = rows[0];

    const state = crypto.randomUUID();
    oauth.putState(state, { staff_catalog_id, user_id, provider, connectToken: req.params.token });

    if (provider === 'outlook') {
      if (!process.env.AZURE_CLIENT_ID) return res.redirect(ERROR_URL('no_configurado'));
      return res.redirect(oauth.getOutlookAuthUrl({ state, redirectUri: redirectUriFor('outlook') }));
    }
    if (!process.env.GOOGLE_CLIENT_ID) return res.redirect(ERROR_URL('no_configurado'));
    res.redirect(oauth.getGoogleAuthUrl({ state, redirectUri: redirectUriFor('google') }));
  } catch (err) {
    console.error('❌ GET /api/events/calendar/connect-link/:token/auth:', err);
    res.redirect(ERROR_URL('server_error'));
  }
});

async function _persistIntegration({ pool, provider, stateData, tokens, calendar }) {
  const encKey = process.env.CALENDAR_TOKENS_ENCRYPTION_KEY;
  if (!encKey) throw new Error('CALENDAR_TOKENS_ENCRYPTION_KEY no configurado');
  const expiry = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;
  const defaultScope = provider === 'google' ? oauth.GOOGLE_SCOPE : oauth.OUTLOOK_SCOPE;

  await pool.query(
    `INSERT INTO events.calendar_integrations
       (staff_catalog_id, user_id, provider, calendar_id, connected_email,
        access_token, refresh_token, token_expiry, scope)
     VALUES ($1, $2, $3, $4, $5,
             pgp_sym_encrypt($6, $9),
             pgp_sym_encrypt($7, $9),
             $8, $10)
     ON CONFLICT (staff_catalog_id, provider) DO UPDATE SET
       calendar_id = EXCLUDED.calendar_id,
       connected_email = EXCLUDED.connected_email,
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_expiry = EXCLUDED.token_expiry,
       scope = EXCLUDED.scope,
       connected_at = NOW()`,
    [
      stateData.staff_catalog_id, stateData.user_id, provider,
      calendar.id, calendar.email,
      tokens.access_token, tokens.refresh_token || '',
      expiry, encKey, tokens.scope || defaultScope,
    ]
  );
  await pool.query(
    `UPDATE events.calendar_connect_tokens SET used_at = NOW() WHERE token = $1`,
    [stateData.connectToken]
  );
}

// GET /api/events/calendar/google/callback
router.get('/google/callback', async (req, res) => {
  const pool = global.pool;
  const { code, state, error } = req.query;
  if (error) {
    console.error('❌ events google OAuth error:', error);
    return res.redirect(ERROR_URL(String(error)));
  }
  const stateData = oauth.takeState(state);
  if (!stateData || stateData.provider !== 'google') return res.redirect(ERROR_URL('invalid_state'));

  try {
    const tokens   = await oauth.googleTokenExchange(code, redirectUriFor('google'));
    const calendar = await oauth.fetchGooglePrimaryCalendar(tokens.access_token);
    await _persistIntegration({ pool, provider: 'google', stateData, tokens, calendar });
    console.log(`✅ events.calendar.connected staff=${stateData.staff_catalog_id} provider=google cal=${calendar.id}`);
    res.redirect(SUCCESS_URL());
  } catch (err) {
    console.error('❌ GET /api/events/calendar/google/callback:', err);
    res.redirect(ERROR_URL('server_error'));
  }
});

// GET /api/events/calendar/outlook/callback
router.get('/outlook/callback', async (req, res) => {
  const pool = global.pool;
  const { code, state, error } = req.query;
  if (error) {
    console.error('❌ events outlook OAuth error:', error);
    return res.redirect(ERROR_URL(String(error)));
  }
  const stateData = oauth.takeState(state);
  if (!stateData || stateData.provider !== 'outlook') return res.redirect(ERROR_URL('invalid_state'));

  try {
    const tokens   = await oauth.outlookTokenExchange(code, redirectUriFor('outlook'));
    const calendar = await oauth.fetchOutlookPrimaryCalendar(tokens.access_token);
    await _persistIntegration({ pool, provider: 'outlook', stateData, tokens, calendar });
    console.log(`✅ events.calendar.connected staff=${stateData.staff_catalog_id} provider=outlook cal=${calendar.id}`);
    res.redirect(SUCCESS_URL());
  } catch (err) {
    console.error('❌ GET /api/events/calendar/outlook/callback:', err);
    res.redirect(ERROR_URL('server_error'));
  }
});

// GET /api/events/calendar/integrations — lista integraciones del tenant
// ?staff_catalog_id=N opcional. Nunca devuelve tokens.
router.get('/integrations', auth, async (req, res) => {
  const pool = global.pool;
  const staffId = req.query.staff_catalog_id ? parseInt(req.query.staff_catalog_id, 10) : null;
  try {
    const params = [req.user.id];
    let where = 'ci.user_id = $1';
    if (staffId) { params.push(staffId); where += ` AND ci.staff_catalog_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT ci.id, ci.staff_catalog_id, ci.provider, ci.calendar_id,
              ci.connected_email, ci.token_expiry, ci.connected_at,
              sc.name AS staff_name, sc.is_owner
       FROM events.calendar_integrations ci
       JOIN events.staff_catalog sc ON sc.id = ci.staff_catalog_id
       WHERE ${where}
       ORDER BY sc.is_owner DESC, sc.name ASC, ci.provider ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /api/events/calendar/integrations:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/events/calendar/integrations/:id — desconecta (revoca Google si aplica)
router.delete('/integrations/:id', auth, async (req, res) => {
  const pool = global.pool;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  try {
    const encKey = process.env.CALENDAR_TOKENS_ENCRYPTION_KEY;
    const row = await pool.query(
      `SELECT ci.id, ci.provider,
              pgp_sym_decrypt(ci.access_token, $1) AS at
       FROM events.calendar_integrations ci
       WHERE ci.id = $2 AND ci.user_id = $3`,
      [encKey, id, req.user.id]
    );
    if (!row.rowCount) return res.status(404).json({ error: 'Integración no encontrada' });
    const { provider, at } = row.rows[0];
    if (provider === 'google' && at) await oauth.googleRevokeToken(at);
    // Outlook subscription revoke → S209b-2 cuando esté la tabla watch_channels poblada
    await pool.query('DELETE FROM events.calendar_integrations WHERE id = $1', [id]);
    console.log(`✅ events.calendar.disconnected integration=${id} provider=${provider}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ DELETE /api/events/calendar/integrations/:id:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ══════════════════════════════════════════════════════════════
// S209b-2 — Push-side sync (CMS → Google/Outlook)
// ══════════════════════════════════════════════════════════════

// Fetch integration + refresh si expira en <5min. Devuelve { id, calendar_id, access_token } o null.
async function getFreshIntegration(pool, staffCatalogId, provider) {
  const encKey = process.env.CALENDAR_TOKENS_ENCRYPTION_KEY;
  if (!encKey) return null;
  const row = await pool.query(
    `SELECT id, calendar_id,
            pgp_sym_decrypt(access_token,  $2) AS access_token,
            pgp_sym_decrypt(refresh_token, $2) AS refresh_token,
            token_expiry
     FROM events.calendar_integrations
     WHERE staff_catalog_id = $1 AND provider = $3`,
    [staffCatalogId, encKey, provider]
  );
  if (!row.rowCount) return null;
  const ci = row.rows[0];
  if (ci.token_expiry && new Date(ci.token_expiry) < new Date(Date.now() + 5 * 60 * 1000)) {
    try {
      const refreshed = provider === 'google'
        ? await oauth.googleRefreshToken(ci.refresh_token)
        : await oauth.outlookRefreshToken(ci.refresh_token);
      const newExpiry = refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : null;
      await pool.query(
        `UPDATE events.calendar_integrations
           SET access_token = pgp_sym_encrypt($1, $3), token_expiry = $2
         WHERE staff_catalog_id = $4 AND provider = $5`,
        [refreshed.access_token, newExpiry, encKey, staffCatalogId, provider]
      );
      ci.access_token = refreshed.access_token;
    } catch (e) {
      console.error(`⚠️ events.cal refresh staff=${staffCatalogId} provider=${provider}:`, e.message);
      return null;
    }
  }
  return ci;
}

function _eventPayload(event) {
  const venue = [event.venue_name, event.venue_address].filter(Boolean).join(' · ');
  return {
    summary:     event.name,
    description: event.venue_name ? `${event.name}\n${venue}` : event.name,
    location:    venue || undefined,
    startISO:    new Date(event.starts_at).toISOString(),
    endISO:      new Date(event.ends_at).toISOString(),
    timezone:    event.timezone || 'America/Bogota',
  };
}

// Bootstrap: si publish=true y no hay rows en event_calendar_sync, auto-popular con integraciones del owner.
async function _bootstrapOwnerSync(pool, event) {
  const owner = await pool.query(
    `SELECT sc.id AS staff_catalog_id, ci.provider
     FROM events.staff_catalog sc
     JOIN events.calendar_integrations ci ON ci.staff_catalog_id = sc.id
     WHERE sc.user_id = $1 AND sc.is_owner = TRUE`,
    [event.user_id]
  );
  for (const r of owner.rows) {
    await pool.query(
      `INSERT INTO events.event_calendar_sync
         (event_id, staff_catalog_id, user_id, provider, external_event_id)
       VALUES ($1, $2, $3, $4, '')
       ON CONFLICT (event_id, staff_catalog_id, provider) DO NOTHING`,
      [event.id, r.staff_catalog_id, event.user_id, r.provider]
    );
  }
  return owner.rowCount;
}

// Sync un evento a todos los calendarios declarados en event_calendar_sync.
// Non-fatal: errores quedan en sync_error.
async function syncEventToCalendars(pool, event) {
  if (!event.publish_to_external_calendar) return { skipped: 'disabled' };

  // Bootstrap owner si está vacío
  const existing = await pool.query(
    `SELECT COUNT(*)::int AS n FROM events.event_calendar_sync WHERE event_id = $1`,
    [event.id]
  );
  if (existing.rows[0].n === 0) await _bootstrapOwnerSync(pool, event);

  const targets = await pool.query(
    `SELECT ecs.id, ecs.staff_catalog_id, ecs.provider, ecs.external_event_id
     FROM events.event_calendar_sync ecs
     WHERE ecs.event_id = $1`,
    [event.id]
  );
  const payload = _eventPayload(event);
  const results = [];
  for (const t of targets.rows) {
    try {
      const ci = await getFreshIntegration(pool, t.staff_catalog_id, t.provider);
      if (!ci) throw new Error('integration_missing_or_refresh_failed');
      let newExtId;
      if (t.provider === 'google') {
        newExtId = await oauth.googleUpsertEvent(ci.access_token, ci.calendar_id, payload, t.external_event_id || null);
      } else {
        newExtId = await oauth.outlookUpsertEvent(ci.access_token, payload, t.external_event_id || null);
      }
      await pool.query(
        `UPDATE events.event_calendar_sync
           SET external_event_id = $1, last_synced_at = NOW(), sync_error = NULL
         WHERE id = $2`,
        [newExtId, t.id]
      );
      results.push({ provider: t.provider, staff_catalog_id: t.staff_catalog_id, external_event_id: newExtId, ok: true });
      console.log(`✅ events.cal.upsert event=${event.id} staff=${t.staff_catalog_id} provider=${t.provider} ext=${newExtId}`);
    } catch (e) {
      await pool.query(
        `UPDATE events.event_calendar_sync SET sync_error = $1 WHERE id = $2`,
        [String(e.message || e).slice(0, 500), t.id]
      );
      results.push({ provider: t.provider, staff_catalog_id: t.staff_catalog_id, ok: false, error: e.message });
      console.error(`❌ events.cal.upsert event=${event.id} staff=${t.staff_catalog_id} provider=${t.provider}:`, e.message);
    }
  }
  return { results };
}

// Borra eventos externos (antes de CASCADE wipe cuando se borra el evento, o cuando publish se apaga).
async function deleteEventFromCalendars(pool, eventId, { purgeRows = true } = {}) {
  const targets = await pool.query(
    `SELECT ecs.id, ecs.staff_catalog_id, ecs.provider, ecs.external_event_id
     FROM events.event_calendar_sync ecs
     WHERE ecs.event_id = $1 AND ecs.external_event_id <> ''`,
    [eventId]
  );
  for (const t of targets.rows) {
    try {
      const ci = await getFreshIntegration(pool, t.staff_catalog_id, t.provider);
      if (!ci) continue;
      if (t.provider === 'google') {
        await oauth.googleDeleteEvent(ci.access_token, ci.calendar_id, t.external_event_id);
      } else {
        await oauth.outlookDeleteEvent(ci.access_token, t.external_event_id);
      }
      console.log(`✅ events.cal.delete event=${eventId} staff=${t.staff_catalog_id} provider=${t.provider}`);
    } catch (e) {
      console.error(`⚠️ events.cal.delete event=${eventId} staff=${t.staff_catalog_id}:`, e.message);
    }
  }
  if (purgeRows) {
    await pool.query(`DELETE FROM events.event_calendar_sync WHERE event_id = $1`, [eventId]);
  }
}

// POST /api/events/calendar/events/:eventId/resync — fuerza resync manual
router.post('/events/:eventId/resync', auth, async (req, res) => {
  const pool = global.pool;
  const isAdmin = req.user.role === 'admin';
  try {
    const { rows } = await pool.query(
      `SELECT * FROM events.events
       WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
      isAdmin ? [req.params.eventId] : [req.params.eventId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Evento no encontrado' });
    const result = await syncEventToCalendars(pool, rows[0]);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('❌ POST /api/events/calendar/events/:eventId/resync:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
module.exports.syncEventToCalendars    = syncEventToCalendars;
module.exports.deleteEventFromCalendars = deleteEventFromCalendars;
