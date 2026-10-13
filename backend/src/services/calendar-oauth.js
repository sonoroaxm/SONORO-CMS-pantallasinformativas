// services/calendar-oauth.js — helpers OAuth2 reusables Google/Outlook
// Scope-agnostic: no toca BD. El caller (Events / Queue) decide dónde guardar.
// P-5: timezone del evento siempre viene del caller, nunca hardcodeada.

const GOOGLE_SCOPE  = 'https://www.googleapis.com/auth/calendar.events';
const OUTLOOK_SCOPE = 'Calendars.ReadWrite offline_access User.Read';

// ── Google ───────────────────────────────────────────────────────────────────

function getGoogleAuthUrl({ state, redirectUri }) {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         GOOGLE_SCOPE,
    access_type:   'offline',
    prompt:        'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function googleTokenExchange(code, redirectUri) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  });
  if (!r.ok) throw new Error(`Google token exchange ${r.status}: ${await r.text()}`);
  return r.json();
}

async function googleRefreshToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  if (!r.ok) throw new Error(`Google refresh ${r.status}: ${await r.text()}`);
  return r.json();
}

async function googleRevokeToken(accessToken) {
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
    });
  } catch (e) {
    console.error('⚠️ googleRevokeToken (non-fatal):', e.message);
  }
}

// Devuelve { id, email } del calendario primario. Para 'primary' el id ES el email.
async function fetchGooglePrimaryCalendar(accessToken) {
  try {
    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.ok) {
      const d = await r.json();
      return { id: d.id || 'primary', email: d.id || null };
    }
  } catch (_) { /* non-fatal */ }
  return { id: 'primary', email: null };
}

// ── Outlook / Microsoft Graph ────────────────────────────────────────────────

function getOutlookAuthUrl({ state, redirectUri }) {
  const params = new URLSearchParams({
    client_id:     process.env.AZURE_CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         OUTLOOK_SCOPE,
    state,
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
}

async function outlookTokenExchange(code, redirectUri) {
  const r = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     process.env.AZURE_CLIENT_ID,
      client_secret: process.env.AZURE_CLIENT_SECRET,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  });
  if (!r.ok) throw new Error(`Outlook token exchange ${r.status}: ${await r.text()}`);
  return r.json();
}

async function outlookRefreshToken(refreshToken) {
  const r = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.AZURE_CLIENT_ID,
      client_secret: process.env.AZURE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  if (!r.ok) throw new Error(`Outlook refresh ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchOutlookPrimaryCalendar(accessToken) {
  let id = 'primary', email = null;
  try {
    const r = await fetch(
      'https://graph.microsoft.com/v1.0/me/calendars?$top=1&$filter=isDefaultCalendar eq true',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (r.ok) {
      const d = await r.json();
      if (d.value && d.value[0]) id = d.value[0].id || 'primary';
    }
  } catch (_) { /* non-fatal */ }
  try {
    const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.ok) {
      const d = await r.json();
      email = d.mail || d.userPrincipalName || null;
    }
  } catch (_) { /* non-fatal */ }
  return { id, email };
}

// ── Event upsert / delete ────────────────────────────────────────────────────
// Body shape (provider-neutral):
//   { summary, description, location, startISO, endISO, timezone }
// startISO/endISO = UTC ISO. timezone = IANA (ej. 'America/Bogota').

// Convierte un Date → "YYYY-MM-DDTHH:mm:ss" en la IANA tz dada (sin offset).
function _toLocalNaive(date, timezone) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).forEach(({ type, value }) => { parts[type] = value; });
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}`;
}

async function googleUpsertEvent(accessToken, calendarId, body, externalEventId) {
  const calId = encodeURIComponent(calendarId || 'primary');
  const payload = {
    summary:     body.summary || 'Evento',
    description: body.description || '',
    location:    body.location || undefined,
    start: { dateTime: new Date(body.startISO).toISOString(), timeZone: body.timezone || 'UTC' },
    end:   { dateTime: new Date(body.endISO).toISOString(),   timeZone: body.timezone || 'UTC' },
  };
  const method = externalEventId ? 'PUT' : 'POST';
  const url = externalEventId
    ? `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(externalEventId)}`
    : `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`google.upsert ${r.status}: ${await r.text()}`);
  const ev = await r.json();
  return ev.id;
}

async function googleDeleteEvent(accessToken, calendarId, externalEventId) {
  if (!externalEventId) return;
  const calId = encodeURIComponent(calendarId || 'primary');
  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(externalEventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!r.ok && r.status !== 404 && r.status !== 410) {
    throw new Error(`google.delete ${r.status}: ${await r.text()}`);
  }
}

async function outlookUpsertEvent(accessToken, body, externalEventId) {
  const tz = body.timezone || 'UTC';
  const payload = {
    subject: body.summary || 'Evento',
    body:    { contentType: 'text', content: body.description || '' },
    start:   { dateTime: _toLocalNaive(new Date(body.startISO), tz), timeZone: tz },
    end:     { dateTime: _toLocalNaive(new Date(body.endISO), tz),   timeZone: tz },
    location: body.location ? { displayName: body.location } : undefined,
  };
  const method = externalEventId ? 'PATCH' : 'POST';
  const url = externalEventId
    ? `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(externalEventId)}`
    : 'https://graph.microsoft.com/v1.0/me/events';
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`outlook.upsert ${r.status}: ${await r.text()}`);
  if (method === 'PATCH') return externalEventId;
  const ev = await r.json();
  return ev.id;
}

async function outlookDeleteEvent(accessToken, externalEventId) {
  if (!externalEventId) return;
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(externalEventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!r.ok && r.status !== 404 && r.status !== 410) {
    throw new Error(`outlook.delete ${r.status}: ${await r.text()}`);
  }
}

// ── OAuth state cache (in-memory, 10 min TTL) ────────────────────────────────

const _states = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _states) if (now - v.createdAt > 10 * 60 * 1000) _states.delete(k);
}, 60 * 1000).unref?.();

function putState(state, data) { _states.set(state, { ...data, createdAt: Date.now() }); }
function takeState(state)      { const d = _states.get(state); if (d) _states.delete(state); return d; }

module.exports = {
  GOOGLE_SCOPE,
  OUTLOOK_SCOPE,
  getGoogleAuthUrl,
  googleTokenExchange,
  googleRefreshToken,
  googleRevokeToken,
  fetchGooglePrimaryCalendar,
  getOutlookAuthUrl,
  outlookTokenExchange,
  outlookRefreshToken,
  fetchOutlookPrimaryCalendar,
  googleUpsertEvent,
  googleDeleteEvent,
  outlookUpsertEvent,
  outlookDeleteEvent,
  putState,
  takeState,
};
