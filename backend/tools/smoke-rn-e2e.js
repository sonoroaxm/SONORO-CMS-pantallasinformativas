// Smoke E2E Rueda de Negocios v1 — valida E-RN-1b..E-RN-5
// Levanta Express mínimo + siembra evento sintético + dispara endpoints + verifica BD.
'use strict';

process.env.JWT_SECRET = 'smoke-rn-secret';
process.env.SMTP_HOST = ''; // deshabilita email real
process.env.CMS_URL   = 'http://localhost:5099';

const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const http = require('http');
const path = require('path');

const pool = new Pool({
  host: 'localhost', port: 5433, database: 'cms_signage_rntest',
  user: 'postgres', password: 'smarttv_dev', max: 5,
});
global.pool = pool;
global.io = { to: () => ({ emit: (ev, p) => console.log(`  [io] emit ${ev}`, JSON.stringify(p).slice(0, 100)) }) };

// Stub email (evita envío real)
require.cache[require.resolve('../src/services/email.js')] = {
  exports: new Proxy({}, { get: () => async () => ({ ok: true, stubbed: true }) }),
};

const rnPublic = require('../src/routes/events-rn-public');
const rnPrivate = require('../src/routes/events-rn');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/rn/public', rnPublic);
app.use('/api/rn', rnPrivate);

const PORT = 5099;
let server;

const USER_ID = 1;
const JWT_TOKEN = jwt.sign({ id: USER_ID, email: 'productor@test' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let eventId, eventSlug = 'smoke-rn-e2e';
let reg1Id, reg2Id;
let del1Id, del1Token, del2Id, del2Token;
let roundId, tableId;
let meetingId;

async function seed() {
  await pool.query(`DELETE FROM events.events WHERE slug = $1`, [eventSlug]);
  await pool.query(`DELETE FROM events.attendees WHERE email IN ('empresa-a@test','empresa-b@test')`);
  const ev = await pool.query(
    `INSERT INTO events.events (user_id, name, slug, status, timezone, starts_at, ends_at, config)
       VALUES ($1,'Smoke RN E2E',$2,'live','America/Bogota', NOW(), NOW() + INTERVAL '1 day',
         '{"event_type":"matchmaking","matchmaking":{"matching_mode":"tags","visibility":"all","default_tag_overlap_threshold":0.25}}'::jsonb)
       RETURNING id`,
    [USER_ID, eventSlug]
  );
  eventId = ev.rows[0].id;

  const a1 = await pool.query(
    `INSERT INTO events.attendees (user_id, email, name, organization) VALUES ($1,'empresa-a@test','Alice','Empresa A') RETURNING id`, [USER_ID]
  );
  const a2 = await pool.query(
    `INSERT INTO events.attendees (user_id, email, name, organization) VALUES ($1,'empresa-b@test','Bob','Empresa B') RETURNING id`, [USER_ID]
  );
  const r1 = await pool.query(
    `INSERT INTO events.registrations (event_id, attendee_id, user_id, status, custom_fields)
       VALUES ($1,$2,$3,'confirmed','{"company_name":"Empresa A"}'::jsonb) RETURNING id`,
    [eventId, a1.rows[0].id, USER_ID]
  );
  reg1Id = r1.rows[0].id;
  const r2 = await pool.query(
    `INSERT INTO events.registrations (event_id, attendee_id, user_id, status, custom_fields)
       VALUES ($1,$2,$3,'confirmed','{"company_name":"Empresa B"}'::jsonb) RETURNING id`,
    [eventId, a2.rows[0].id, USER_ID]
  );
  reg2Id = r2.rows[0].id;

  const d1 = await pool.query(
    `INSERT INTO events.rn_delegates (registration_id, full_name, email, is_primary, can_manage_team, accepted_at)
       VALUES ($1,'Alice Primary','alice@a.test',TRUE,TRUE,NOW()) RETURNING id, agenda_token`,
    [reg1Id]
  );
  del1Id = d1.rows[0].id; del1Token = d1.rows[0].agenda_token;
  const d2 = await pool.query(
    `INSERT INTO events.rn_delegates (registration_id, full_name, email, is_primary, can_manage_team, accepted_at)
       VALUES ($1,'Bob Primary','bob@b.test',TRUE,TRUE,NOW()) RETURNING id, agenda_token`,
    [reg2Id]
  );
  del2Id = d2.rows[0].id; del2Token = d2.rows[0].agenda_token;

  const rd = await pool.query(
    `INSERT INTO events.rn_rounds (event_id, kind, round_number, starts_at, ends_at)
       VALUES ($1,'meeting',1, NOW(), NOW() + INTERVAL '30 minutes') RETURNING id`,
    [eventId]
  );
  roundId = rd.rows[0].id;

  const tb = await pool.query(
    `INSERT INTO events.rn_tables (event_id, label, zone_id) VALUES ($1,'Mesa 1',NULL) RETURNING id`,
    [eventId]
  );
  tableId = tb.rows[0].id;

  const mt = await pool.query(
    `INSERT INTO events.rn_meetings (event_id, round_id, table_id, company_a_id, company_b_id, origin, locked, status)
       VALUES ($1,$2,$3,$4,$5,'matched',FALSE,'scheduled') RETURNING id`,
    [eventId, roundId, tableId, reg1Id, reg2Id]
  );
  meetingId = mt.rows[0].id;

  console.log(`[seed] event=${eventId} regs=[${reg1Id.slice(0,8)}, ${reg2Id.slice(0,8)}] del1=${del1Token.slice(0,8)} del2=${del2Token.slice(0,8)} meeting=${meetingId.slice(0,8)}`);
}

function req(method, pathUrl, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: 'localhost', port: PORT, path: pathUrl, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch { json = buf; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`, extra || ''); }
}

async function runTests() {
  console.log('\n─── E-RN-5 · Check-in ───');
  let r = await req('POST', `/api/rn/public/checkin?token=${del1Token}`, {});
  assert('checkin del1 → 200', r.status === 200, r);
  assert('response contiene checked_in_at', r.body && r.body.checked_in_at, r.body);

  r = await req('POST', `/api/rn/public/checkin?token=${del1Token}`, {}); // idempotente
  assert('checkin del1 repetido → 200 (ON CONFLICT upsert)', r.status === 200);

  r = await req('POST', `/api/rn/public/checkin?token=invalid-uuid-format`, {});
  assert('checkin token malo → 401', r.status === 401);

  console.log('\n─── E-RN-5 · Meeting lifecycle ───');
  r = await req('POST', `/api/rn/public/meetings/${meetingId}/start?token=${del1Token}`, {});
  assert('start meeting (lado A) → 200', r.status === 200, r.body);
  const mAfterStart = await pool.query(`SELECT status FROM events.rn_meetings WHERE id=$1`, [meetingId]);
  assert('meeting.status=active', mAfterStart.rows[0]?.status === 'active', mAfterStart.rows[0]);

  // delegate ajeno al meeting
  r = await req('POST', `/api/rn/public/meetings/${meetingId}/start?token=${require('uuid').v4()}`, {});
  assert('start con token no-reconocido → 404', r.status === 404);

  r = await req('POST', `/api/rn/public/meetings/${meetingId}/ebv?token=${del1Token}`,
    { amount: 50000, currency: 'USD', horizon: 'long' });
  assert('EBV lado A → 200', r.status === 200, r.body);
  r = await req('POST', `/api/rn/public/meetings/${meetingId}/ebv?token=${del2Token}`,
    { amount: 75000, currency: 'USD', horizon: 'short' });
  assert('EBV lado B → 200', r.status === 200, r.body);

  const mEbv = await pool.query(`SELECT expected_value_a_amount, expected_value_b_amount FROM events.rn_meetings WHERE id=$1`, [meetingId]);
  assert('EBV lado A persistido=50000', Number(mEbv.rows[0]?.expected_value_a_amount) === 50000, mEbv.rows[0]);
  assert('EBV lado B persistido=75000', Number(mEbv.rows[0]?.expected_value_b_amount) === 75000, mEbv.rows[0]);

  r = await req('POST', `/api/rn/public/meetings/${meetingId}/end?token=${del1Token}`, { notes: 'Buena química. Follow-up.' });
  assert('end meeting (lado A, con notes) → 200', r.status === 200, r.body);
  const mEnd = await pool.query(`SELECT status, notes_a, notes_b FROM events.rn_meetings WHERE id=$1`, [meetingId]);
  assert('meeting.status=completed', mEnd.rows[0]?.status === 'completed');
  assert('notes_a persistido', mEnd.rows[0]?.notes_a?.includes('química'));

  console.log('\n─── E-RN-5 · EBV guard evento cerrado ───');
  await pool.query(`UPDATE events.events SET status='closed' WHERE id=$1`, [eventId]);
  r = await req('POST', `/api/rn/public/meetings/${meetingId}/ebv?token=${del1Token}`,
    { amount: 1, currency: 'USD', horizon: 'long' });
  assert('EBV con evento cerrado → 423', r.status === 423, r);
  await pool.query(`UPDATE events.events SET status='live' WHERE id=$1`, [eventId]);

  console.log('\n─── E-RN-5 · Solver runtime lee rn_checkins ───');
  // Reset meeting
  await pool.query(`UPDATE events.rn_meetings SET status='scheduled' WHERE id=$1`, [meetingId]);
  // del1 chequeado, del2 NO → runtime debe marcar deferred (origin=matched, locked=false)
  await pool.query(`DELETE FROM events.rn_checkins WHERE delegate_id=$1`, [del2Id]);
  r = await req('POST', `/api/rn/events/${eventId}/rounds/${roundId}/open`, {}, { Authorization: `Bearer ${JWT_TOKEN}` });
  assert('round/open → 200', r.status === 200, r.body);
  assert('deferred_count=1 (del2 ausente)', r.body?.deferred_count === 1, r.body);
  const mDef = await pool.query(`SELECT status FROM events.rn_meetings WHERE id=$1`, [meetingId]);
  assert('meeting marcada deferred', mDef.rows[0]?.status === 'deferred', mDef.rows[0]);

  // ambos chequeados → nada deferido
  await pool.query(`UPDATE events.rn_meetings SET status='scheduled' WHERE id=$1`, [meetingId]);
  await pool.query(
    `INSERT INTO events.rn_checkins (event_id, delegate_id, method) VALUES ($1,$2,'self') ON CONFLICT DO NOTHING`,
    [eventId, del2Id]
  );
  r = await req('POST', `/api/rn/events/${eventId}/rounds/${roundId}/open`, {}, { Authorization: `Bearer ${JWT_TOKEN}` });
  assert('round/open con ambos presentes → deferred=0', r.body?.deferred_count === 0, r.body);

  console.log('\n─── E-RN-4 · Callboard público ───');
  r = await req('GET', `/api/rn/public/callboard/${eventSlug}`);
  assert('callboard → 200', r.status === 200, r);
  assert('callboard.event.slug=smoke-rn-e2e', r.body?.event?.slug === eventSlug);
  assert('callboard.round.current existe', !!r.body?.round?.current, r.body?.round);
  assert('callboard.meetings tiene 1 fila', Array.isArray(r.body?.meetings) && r.body.meetings.length >= 1, r.body?.meetings);

  console.log('\n─── E-RN-2 · Directorio ───');
  r = await req('GET', `/api/rn/public/directory/${eventSlug}?view=all&token=${del1Token}`);
  assert('directory view=all → 200', r.status === 200, r);
  assert('directory devuelve ≥1 empresa', (r.body?.results?.length || 0) >= 1, r.body);
  assert('directory.total=1 (self excluido)', r.body?.total === 1, r.body?.total);
}

async function main() {
  server = app.listen(PORT, () => console.log(`[server] listening :${PORT}`));
  await new Promise((r) => setTimeout(r, 300));
  try {
    await seed();
    await runTests();
  } catch (err) {
    console.error('[fatal]', err);
    fail++;
  }
  console.log(`\n═══ Resultado: ${pass} ✅ · ${fail} ❌ ═══`);
  // Cleanup
  await pool.query(`DELETE FROM events.events WHERE slug=$1`, [eventSlug]);
  await pool.end();
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}

main();
