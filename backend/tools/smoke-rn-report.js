// Reporte post-evento Rueda — smoke dedicado (E-RN-6a · D-RN-9 + D-RN-15)
// Valida producerReport + delegateReport contra cms_signage_rntest.
//   T1 — productor baseline: 5 meetings, 4 con EBV, agregado D-RN-15 correcto
//   T2 — cobertura <20% dispara flag "referential"
//   T3 — anti-test: SUM(a+b) naive ≠ agregado D-RN-15 (per-meeting AVG)
//   T4 — Top N ordenado desc por value, nombres company_a/b presentes
//   T5 — delegate solo ve su lado (nunca counterpart amount)
//   T6 — delegate ve agregado anónimo (sin top, sin nombres de otros)
//   T7 — multi-tenancy: productor con user_id distinto → 404 (assertRnEventOwned)
//   T8 — token delegado inválido → 401
'use strict';

process.env.JWT_SECRET = 'rep-rn';
process.env.SMTP_HOST  = '';

const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost', port: 5433, database: 'cms_signage_rntest',
  user: 'postgres', password: 'smarttv_dev', max: 10,
});
global.pool = pool;
global.io = { to: () => ({ emit: () => {} }) };
require.cache[require.resolve('../src/services/email.js')] = {
  exports: new Proxy({}, { get: () => async () => ({ ok: true }) }),
};

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ───── helpers reproducidos exactos del router ─────
async function assertRnEventOwned(eventId, userId) {
  const r = await pool.query(
    `SELECT id, user_id, name, status FROM events.events WHERE id=$1`, [eventId]);
  if (!r.rows[0]) { const e = new Error('Evento no encontrado'); e.httpStatus = 404; throw e; }
  if (r.rows[0].user_id !== userId) {
    const e = new Error('Evento no encontrado'); e.httpStatus = 404; throw e;
  }
  return r.rows[0];
}
async function resolveToken(token) {
  if (!token || !UUID_RE.test(token)) { const e = new Error('Token inválido'); e.httpStatus = 401; throw e; }
  const { rows } = await pool.query(
    `SELECT d.id AS delegate_id, d.registration_id, r.event_id, e.name AS event_name, e.slug AS event_slug, e.status AS event_status
       FROM events.rn_delegates d
       JOIN events.registrations r ON r.id = d.registration_id
       JOIN events.events e        ON e.id = r.event_id
      WHERE d.agenda_token=$1`, [token]);
  if (!rows[0]) { const e = new Error('Token no reconocido'); e.httpStatus = 404; throw e; }
  return rows[0];
}

async function producerReport(eventId, userId, topN = 10) {
  const ev = await assertRnEventOwned(eventId, userId);
  const perMeeting = (await pool.query(
    `SELECT m.id, m.expected_value_a_amount AS a_amt, m.expected_value_b_amount AS b_amt,
            m.expected_value_a_currency AS a_cur, m.expected_value_b_currency AS b_cur,
            m.expected_value_a_horizon AS a_hor, m.expected_value_b_horizon AS b_hor,
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
       FROM events.rn_meetings m WHERE m.event_id=$1`, [eventId])).rows;

  const total      = perMeeting.length;
  const withEbv    = perMeeting.filter(r => r.fill_type !== 'empty');
  const bilateral  = perMeeting.filter(r => r.fill_type === 'bilateral').length;
  const unilateral = perMeeting.filter(r => r.fill_type === 'unilateral').length;
  const values     = withEbv.map(r => Number(r.meeting_value)).sort((a, b) => a - b);
  const coverage   = total > 0 ? withEbv.length / total : 0;
  const sum        = values.reduce((s, v) => s + v, 0);
  const avg        = values.length ? sum / values.length : null;
  const median     = values.length
    ? (values.length % 2 ? values[(values.length-1)/2]
                         : (values[values.length/2-1] + values[values.length/2]) / 2)
    : null;
  const topIds = withEbv.slice().sort((a,b)=>Number(b.meeting_value)-Number(a.meeting_value)).slice(0,topN).map(r=>r.id);
  let topRows = [];
  if (topIds.length) {
    topRows = (await pool.query(
      `SELECT m.id, rd.round_number, t.label AS table_label,
              ra.custom_fields->>'company_name' AS company_a,
              rb.custom_fields->>'company_name' AS company_b
         FROM events.rn_meetings m
         JOIN events.rn_rounds rd ON rd.id=m.round_id
         JOIN events.rn_tables t  ON t.id=m.table_id
         JOIN events.registrations ra ON ra.id=m.company_a_id
         JOIN events.registrations rb ON rb.id=m.company_b_id
        WHERE m.id = ANY($1::uuid[])`, [topIds])).rows;
  }
  const byId = Object.fromEntries(topRows.map(r=>[r.id, r]));
  const top = withEbv.slice().sort((a,b)=>Number(b.meeting_value)-Number(a.meeting_value)).slice(0,topN)
    .map(r => ({ meeting_id: r.id, value: Number(r.meeting_value), fill_type: r.fill_type,
                 company_a: byId[r.id]?.company_a, company_b: byId[r.id]?.company_b }));
  return { event: ev, meetings: { total, with_ebv: withEbv.length, bilateral, unilateral },
           ebv: { total_estimated: sum || null, avg_per_meeting: avg, median_per_meeting: median,
                  coverage, referential: coverage < 0.20 }, top };
}

async function delegateReport(token) {
  const ctx = await resolveToken(token);
  const regId = ctx.registration_id, eventId = ctx.event_id;
  const mine = (await pool.query(
    `SELECT m.id,
            CASE WHEN m.company_a_id=$1 THEN m.expected_value_a_amount
                 WHEN m.company_b_id=$1 THEN m.expected_value_b_amount END AS my_amount,
            CASE WHEN m.company_a_id=$1 THEN rb.custom_fields->>'company_name'
                 ELSE ra.custom_fields->>'company_name' END AS counterpart_company
       FROM events.rn_meetings m
       JOIN events.registrations ra ON ra.id=m.company_a_id
       JOIN events.registrations rb ON rb.id=m.company_b_id
      WHERE m.event_id=$2 AND (m.company_a_id=$1 OR m.company_b_id=$1)`, [regId, eventId])).rows;
  const perMeeting = (await pool.query(
    `SELECT CASE
       WHEN m.expected_value_a_amount IS NOT NULL AND m.expected_value_b_amount IS NOT NULL
         THEN (m.expected_value_a_amount + m.expected_value_b_amount) / 2.0
       WHEN m.expected_value_a_amount IS NOT NULL THEN m.expected_value_a_amount
       WHEN m.expected_value_b_amount IS NOT NULL THEN m.expected_value_b_amount
     END AS meeting_value FROM events.rn_meetings m WHERE m.event_id=$1`, [eventId])).rows;
  const total = perMeeting.length;
  const withEbv = perMeeting.filter(r => r.meeting_value != null);
  const sum = withEbv.reduce((s,r)=>s+Number(r.meeting_value), 0);
  const coverage = total > 0 ? withEbv.length / total : 0;
  return { me: { meetings_total: mine.length, meetings: mine },
           event_aggregate_anonymous: { total_meetings: total, with_ebv: withEbv.length,
             total_estimated: sum || null, coverage, referential: coverage < 0.20 } };
}

// ───── harness ─────
const USER_ID = 1, OTHER_USER_ID = 999;
let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`    ✅ ${label}`); }
  else { fail++; console.log(`    ❌ ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0,250) : ''); }
}
async function expectHttp(label, status, fn) {
  try { await fn(); ok(label + ` (esperaba ${status})`, false, 'no throw'); }
  catch (e) { ok(label, e.httpStatus === status, { got: e.httpStatus, msg: e.message }); }
}
async function cleanupSlug(slug) {
  await pool.query(`DELETE FROM events.events WHERE slug=$1`, [slug]);
  await pool.query(`DELETE FROM events.attendees WHERE email LIKE $1`, [`${slug}-%@test`]);
}

async function seedRich(slug, numCompanies = 8, { userId = USER_ID } = {}) {
  await cleanupSlug(slug);
  const cfg = { event_type: 'matchmaking', matchmaking: { matching_mode: 'tags' } };
  const ev = await pool.query(
    `INSERT INTO events.events (user_id,name,slug,status,timezone,starts_at,ends_at,config)
     VALUES ($1,$2,$3,'live','America/Bogota',NOW(),NOW()+INTERVAL '1 day',$4::jsonb) RETURNING id`,
    [userId, slug, slug, JSON.stringify(cfg)]);
  const eventId = ev.rows[0].id;
  const comps = [];
  for (let i = 0; i < numCompanies; i++) {
    const a = await pool.query(
      `INSERT INTO events.attendees (user_id,email,name,organization) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `${slug}-${i}@test`, `D${i}`, `Co${i}`]);
    const r = await pool.query(
      `INSERT INTO events.registrations (event_id,attendee_id,user_id,ticket_type,status,custom_fields)
       VALUES ($1,$2,$3,'rueda','confirmed',$4::jsonb) RETURNING id`,
      [eventId, a.rows[0].id, userId, JSON.stringify({ company_name: `Co${i}` })]);
    const d = await pool.query(
      `INSERT INTO events.rn_delegates (registration_id,full_name,email,is_primary,can_manage_team,accepted_at)
       VALUES ($1,$2,$3,TRUE,TRUE,NOW()) RETURNING id, agenda_token`,
      [r.rows[0].id, `D${i}`, `${slug}-${i}@test`]);
    comps.push({ regId: r.rows[0].id, delegateId: d.rows[0].id, token: d.rows[0].agenda_token });
  }
  // 1 ronda, numCompanies/2 mesas, meetings parejas únicas (sin double-booking)
  const round = (await pool.query(
    `INSERT INTO events.rn_rounds (event_id,round_number,kind,starts_at,ends_at)
     VALUES ($1,1,'meeting',NOW(),NOW()+INTERVAL '20 minutes') RETURNING id`, [eventId])).rows[0].id;
  const meetings = [];
  for (let i = 0; i < numCompanies / 2; i++) {
    const t = (await pool.query(
      `INSERT INTO events.rn_tables (event_id,label,display_order) VALUES ($1,$2,$3) RETURNING id`,
      [eventId, `T${i}`, i])).rows[0].id;
    const m = (await pool.query(
      `INSERT INTO events.rn_meetings (event_id,round_id,table_id,company_a_id,company_b_id,origin,locked,status)
       VALUES ($1,$2,$3,$4,$5,'manual',FALSE,'scheduled') RETURNING id`,
      [eventId, round, t, comps[i*2].regId, comps[i*2+1].regId])).rows[0].id;
    meetings.push({ id: m, a: comps[i*2], b: comps[i*2+1] });
  }
  return { eventId, comps, meetings };
}

// ───── tests ─────
async function test1_ProducerBaseline() {
  console.log('\n═══ T1 · PRODUCER REPORT · baseline D-RN-15 ═══');
  const slug = 'rep-t1';
  const { eventId, meetings } = await seedRich(slug, 8); // 4 meetings
  // Patrón:
  //   m0 bilateral — a=1000, b=3000 → value=2000
  //   m1 bilateral — a=400, b=600 → value=500
  //   m2 unilateral A — a=5000 → value=5000
  //   m3 vacío
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=1000, expected_value_a_currency='COP', expected_value_a_horizon='short', expected_value_a_at=NOW(),
     expected_value_b_amount=3000, expected_value_b_currency='COP', expected_value_b_horizon='short', expected_value_b_at=NOW()
    WHERE id=$1`, [meetings[0].id]);
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=400, expected_value_a_currency='COP', expected_value_a_horizon='long', expected_value_a_at=NOW(),
     expected_value_b_amount=600, expected_value_b_currency='COP', expected_value_b_horizon='long', expected_value_b_at=NOW()
    WHERE id=$1`, [meetings[1].id]);
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=5000, expected_value_a_currency='COP', expected_value_a_horizon='short', expected_value_a_at=NOW()
    WHERE id=$1`, [meetings[2].id]);
  // m3 vacío

  const rep = await producerReport(eventId, USER_ID);
  ok('meetings.total=4', rep.meetings.total === 4);
  ok('meetings.with_ebv=3', rep.meetings.with_ebv === 3);
  ok('meetings.bilateral=2', rep.meetings.bilateral === 2);
  ok('meetings.unilateral=1', rep.meetings.unilateral === 1);
  ok('coverage=0.75', Math.abs(rep.ebv.coverage - 0.75) < 0.001);
  ok('referential=false (>=20%)', rep.ebv.referential === false);
  // valores per-meeting: [2000, 500, 5000] → sum=7500, avg=2500, median=2000, min=500, max=5000
  ok('total_estimated=7500', Math.abs(Number(rep.ebv.total_estimated) - 7500) < 0.01, { got: rep.ebv.total_estimated });
  ok('avg=2500', Math.abs(Number(rep.ebv.avg_per_meeting) - 2500) < 0.01);
  ok('median=2000', Math.abs(Number(rep.ebv.median_per_meeting) - 2000) < 0.01);
  await cleanupSlug(slug);
}

async function test2_CoverageUnder20Flag() {
  console.log('\n═══ T2 · COVERAGE <20% → flag referential ═══');
  const slug = 'rep-t2';
  const { eventId, meetings } = await seedRich(slug, 20); // 10 meetings
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=1000, expected_value_a_currency='COP', expected_value_a_at=NOW()
    WHERE id=$1`, [meetings[0].id]);
  const rep = await producerReport(eventId, USER_ID);
  ok('coverage=0.1', Math.abs(rep.ebv.coverage - 0.1) < 0.001);
  ok('referential=true (<20%)', rep.ebv.referential === true);
  await cleanupSlug(slug);
}

async function test3_AntiTestSumVsAggregate() {
  console.log('\n═══ T3 · ANTI-TEST · SUM(a+b) naive ≠ agregado D-RN-15 ═══');
  const slug = 'rep-t3';
  const { eventId, meetings } = await seedRich(slug, 4); // 2 meetings
  // Bilateral m0: a=1000, b=3000 → correct=(1000+3000)/2=2000
  // Bilateral m1: a=2000, b=10000 → correct=(2000+10000)/2=6000
  // Correct total = 8000; naive SUM(a+b) = 16000
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=1000, expected_value_b_amount=3000,
     expected_value_a_currency='COP', expected_value_b_currency='COP',
     expected_value_a_at=NOW(), expected_value_b_at=NOW() WHERE id=$1`, [meetings[0].id]);
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=2000, expected_value_b_amount=10000,
     expected_value_a_currency='COP', expected_value_b_currency='COP',
     expected_value_a_at=NOW(), expected_value_b_at=NOW() WHERE id=$1`, [meetings[1].id]);
  const rep = await producerReport(eventId, USER_ID);
  const naive = (await pool.query(
    `SELECT COALESCE(SUM(expected_value_a_amount),0) + COALESCE(SUM(expected_value_b_amount),0) AS s
       FROM events.rn_meetings WHERE event_id=$1`, [eventId])).rows[0].s;
  ok('D-RN-15 agregado=8000', Math.abs(Number(rep.ebv.total_estimated) - 8000) < 0.01, { got: rep.ebv.total_estimated });
  ok('SUM(a+b) naive=16000 (doble-conteo)', Number(naive) === 16000);
  ok('diferencia=8000 = exactamente lo prohibido por D-RN-15',
     Number(naive) - Number(rep.ebv.total_estimated) === 8000);
  await cleanupSlug(slug);
}

async function test4_TopNOrdering() {
  console.log('\n═══ T4 · TOP N · orden desc por value, nombres presentes ═══');
  const slug = 'rep-t4';
  const { eventId, meetings } = await seedRich(slug, 8); // 4 meetings
  const vals = [[100,100],[9000,9000],[500,500],[2000,2000]]; // per-meeting: 100, 9000, 500, 2000
  for (let i = 0; i < 4; i++) {
    await pool.query(`UPDATE events.rn_meetings SET
       expected_value_a_amount=$2, expected_value_b_amount=$3,
       expected_value_a_currency='COP', expected_value_b_currency='COP',
       expected_value_a_at=NOW(), expected_value_b_at=NOW() WHERE id=$1`,
      [meetings[i].id, vals[i][0], vals[i][1]]);
  }
  const rep = await producerReport(eventId, USER_ID, 3);
  ok('top.length=3', rep.top.length === 3);
  ok('top[0].value=9000', rep.top[0].value === 9000);
  ok('top[1].value=2000', rep.top[1].value === 2000);
  ok('top[2].value=500', rep.top[2].value === 500);
  ok('top[0] tiene company_a y company_b', !!rep.top[0].company_a && !!rep.top[0].company_b);
  await cleanupSlug(slug);
}

async function test5_DelegateOnlyOwnSide() {
  console.log('\n═══ T5 · DELEGATE · solo ve su lado, nunca counterpart amount ═══');
  const slug = 'rep-t5';
  const { eventId, meetings } = await seedRich(slug, 4); // 2 meetings
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=1111, expected_value_b_amount=9999,
     expected_value_a_currency='COP', expected_value_b_currency='COP',
     expected_value_a_at=NOW(), expected_value_b_at=NOW() WHERE id=$1`, [meetings[0].id]);
  const repA = await delegateReport(meetings[0].a.token);
  const repB = await delegateReport(meetings[0].b.token);
  const myA = repA.me.meetings.find(m => m.id === meetings[0].id);
  const myB = repB.me.meetings.find(m => m.id === meetings[0].id);
  ok('A ve my_amount=1111', Number(myA.my_amount) === 1111);
  ok('A ve counterpart company (no amount)', myA.counterpart_company && myA.my_amount !== 9999);
  ok('A payload no contiene campo "counterpart_amount"', !('counterpart_amount' in myA));
  ok('B ve my_amount=9999', Number(myB.my_amount) === 9999);
  await cleanupSlug(slug);
}

async function test6_DelegateAggregateAnonymous() {
  console.log('\n═══ T6 · DELEGATE · agregado anónimo (sin top, sin otras empresas) ═══');
  const slug = 'rep-t6';
  const { eventId, meetings } = await seedRich(slug, 8); // 4 meetings
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=1000, expected_value_b_amount=3000,
     expected_value_a_currency='COP', expected_value_b_currency='COP',
     expected_value_a_at=NOW(), expected_value_b_at=NOW() WHERE id=$1`, [meetings[0].id]);
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=500, expected_value_b_amount=1500,
     expected_value_a_currency='COP', expected_value_b_currency='COP',
     expected_value_a_at=NOW(), expected_value_b_at=NOW() WHERE id=$1`, [meetings[1].id]);
  const rep = await delegateReport(meetings[0].a.token);
  ok('agg.total_meetings=4', rep.event_aggregate_anonymous.total_meetings === 4);
  ok('agg.with_ebv=2', rep.event_aggregate_anonymous.with_ebv === 2);
  ok('agg.total_estimated=3000 (2000+1000)',
     Math.abs(Number(rep.event_aggregate_anonymous.total_estimated) - 3000) < 0.01);
  ok('agg.coverage=0.5', Math.abs(rep.event_aggregate_anonymous.coverage - 0.5) < 0.001);
  ok('agg sin top (no leak de nombres)', !('top' in rep.event_aggregate_anonymous) && !('top' in rep));
  await cleanupSlug(slug);
}

async function test7_MultiTenancy() {
  console.log('\n═══ T7 · MULTI-TENANCY · productor con user_id ajeno → 404 ═══');
  const slug = 'rep-t7';
  const { eventId } = await seedRich(slug, 4);
  await expectHttp('user_id=999 pidiendo report del evento → 404', 404,
    () => producerReport(eventId, OTHER_USER_ID));
  await cleanupSlug(slug);
}

async function test8_InvalidToken() {
  console.log('\n═══ T8 · DELEGATE · token mal-formado → 401 ═══');
  await expectHttp('token="xyz" → 401', 401, () => delegateReport('xyz'));
  await expectHttp('token=null → 401', 401, () => delegateReport(null));
  await expectHttp('UUID inexistente → 404', 404,
    () => delegateReport('00000000-0000-0000-0000-000000000000'));
}

(async () => {
  const t0 = Date.now();
  try {
    await test1_ProducerBaseline();
    await test2_CoverageUnder20Flag();
    await test3_AntiTestSumVsAggregate();
    await test4_TopNOrdering();
    await test5_DelegateOnlyOwnSide();
    await test6_DelegateAggregateAnonymous();
    await test7_MultiTenancy();
    await test8_InvalidToken();
  } catch (e) {
    console.error('\n💥 EXCEPCIÓN NO MANEJADA:', e);
    fail++;
  }
  console.log(`\n═══════════════════════════════════════`);
  console.log(` RESULT · pass=${pass} · fail=${fail} · ${Date.now()-t0}ms`);
  console.log(`═══════════════════════════════════════`);
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
})();
