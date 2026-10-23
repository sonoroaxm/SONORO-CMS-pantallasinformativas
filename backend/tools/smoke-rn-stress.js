// Stress Rueda de Negocios — N=100 empresas, solver pre-evento + runtime.
// Mide tiempo, cobertura, dobles-booking, compactación.
'use strict';

process.env.JWT_SECRET = 'stress-rn';
process.env.SMTP_HOST  = '';
process.env.CMS_URL    = 'http://localhost:5099';

const { Pool } = require('pg');
const { withTransaction } = require('../src/db/withTransaction');

const pool = new Pool({
  host: 'localhost', port: 5433, database: 'cms_signage_rntest',
  user: 'postgres', password: 'smarttv_dev', max: 5,
});
global.pool = pool;
global.io = { to: () => ({ emit: () => {} }) };

// Stub emails
require.cache[require.resolve('../src/services/email.js')] = {
  exports: new Proxy({}, { get: () => async () => ({ ok: true }) }),
};

const solver = require('../src/services/matchmaking-solver');

const USER_ID = 1;
const N = parseInt(process.env.N || '100', 10);
const TAG_UNIVERSE = 40;          // 40 tags universales (sin kind)
const TAGS_PER_COMPANY = 4;       // cada empresa pide/ofrece 4 tags (del pool común)
const ROUNDS = 15;                // 15 rondas de reunión
const TABLES = Math.ceil(N / 2);  // suficiente para full pairing en 1 ronda

const SLUG = 'stress-rn-n' + N;
let eventId;
const regs = [];      // {regId, delegateId}
const tagIds = [];

function rngPick(arr, k) {
  const copy = [...arr];
  const out = [];
  while (out.length < k && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

async function cleanup() {
  await pool.query(`DELETE FROM events.events WHERE slug=$1`, [SLUG]);
  await pool.query(`DELETE FROM events.attendees WHERE email LIKE 'stress-%@test'`);
  await pool.query(`DELETE FROM events.rn_tags WHERE user_id=$1 AND slug LIKE 'stress-tag-%'`, [USER_ID]);
}

async function seed() {
  console.log(`[stress] N=${N} rounds=${ROUNDS} tables=${TABLES}`);
  const t0 = Date.now();

  await cleanup();

  // Event
  const ev = await pool.query(
    `INSERT INTO events.events (user_id,name,slug,status,timezone,starts_at,ends_at,config)
     VALUES ($1,'Stress RN',$2,'live','America/Bogota',NOW(),NOW()+INTERVAL '1 day',
       '{"event_type":"matchmaking","matchmaking":{"matching_mode":"tags","visibility":"all","default_tag_overlap_threshold":1}}'::jsonb)
     RETURNING id`,
    [USER_ID, SLUG]
  );
  eventId = ev.rows[0].id;

  // Tags: 40 universales
  for (let i = 0; i < TAG_UNIVERSE; i++) {
    const t = await pool.query(
      `INSERT INTO events.rn_tags (user_id, slug, label) VALUES ($1, $2, $3) RETURNING id`,
      [USER_ID, `stress-tag-${i}`, `Stress Tag ${i}`]
    );
    tagIds.push(t.rows[0].id);
  }

  // N empresas: attendee + registration + primary delegate + tags
  // Bulk approach con transacción única para velocidad
  await withTransaction(pool, async (client) => {
    for (let i = 0; i < N; i++) {
      const a = await client.query(
        `INSERT INTO events.attendees (user_id,email,name,organization)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [USER_ID, `stress-${i}@test`, `Delegate ${i}`, `Empresa ${i}`]
      );
      const r = await client.query(
        `INSERT INTO events.registrations (event_id,attendee_id,user_id,ticket_type,status,custom_fields)
         VALUES ($1,$2,$3,'rueda','confirmed',$4::jsonb) RETURNING id`,
        [eventId, a.rows[0].id, USER_ID, JSON.stringify({ company_name: `Empresa ${i}` })]
      );
      const d = await client.query(
        `INSERT INTO events.rn_delegates (registration_id,full_name,email,is_primary,can_manage_team,accepted_at)
         VALUES ($1,$2,$3,TRUE,TRUE,NOW()) RETURNING id`,
        [r.rows[0].id, `Delegate ${i}`, `stress-${i}@test`]
      );

      const offers  = rngPick(tagIds, TAGS_PER_COMPANY);
      const demands = rngPick(tagIds, TAGS_PER_COMPANY);
      for (const t of offers) {
        await client.query(
          `INSERT INTO events.rn_registration_tags (registration_id, tag_id, kind) VALUES ($1,$2,'offer') ON CONFLICT DO NOTHING`,
          [r.rows[0].id, t]
        );
      }
      for (const t of demands) {
        await client.query(
          `INSERT INTO events.rn_registration_tags (registration_id, tag_id, kind) VALUES ($1,$2,'demand') ON CONFLICT DO NOTHING`,
          [r.rows[0].id, t]
        );
      }
      regs.push({ regId: r.rows[0].id, delegateId: d.rows[0].id });
    }
  });

  // Rounds
  for (let i = 0; i < ROUNDS; i++) {
    await pool.query(
      `INSERT INTO events.rn_rounds (event_id,round_number,kind,starts_at,ends_at)
       VALUES ($1,$2,'meeting', NOW() + ($3 || ' minutes')::interval, NOW() + ($4 || ' minutes')::interval)`,
      [eventId, i + 1, String(i * 25), String(i * 25 + 20)]
    );
  }
  // Tables
  for (let i = 0; i < TABLES; i++) {
    await pool.query(
      `INSERT INTO events.rn_tables (event_id,label,display_order) VALUES ($1,$2,$3)`,
      [eventId, `T${String(i + 1).padStart(3, '0')}`, i]
    );
  }

  const dt = Date.now() - t0;
  console.log(`[seed] ${N} empresas + ${ROUNDS} rondas + ${TABLES} mesas + ${TAG_UNIVERSE} tags · ${dt}ms`);
}

async function runSolverAndMeasure() {
  console.log(`\n─── Solver pre-evento (greedy 5-fases) ───`);
  const t0 = Date.now();
  const result = await withTransaction(pool, async (client) => {
    return solver.runPreEvent(client, { eventId, dryRun: false, manualMeetings: [] });
  });
  const dt = Date.now() - t0;
  console.log(`  ok=${result.ok} · ${dt}ms`);
  if (!result.ok) { console.log('  errors=', result.errors); return; }
  console.log(`  meetings_total=${result.stats.meetings_total}`);
  console.log(`  rounds_effective=${result.stats.total_rounds_effective}`);
  console.log(`  by_origin=${JSON.stringify(result.stats.by_origin || {})}`);
  console.log(`  by_round=${JSON.stringify(result.stats.by_round || {}).slice(0, 200)}`);
  return { result, dt };
}

async function validateInvariants() {
  console.log(`\n─── Invariantes ───`);
  // 1. Cero double-booking: ninguna empresa en 2 meetings en la misma ronda
  const dupes = await pool.query(
    `SELECT round_id, reg_id, COUNT(*) AS c FROM (
       SELECT round_id, company_a_id AS reg_id FROM events.rn_meetings WHERE event_id=$1
       UNION ALL
       SELECT round_id, company_b_id AS reg_id FROM events.rn_meetings WHERE event_id=$1
     ) x GROUP BY round_id, reg_id HAVING COUNT(*)>1`,
    [eventId]
  );
  console.log(`  double_booking_rows=${dupes.rowCount} ${dupes.rowCount === 0 ? '✅' : '❌'}`);
  if (dupes.rowCount > 0) console.log('    muestras:', dupes.rows.slice(0, 3));

  // 2. UNIQUE table/round respetado (lo garantiza el idx pero verifico)
  const dupTables = await pool.query(
    `SELECT round_id, table_id, COUNT(*) c FROM events.rn_meetings WHERE event_id=$1
     GROUP BY round_id, table_id HAVING COUNT(*)>1`,
    [eventId]
  );
  console.log(`  mesa/ronda duplicados=${dupTables.rowCount} ${dupTables.rowCount === 0 ? '✅' : '❌'}`);

  // 3. Cobertura: cuántas empresas tienen al menos 1 meeting
  const cov = await pool.query(
    `SELECT COUNT(DISTINCT reg) AS c FROM (
       SELECT company_a_id AS reg FROM events.rn_meetings WHERE event_id=$1
       UNION
       SELECT company_b_id FROM events.rn_meetings WHERE event_id=$1
     ) x`,
    [eventId]
  );
  const covered = cov.rows[0].c;
  console.log(`  cobertura empresas con ≥1 meeting=${covered}/${N} (${(covered / N * 100).toFixed(1)}%)`);

  // 4. Avg meetings por empresa
  const avg = await pool.query(
    `SELECT AVG(c)::numeric(10,2) AS a, MIN(c), MAX(c) FROM (
       SELECT reg, COUNT(*) c FROM (
         SELECT company_a_id reg FROM events.rn_meetings WHERE event_id=$1
         UNION ALL
         SELECT company_b_id FROM events.rn_meetings WHERE event_id=$1
       ) GROUP BY reg) x`,
    [eventId]
  );
  console.log(`  meetings/empresa avg=${avg.rows[0].a}  min=${avg.rows[0].min}  max=${avg.rows[0].max}`);

  // 5. Avg tag_overlap_score
  const score = await pool.query(
    `SELECT AVG(tag_overlap_score)::numeric(10,2) AS a, MIN(tag_overlap_score), MAX(tag_overlap_score)
       FROM events.rn_meetings WHERE event_id=$1`,
    [eventId]
  );
  console.log(`  score avg=${score.rows[0].a}  min=${score.rows[0].min}  max=${score.rows[0].max}`);

  // 6. Rondas efectivamente ocupadas vs vacías (compactación)
  const perRound = await pool.query(
    `SELECT round_number, COUNT(m.id) c
       FROM events.rn_rounds r
       LEFT JOIN events.rn_meetings m ON m.round_id = r.id
      WHERE r.event_id = $1
      GROUP BY round_number ORDER BY round_number`,
    [eventId]
  );
  const dist = perRound.rows.map(r => `R${r.round_number}:${r.c}`).join(' ');
  console.log(`  dist por ronda: ${dist}`);
  const emptyMid = perRound.rows.findIndex((r, i) =>
    r.c === 0 && perRound.rows.slice(i + 1).some(x => x.c > 0));
  console.log(`  compactación (no hay ronda vacía en medio): ${emptyMid === -1 ? '✅' : `❌ ronda ${perRound.rows[emptyMid].round_number} vacía con reuniones después`}`);
}

async function runtimeTest() {
  console.log(`\n─── Runtime: 80% check-in random, abrir ronda 1 ───`);
  const sample = regs.filter(() => Math.random() < 0.8);
  for (const r of sample) {
    await pool.query(
      `INSERT INTO events.rn_checkins (event_id,delegate_id,method) VALUES ($1,$2,'self') ON CONFLICT DO NOTHING`,
      [eventId, r.delegateId]
    );
  }
  console.log(`  checked_in=${sample.length}/${N}`);

  const rd = await pool.query(
    `SELECT id FROM events.rn_rounds WHERE event_id=$1 ORDER BY round_number LIMIT 1`,
    [eventId]
  );
  const t0 = Date.now();
  const res = await withTransaction(pool, async (client) =>
    solver.runRuntimeRound(client, { eventId, roundId: rd.rows[0].id })
  );
  const dt = Date.now() - t0;
  console.log(`  runtime round1 · deferred=${res.deferred_count} · ${dt}ms`);
}

async function main() {
  try {
    await seed();
    await runSolverAndMeasure();
    await validateInvariants();
    await runtimeTest();
  } catch (err) {
    console.error('[fatal]', err);
    process.exitCode = 1;
  }
  await cleanup();
  await pool.end();
}

main();
