// Emails post-evento Rueda — smoke dedicado (E-RN-6b · D-RN-9 §7)
// Stub transporter.sendMail cuenta llamadas + captura subject/html; se re-implementa
// la lógica del endpoint POST /events/:id/report/send pero importando las plantillas
// REALES del email.js (vía override de transporter con proxy).
//
//   T1 — happy path: productor + N delegados aceptados reciben email
//   T2 — delegado no aceptado (accepted_at=NULL) no recibe
//   T3 — delegado secundario (is_primary=FALSE) no recibe (primary-only §7)
//   T4 — payload delegado contiene counterpart_company pero NUNCA counterpart amount
//   T5 — payload productor contiene top con company_a/b y agregado D-RN-15 (no SUM naive)
//   T6 — cobertura <20% hace el email productor incluir flag "cifra referencial"
//   T7 — multi-tenancy: user_id ajeno no puede disparar send → 404
'use strict';

process.env.JWT_SECRET = 'em-rn';
process.env.SMTP_HOST  = '';
process.env.CMS_URL    = 'https://smoke.local';

const { Pool } = require('pg');
const pool = new Pool({
  host: 'localhost', port: 5433, database: 'cms_signage_rntest',
  user: 'postgres', password: 'smarttv_dev', max: 10,
});
global.pool = pool;
global.io = { to: () => ({ emit: () => {} }) };

// ── Stub nodemailer ANTES de cargar email.js ────────────────────────────────
const sentBox = [];
require.cache[require.resolve('nodemailer')] = {
  exports: {
    createTransport: () => ({
      sendMail: async (opts) => { sentBox.push(opts); return { messageId: `mock-${sentBox.length}` }; },
      verify:   async () => true,
    }),
  },
};

// Cargar email real (ahora usará el transporter mockeado)
const email = require('../src/services/email.js');

// ── Helpers del router (reimpl 1:1) ─────────────────────────────────────────
async function assertRnEventOwned(eventId, userId) {
  const r = await pool.query(
    `SELECT id, user_id, name, status FROM events.events WHERE id=$1`, [eventId]);
  if (!r.rows[0] || r.rows[0].user_id !== userId) {
    const e = new Error('Evento no encontrado'); e.httpStatus = 404; throw e;
  }
  return r.rows[0];
}

async function reportSend(eventId, userId) {
  const ev = await assertRnEventOwned(eventId, userId);
  const baseUrl = (process.env.CMS_URL || 'https://smoke.local').replace(/\/$/, '');

  const perMeeting = (await pool.query(
    `SELECT m.id,
            CASE WHEN m.expected_value_a_amount IS NOT NULL AND m.expected_value_b_amount IS NOT NULL
                   THEN (m.expected_value_a_amount + m.expected_value_b_amount) / 2.0
                 WHEN m.expected_value_a_amount IS NOT NULL THEN m.expected_value_a_amount
                 WHEN m.expected_value_b_amount IS NOT NULL THEN m.expected_value_b_amount END AS meeting_value,
            CASE WHEN m.expected_value_a_amount IS NOT NULL AND m.expected_value_b_amount IS NOT NULL THEN 'bilateral'
                 WHEN m.expected_value_a_amount IS NOT NULL OR  m.expected_value_b_amount IS NOT NULL THEN 'unilateral'
                 ELSE 'empty' END AS fill_type
       FROM events.rn_meetings m WHERE m.event_id=$1`, [eventId])).rows;
  const totalMeetings = perMeeting.length;
  const withEbv = perMeeting.filter(r => r.fill_type !== 'empty');
  const vals = withEbv.map(r => Number(r.meeting_value)).sort((a,b)=>a-b);
  const sumAgg = vals.reduce((s,v)=>s+v,0);
  const coverage = totalMeetings > 0 ? withEbv.length / totalMeetings : 0;
  const metrics = { total: totalMeetings, with_ebv: withEbv.length,
    total_estimated: sumAgg || null, coverage, referential: coverage < 0.20 };

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

  const producer = (await pool.query(`SELECT email, name FROM public.users WHERE id=$1`, [userId])).rows[0];
  let sentProducer = 0;
  if (producer?.email) {
    await email.sendRnProducerSummaryEmail({
      to: producer.email, producerName: producer.name || 'Productor',
      eventName: ev.name, metrics, top, reportUrl: `${baseUrl}/dashboard.html#events-tab`,
    });
    sentProducer = 1;
  }

  const delegates = (await pool.query(
    `SELECT d.full_name, d.email, d.agenda_token, r.id AS registration_id,
            r.custom_fields->>'company_name' AS company_name
       FROM events.rn_delegates d
       JOIN events.registrations r ON r.id = d.registration_id
      WHERE r.event_id=$1 AND d.is_primary=TRUE AND d.accepted_at IS NOT NULL`, [eventId])).rows;

  let sentDelegates = 0;
  for (const d of delegates) {
    const myMeetings = (await pool.query(
      `SELECT m.id, rd.round_number, t.label AS table_label,
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
        ORDER BY rd.round_number ASC`, [d.registration_id, eventId])).rows;
    const myFilled = myMeetings.filter(r => r.my_amount != null);
    const mySum = myFilled.reduce((s,r)=>s+Number(r.my_amount),0);
    await email.sendRnEventSummaryEmail({
      to: d.email, delegateName: d.full_name, companyName: d.company_name,
      eventName: ev.name, agendaUrl: `${baseUrl}/rueda/mi-agenda/${d.agenda_token}`,
      meetings: myMeetings.map(m => ({
        counterpart_company: m.counterpart_company,
        round: m.round_number, table_label: m.table_label,
      })),
      myEbv: { sum: mySum || null, filled: myFilled.length },
      aggregate: { total_meetings: totalMeetings, with_ebv: withEbv.length,
        total_estimated: metrics.total_estimated, referential: metrics.referential },
    });
    sentDelegates++;
  }
  return { sent_to_producer: sentProducer, sent_to_delegates: sentDelegates, delegates_total: delegates.length };
}

// ── Harness ────────────────────────────────────────────────────────────────
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

async function ensureUser(id, email, name) {
  await pool.query(
    `INSERT INTO public.users (id,email,name,role) VALUES ($1,$2,$3,'admin')
     ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name`,
    [id, email, name]
  );
}

async function seed(slug, {
  numCompanies = 4,
  acceptAllDelegates = true,
  withSecondaryDelegate = false,
  userId = USER_ID,
} = {}) {
  await cleanupSlug(slug);
  const cfg = { event_type: 'matchmaking', matchmaking: { matching_mode: 'tags' } };
  const ev = await pool.query(
    `INSERT INTO events.events (user_id,name,slug,status,timezone,starts_at,ends_at,config)
     VALUES ($1,$2,$3,'live','America/Bogota',NOW(),NOW()+INTERVAL '1 day',$4::jsonb) RETURNING id`,
    [userId, `Rueda ${slug}`, slug, JSON.stringify(cfg)]);
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
    const accAt = acceptAllDelegates ? 'NOW()' : 'NULL';
    const dPrim = await pool.query(
      `INSERT INTO events.rn_delegates (registration_id,full_name,email,is_primary,can_manage_team,accepted_at)
       VALUES ($1,$2,$3,TRUE,TRUE, ${accAt}) RETURNING id, agenda_token`,
      [r.rows[0].id, `D${i}`, `${slug}-${i}@test`]);
    let secondary = null;
    if (withSecondaryDelegate && i === 0) {
      secondary = await pool.query(
        `INSERT INTO events.rn_delegates (registration_id,full_name,email,is_primary,can_manage_team,accepted_at)
         VALUES ($1,$2,$3,FALSE,FALSE,NOW()) RETURNING id, agenda_token`,
        [r.rows[0].id, `D${i}-sec`, `${slug}-${i}-sec@test`]);
    }
    comps.push({ regId: r.rows[0].id, primaryEmail: `${slug}-${i}@test`, secondary: secondary?.rows[0] });
  }
  // 1 ronda, numCompanies/2 mesas, parejas únicas
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

// ── Tests ──────────────────────────────────────────────────────────────────
async function test1_HappyPath() {
  console.log('\n═══ T1 · HAPPY PATH · productor + N delegados aceptados ═══');
  await ensureUser(USER_ID, 'prod@smoke.local', 'Daniel Productor');
  const slug = 'em-t1';
  sentBox.length = 0;
  const { eventId, meetings } = await seed(slug, { numCompanies: 4 });
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=1000, expected_value_b_amount=3000,
     expected_value_a_currency='COP', expected_value_b_currency='COP',
     expected_value_a_at=NOW(), expected_value_b_at=NOW() WHERE id=$1`, [meetings[0].id]);
  const r = await reportSend(eventId, USER_ID);
  ok('sent_to_producer=1', r.sent_to_producer === 1);
  ok('sent_to_delegates=4', r.sent_to_delegates === 4);
  ok('total sendMail = 5 (1 productor + 4 delegados)', sentBox.length === 5);
  const prod = sentBox.find(m => m.to === 'prod@smoke.local');
  ok('productor email dirigido correctamente', !!prod);
  ok('subject productor contiene nombre evento', prod && prod.subject.includes(`Rueda ${slug}`));
  await cleanupSlug(slug);
}

async function test2_NoAcceptedNoSend() {
  console.log('\n═══ T2 · DELEGADO SIN accepted_at → no recibe ═══');
  await ensureUser(USER_ID, 'prod@smoke.local', 'Daniel');
  const slug = 'em-t2';
  sentBox.length = 0;
  const { eventId } = await seed(slug, { numCompanies: 4, acceptAllDelegates: false });
  const r = await reportSend(eventId, USER_ID);
  ok('sent_to_delegates=0', r.sent_to_delegates === 0);
  ok('delegates_total=0 (ninguno accepted)', r.delegates_total === 0);
  ok('solo 1 email enviado (productor)', sentBox.length === 1);
  await cleanupSlug(slug);
}

async function test3_SecondaryDoesNotReceive() {
  console.log('\n═══ T3 · DELEGADO SECUNDARIO · is_primary=FALSE no recibe ═══');
  await ensureUser(USER_ID, 'prod@smoke.local', 'Daniel');
  const slug = 'em-t3';
  sentBox.length = 0;
  const { eventId } = await seed(slug, { numCompanies: 2, withSecondaryDelegate: true });
  const r = await reportSend(eventId, USER_ID);
  ok('sent_to_delegates=2 (solo primarios)', r.sent_to_delegates === 2);
  ok('ningún email a secondary (-sec@test)', !sentBox.some(m => /-sec@test$/.test(m.to)));
  await cleanupSlug(slug);
}

async function test4_DelegatePayloadPrivacy() {
  console.log('\n═══ T4 · DELEGATE PAYLOAD · counterpart_company sí, counterpart_amount nunca ═══');
  await ensureUser(USER_ID, 'prod@smoke.local', 'Daniel');
  const slug = 'em-t4';
  sentBox.length = 0;
  const { eventId, meetings } = await seed(slug, { numCompanies: 2 });
  // Lado A llena 1111, lado B llena 9999
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=1111, expected_value_b_amount=9999,
     expected_value_a_currency='COP', expected_value_b_currency='COP',
     expected_value_a_at=NOW(), expected_value_b_at=NOW() WHERE id=$1`, [meetings[0].id]);
  await reportSend(eventId, USER_ID);
  const aEmail = sentBox.find(m => m.to === `${slug}-0@test`);
  const bEmail = sentBox.find(m => m.to === `${slug}-1@test`);
  ok('A recibió email', !!aEmail);
  ok('A HTML contiene "Co1" (counterpart company)', aEmail && aEmail.html.includes('Co1'));
  ok('A HTML NO contiene 9999 (lado opuesto)', aEmail && !aEmail.html.includes('9999'));
  ok('A HTML contiene 1.111 (mi lado, formato es-CO)', aEmail && aEmail.html.includes('1.111'));
  ok('B HTML NO contiene 1111 (lado opuesto)', bEmail && !bEmail.html.includes('1.111') && !bEmail.html.includes('1111'));
  ok('B HTML contiene 9.999 (mi lado)', bEmail && bEmail.html.includes('9.999'));
  await cleanupSlug(slug);
}

async function test5_ProducerPayloadAggregate() {
  console.log('\n═══ T5 · PRODUCER PAYLOAD · top nombrado + agregado D-RN-15 ═══');
  await ensureUser(USER_ID, 'prod@smoke.local', 'Daniel');
  const slug = 'em-t5';
  sentBox.length = 0;
  const { eventId, meetings } = await seed(slug, { numCompanies: 4 });
  // m0 bilateral 1000+3000 → value=2000
  // m1 bilateral 2000+10000 → value=6000
  // Agregado D-RN-15 = 2000+6000 = 8000; SUM(a+b) naive = 16000
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=1000, expected_value_b_amount=3000,
     expected_value_a_currency='COP', expected_value_b_currency='COP',
     expected_value_a_at=NOW(), expected_value_b_at=NOW() WHERE id=$1`, [meetings[0].id]);
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=2000, expected_value_b_amount=10000,
     expected_value_a_currency='COP', expected_value_b_currency='COP',
     expected_value_a_at=NOW(), expected_value_b_at=NOW() WHERE id=$1`, [meetings[1].id]);
  await reportSend(eventId, USER_ID);
  const prod = sentBox.find(m => m.to === 'prod@smoke.local');
  ok('productor HTML contiene company_a y company_b del top', prod && prod.html.includes('Co0') && prod.html.includes('Co1') && prod.html.includes('Co2') && prod.html.includes('Co3'));
  ok('productor HTML contiene agregado D-RN-15 = $8.000', prod && prod.html.includes('8.000'));
  ok('productor HTML NO contiene SUM naive $16.000', prod && !prod.html.includes('16.000'));
  await cleanupSlug(slug);
}

async function test6_ReferentialFlag() {
  console.log('\n═══ T6 · PRODUCER · cobertura <20% dispara flag "referencial" ═══');
  await ensureUser(USER_ID, 'prod@smoke.local', 'Daniel');
  const slug = 'em-t6';
  sentBox.length = 0;
  const { eventId, meetings } = await seed(slug, { numCompanies: 20 }); // 10 meetings
  await pool.query(`UPDATE events.rn_meetings SET
     expected_value_a_amount=5000, expected_value_a_currency='COP', expected_value_a_at=NOW()
    WHERE id=$1`, [meetings[0].id]);
  await reportSend(eventId, USER_ID);
  const prod = sentBox.find(m => m.to === 'prod@smoke.local');
  ok('productor HTML contiene "referenciales"', prod && /referenciales/i.test(prod.html));
  await cleanupSlug(slug);
}

async function test7_MultiTenancy() {
  console.log('\n═══ T7 · MULTI-TENANCY · user_id ajeno → 404 ═══');
  await ensureUser(USER_ID, 'prod@smoke.local', 'Daniel');
  await ensureUser(OTHER_USER_ID, 'other@smoke.local', 'Other');
  const slug = 'em-t7';
  const { eventId } = await seed(slug, { numCompanies: 2 });
  await expectHttp('user_id=999 → 404', 404, () => reportSend(eventId, OTHER_USER_ID));
  await cleanupSlug(slug);
}

(async () => {
  const t0 = Date.now();
  try {
    await test1_HappyPath();
    await test2_NoAcceptedNoSend();
    await test3_SecondaryDoesNotReceive();
    await test4_DelegatePayloadPrivacy();
    await test5_ProducerPayloadAggregate();
    await test6_ReferentialFlag();
    await test7_MultiTenancy();
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
