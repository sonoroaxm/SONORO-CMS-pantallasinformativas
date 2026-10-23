// Stress CONFLICTIVO Rueda de Negocios — N=200 (tope framework) con 10 escenarios reales.
// Prueba el solver bajo presión: populares, aislados, peer-requests, blocklist, anchors,
// manual-locked, status mixtos, manual_only mode, reset + re-run.
'use strict';

process.env.JWT_SECRET = 'conflict-rn';
process.env.SMTP_HOST  = '';

const { Pool } = require('pg');
const { withTransaction } = require('../src/db/withTransaction');

const pool = new Pool({
  host: 'localhost', port: 5433, database: 'cms_signage_rntest',
  user: 'postgres', password: 'smarttv_dev', max: 10,
});
global.pool = pool;
global.io = { to: () => ({ emit: () => {} }) };

require.cache[require.resolve('../src/services/email.js')] = {
  exports: new Proxy({}, { get: () => async () => ({ ok: true }) }),
};

const solver = require('../src/services/matchmaking-solver');

const USER_ID = 1;
const N = 200;
const ROUNDS = 20;
const TABLES = 100;              // N/2
const TAG_UNIVERSE = 60;         // 40 "mainstream" + 20 "nicho" (últimos)
const MAINSTREAM = 40;

const SLUG = 'conflict-rn-n' + N;

let eventId;
const regs = []; // {regId, delegateId, idx}
const tagIds = [];
let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`    ✅ ${label}`); }
  else { fail++; console.log(`    ❌ ${label}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}

function pickK(arr, k) {
  const copy = [...arr];
  const out = [];
  while (out.length < k && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}
function rand(n) { return Math.floor(Math.random() * n); }

async function cleanup() {
  await pool.query(`DELETE FROM events.events WHERE slug=$1`, [SLUG]);
  await pool.query(`DELETE FROM events.attendees WHERE email LIKE 'conflict-%@test'`);
  await pool.query(`DELETE FROM events.rn_tags WHERE user_id=$1 AND slug LIKE 'conflict-tag-%'`, [USER_ID]);
}

async function seedBase() {
  const ev = await pool.query(
    `INSERT INTO events.events (user_id,name,slug,status,timezone,starts_at,ends_at,config)
     VALUES ($1,'Conflict RN',$2,'live','America/Bogota',NOW(),NOW()+INTERVAL '1 day',
       '{"event_type":"matchmaking","matchmaking":{"matching_mode":"tags","visibility":"all","default_tag_overlap_threshold":1}}'::jsonb)
     RETURNING id`,
    [USER_ID, SLUG]
  );
  eventId = ev.rows[0].id;

  for (let i = 0; i < TAG_UNIVERSE; i++) {
    const t = await pool.query(
      `INSERT INTO events.rn_tags (user_id,slug,label) VALUES ($1,$2,$3) RETURNING id`,
      [USER_ID, `conflict-tag-${i}`, `Conflict Tag ${i}`]
    );
    tagIds.push(t.rows[0].id);
  }
  // mainstream pool = tags 0..39, nicho pool = tags 40..59
  const mainstream = tagIds.slice(0, MAINSTREAM);
  const nicho = tagIds.slice(MAINSTREAM);

  await withTransaction(pool, async (client) => {
    for (let i = 0; i < N; i++) {
      // CONFLICTOS DE PERFIL:
      // 0..2 → "populares" (super-conectados): 8 tags mainstream offer + 8 demand
      // 3..5 → "aislados" (nicho puro): tags del pool nicho únicamente
      // 6..9 → "pending" (status=pending → excluidos por solver)
      // 10..14 → "cancelled" (excluidos)
      // 15..214 (resto) → distribución normal 4+4
      let status = 'confirmed', offers = [], demands = [];
      if (i >= 0 && i <= 2) {
        offers  = pickK(mainstream, 8);
        demands = pickK(mainstream, 8);
      } else if (i >= 3 && i <= 5) {
        offers  = pickK(nicho, 4);
        demands = pickK(nicho, 4);
      } else if (i >= 6 && i <= 9) {
        status = 'pending'; // excluido? status != cancelled… vamos a ver
        offers = pickK(mainstream, 4); demands = pickK(mainstream, 4);
      } else if (i >= 10 && i <= 14) {
        status = 'cancelled';
        offers = pickK(mainstream, 4); demands = pickK(mainstream, 4);
      } else {
        offers  = pickK(mainstream, 4);
        demands = pickK(mainstream, 4);
      }

      const a = await client.query(
        `INSERT INTO events.attendees (user_id,email,name,organization)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [USER_ID, `conflict-${i}@test`, `Delegate ${i}`, `Empresa ${i}`]
      );
      const r = await client.query(
        `INSERT INTO events.registrations (event_id,attendee_id,user_id,ticket_type,status,custom_fields)
         VALUES ($1,$2,$3,'rueda',$4,$5::jsonb) RETURNING id`,
        [eventId, a.rows[0].id, USER_ID, status, JSON.stringify({ company_name: `Empresa ${i}` })]
      );
      const d = await client.query(
        `INSERT INTO events.rn_delegates (registration_id,full_name,email,is_primary,can_manage_team,accepted_at)
         VALUES ($1,$2,$3,TRUE,TRUE,NOW()) RETURNING id`,
        [r.rows[0].id, `Delegate ${i}`, `conflict-${i}@test`]
      );
      for (const t of offers)  await client.query(`INSERT INTO events.rn_registration_tags VALUES ($1,$2,'offer')  ON CONFLICT DO NOTHING`, [r.rows[0].id, t]);
      for (const t of demands) await client.query(`INSERT INTO events.rn_registration_tags VALUES ($1,$2,'demand') ON CONFLICT DO NOTHING`, [r.rows[0].id, t]);
      regs.push({ regId: r.rows[0].id, delegateId: d.rows[0].id, idx: i, status });
    }
  });

  // Rounds + tables
  for (let i = 0; i < ROUNDS; i++) {
    await pool.query(
      `INSERT INTO events.rn_rounds (event_id,round_number,kind,starts_at,ends_at)
       VALUES ($1,$2,'meeting', NOW() + ($3 || ' minutes')::interval, NOW() + ($4 || ' minutes')::interval)`,
      [eventId, i + 1, String(i * 25), String(i * 25 + 20)]
    );
  }
  for (let i = 0; i < TABLES; i++) {
    await pool.query(
      `INSERT INTO events.rn_tables (event_id,label,display_order) VALUES ($1,$2,$3)`,
      [eventId, `T${String(i + 1).padStart(3, '0')}`, i]
    );
  }
}

async function seedConflicts() {
  const confirmedRegs = regs.filter(r => r.status === 'confirmed');

  // CONFLICTO 1: 50 peer-requests ACEPTADOS (sagrados · origin='requested' · locked)
  //   Random de confirmed, 50 pares únicos
  const requestPairs = [];
  const used = new Set();
  while (requestPairs.length < 50) {
    const a = confirmedRegs[rand(confirmedRegs.length)];
    const b = confirmedRegs[rand(confirmedRegs.length)];
    if (a.regId === b.regId) continue;
    const k = [a.regId, b.regId].sort().join('|');
    if (used.has(k)) continue;
    used.add(k);
    requestPairs.push([a, b]);
  }
  for (const [a, b] of requestPairs) {
    await pool.query(
      `INSERT INTO events.rn_meeting_requests (event_id, from_registration_id, to_registration_id, status, responded_at)
       VALUES ($1,$2,$3,'accepted', NOW() - INTERVAL '1 hour')`,
      [eventId, a.regId, b.regId]
    );
  }

  // CONFLICTO 2: 30 blocklist bidirectional (empresa bloqueada mutuamente)
  //   Pares aleatorios de confirmed. Insertar en ambas direcciones.
  const blockCount = 30;
  const blocked = new Set();
  for (let i = 0; i < blockCount; i++) {
    const a = confirmedRegs[rand(confirmedRegs.length)];
    const b = confirmedRegs[rand(confirmedRegs.length)];
    if (a.regId === b.regId) continue;
    const k = [a.regId, b.regId].sort().join('|');
    if (blocked.has(k)) continue;
    blocked.add(k);
    await pool.query(
      `INSERT INTO events.rn_blocklist (registration_id, blocked_registration_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [a.regId, b.regId]
    );
    await pool.query(
      `INSERT INTO events.rn_blocklist (registration_id, blocked_registration_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [b.regId, a.regId]
    );
  }

  // CONFLICTO 3: 10 empresas con anchor a mesas específicas
  //   Mesas 1-10 ancladas a empresas idx=20..29
  const anchorsSeed = confirmedRegs.filter(r => r.idx >= 20 && r.idx <= 29);
  const tableRows = (await pool.query(
    `SELECT id FROM events.rn_tables WHERE event_id=$1 ORDER BY display_order LIMIT 10`, [eventId]
  )).rows;
  for (let i = 0; i < anchorsSeed.length && i < tableRows.length; i++) {
    await pool.query(
      `INSERT INTO events.rn_registration_anchors (registration_id, table_id, assigned_by)
       VALUES ($1,$2,'manual') ON CONFLICT DO NOTHING`,
      [anchorsSeed[i].regId, tableRows[i].id]
    );
  }

  return { requestPairs, blockedPairs: blocked, anchorCount: Math.min(anchorsSeed.length, tableRows.length) };
}

async function runScenarioA(ctx) {
  console.log('\n═══ ESCENARIO A — Solver completo (todos los conflictos activos) ═══');
  const t0 = Date.now();
  const result = await withTransaction(pool, async (client) =>
    solver.runPreEvent(client, { eventId, dryRun: false, manualMeetings: [] })
  );
  const dt = Date.now() - t0;
  console.log(`  solver.ok=${result.ok} · ${dt}ms`);
  if (!result.ok) { console.log('  errors=', result.errors); return; }
  console.log(`  meetings_total=${result.stats.meetings_total} · rounds_eff=${result.stats.total_rounds_effective}`);

  // INVARIANTES
  const dupes = await pool.query(
    `SELECT 1 FROM (SELECT round_id, company_a_id reg FROM events.rn_meetings WHERE event_id=$1
                    UNION ALL
                    SELECT round_id, company_b_id FROM events.rn_meetings WHERE event_id=$1) x
     GROUP BY round_id, reg HAVING COUNT(*)>1 LIMIT 1`, [eventId]
  );
  ok('cero double-booking', dupes.rowCount === 0);

  const dupTab = await pool.query(
    `SELECT 1 FROM events.rn_meetings WHERE event_id=$1 GROUP BY round_id, table_id HAVING COUNT(*)>1 LIMIT 1`,
    [eventId]
  );
  ok('cero mesa/ronda duplicada', dupTab.rowCount === 0);

  // CONFLICTO 1: todas las requested fueron honradas (origin='requested' + locked)
  const requested = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 AND origin='requested'`, [eventId]
  );
  ok(`requested respetadas (${requested.rows[0].c}/${ctx.requestPairs.length})`, requested.rows[0].c === ctx.requestPairs.length, requested.rows[0]);

  const reqLocked = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 AND origin='requested' AND locked=TRUE`, [eventId]
  );
  ok('todas las requested están locked', reqLocked.rows[0].c === requested.rows[0].c);

  // CONFLICTO 2: blocklist bidirectional — NUNCA se genera un meeting entre pares bloqueados
  //   (excepto si origin='requested' que es sagrado — pero D-RN-6 dice que requested manda)
  let violatedBlock = 0;
  for (const k of ctx.blockedPairs) {
    const [a, b] = k.split('|');
    const bad = await pool.query(
      `SELECT origin FROM events.rn_meetings WHERE event_id=$1
         AND ((company_a_id=$2 AND company_b_id=$3) OR (company_a_id=$3 AND company_b_id=$2))`,
      [eventId, a, b]
    );
    // Permitido si origin='requested' (D-RN-6: sagrado)
    const violation = bad.rows.filter(r => r.origin !== 'requested').length;
    if (violation > 0) violatedBlock++;
  }
  ok(`blocklist respetada (${ctx.blockedPairs.size - violatedBlock}/${ctx.blockedPairs.size} pares bloqueados sin match no-requested)`, violatedBlock === 0);

  // CONFLICTO 3: anchors — las empresas ancladas aparecen SOLO en sus mesas ancla
  const anchorCheck = await pool.query(
    `SELECT a.registration_id, a.table_id,
            COUNT(m.id) FILTER (WHERE m.table_id = a.table_id)                   AS at_anchor,
            COUNT(m.id) FILTER (WHERE m.table_id <> a.table_id)                  AS off_anchor
       FROM events.rn_registration_anchors a
       JOIN events.registrations r ON r.id = a.registration_id
       LEFT JOIN events.rn_meetings m
         ON m.event_id = r.event_id AND (m.company_a_id = a.registration_id OR m.company_b_id = a.registration_id)
      WHERE r.event_id = $1
      GROUP BY a.registration_id, a.table_id`,
    [eventId]
  );
  const anchorOffCount = anchorCheck.rows.filter(r => Number(r.off_anchor) > 0).length;
  ok(`anchors respetados (${anchorCheck.rowCount - anchorOffCount}/${anchorCheck.rowCount} siempre en su mesa)`, anchorOffCount === 0,
     anchorCheck.rows.filter(r => Number(r.off_anchor) > 0).slice(0, 3));

  // CONFLICTO 4: status=cancelled NUNCA aparece en meetings
  const cancIds = regs.filter(r => r.status === 'cancelled').map(r => r.regId);
  const cancInMeetings = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings
       WHERE event_id=$1 AND (company_a_id = ANY($2::uuid[]) OR company_b_id = ANY($2::uuid[]))`,
    [eventId, cancIds]
  );
  ok(`status=cancelled excluidas (0 meetings · reales=${cancInMeetings.rows[0].c})`, cancInMeetings.rows[0].c === 0);

  // CONFLICTO 5: status=pending — solver debería incluirlas (filtro es != 'cancelled')
  const pendIds = regs.filter(r => r.status === 'pending').map(r => r.regId);
  const pendInMeetings = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings
       WHERE event_id=$1 AND (company_a_id = ANY($2::uuid[]) OR company_b_id = ANY($2::uuid[]))`,
    [eventId, pendIds]
  );
  console.log(`    ℹ pending (status) presentes en meetings=${pendInMeetings.rows[0].c} (solver filtra solo status!='cancelled')`);

  // POPULARES vs AISLADOS
  const pop = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings
       WHERE event_id=$1 AND (company_a_id = ANY($2::uuid[]) OR company_b_id = ANY($2::uuid[]))`,
    [eventId, [regs[0].regId, regs[1].regId, regs[2].regId]]
  );
  console.log(`    ℹ populares (3): total meetings=${pop.rows[0].c} (max teórico=${3 * ROUNDS}=60)`);

  const iso = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings
       WHERE event_id=$1 AND (company_a_id = ANY($2::uuid[]) OR company_b_id = ANY($2::uuid[]))`,
    [eventId, [regs[3].regId, regs[4].regId, regs[5].regId]]
  );
  console.log(`    ℹ aislados nicho (3): total meetings=${iso.rows[0].c} (típicamente bajo porque match limitado)`);

  // Avg + score + cobertura
  const stats = await pool.query(
    `SELECT COUNT(DISTINCT reg)::int covered FROM (
       SELECT company_a_id reg FROM events.rn_meetings WHERE event_id=$1
       UNION
       SELECT company_b_id FROM events.rn_meetings WHERE event_id=$1) x`,
    [eventId]
  );
  const confirmedCount = regs.filter(r => r.status === 'confirmed').length;
  console.log(`    ℹ cobertura ${stats.rows[0].covered}/${confirmedCount} confirmed (incluye pending si matched)`);

  const scoreDist = await pool.query(
    `SELECT origin, COUNT(*)::int c, AVG(tag_overlap_score)::numeric(10,2) avg_score
       FROM events.rn_meetings WHERE event_id=$1 GROUP BY origin ORDER BY origin`, [eventId]
  );
  console.log('    ℹ por origen:', scoreDist.rows.map(r => `${r.origin}=${r.c} (score=${r.avg_score})`).join(' · '));
}

async function runScenarioB() {
  console.log('\n═══ ESCENARIO B — Reset + re-run (requested debe sobrevivir) ═══');
  const beforeTotal = (await pool.query(`SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1`, [eventId])).rows[0].c;
  const beforeReq = (await pool.query(`SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 AND origin='requested'`, [eventId])).rows[0].c;

  const resetRes = await withTransaction(pool, async (c) => solver.resetMeetings(c, eventId));
  console.log(`  reset.deleted=${resetRes.deleted}`);

  const afterReq = (await pool.query(`SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 AND origin='requested'`, [eventId])).rows[0].c;
  ok(`reset preserva requested (${beforeReq}→${afterReq})`, afterReq === beforeReq);

  const t0 = Date.now();
  const result2 = await withTransaction(pool, async (c) => solver.runPreEvent(c, { eventId, dryRun: false, manualMeetings: [] }));
  const dt2 = Date.now() - t0;
  console.log(`  re-run.ok=${result2.ok} · ${dt2}ms · meetings=${result2.stats.meetings_total}`);
  ok('re-run genera ~mismo volumen', Math.abs(result2.stats.meetings_total - beforeTotal) < 50, { before: beforeTotal, after: result2.stats.meetings_total });
}

async function runScenarioC() {
  console.log('\n═══ ESCENARIO C — matching_mode=manual_only (fase algorítmica salteada) ═══');
  await pool.query(
    `UPDATE events.events SET config = jsonb_set(config, '{matchmaking,matching_mode}', '"manual_only"') WHERE id=$1`,
    [eventId]
  );
  await withTransaction(pool, async (c) => solver.resetMeetings(c, eventId));
  const beforeReq = (await pool.query(`SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 AND origin='requested'`, [eventId])).rows[0].c;

  const t0 = Date.now();
  const result = await withTransaction(pool, async (c) => solver.runPreEvent(c, { eventId, dryRun: false, manualMeetings: [] }));
  const dt = Date.now() - t0;
  console.log(`  solver.ok=${result.ok} · ${dt}ms · total=${result.stats.meetings_total}`);
  const byOrigin = await pool.query(
    `SELECT origin, COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 GROUP BY origin`, [eventId]
  );
  const byOriginMap = Object.fromEntries(byOrigin.rows.map(r => [r.origin, r.c]));
  console.log(`  by_origin=${JSON.stringify(byOriginMap)}`);
  ok('manual_only: sin origin=matched', !byOriginMap.matched, byOriginMap);
  ok('manual_only: requested preservado', byOriginMap.requested === beforeReq, { expected: beforeReq, got: byOriginMap.requested });

  // restaurar
  await pool.query(
    `UPDATE events.events SET config = jsonb_set(config, '{matchmaking,matching_mode}', '"tags"') WHERE id=$1`,
    [eventId]
  );
}

async function main() {
  const T0 = Date.now();
  try {
    await cleanup();
    console.log(`[conflicts] seed base N=${N} rounds=${ROUNDS} tables=${TABLES} tags=${TAG_UNIVERSE}`);
    const ts = Date.now();
    await seedBase();
    console.log(`  base seed · ${Date.now() - ts}ms`);
    const tc = Date.now();
    const ctx = await seedConflicts();
    console.log(`  conflicts seeded: ${ctx.requestPairs.length} peer-reqs · ${ctx.blockedPairs.size} blocks · ${ctx.anchorCount} anchors · ${Date.now() - tc}ms`);

    await runScenarioA(ctx);
    await runScenarioB();
    await runScenarioC();
  } catch (err) {
    console.error('[fatal]', err);
    fail++;
  }
  console.log(`\n═══ TOTAL: ${pass} ✅ · ${fail} ❌ · wall=${Date.now() - T0}ms ═══`);
  await cleanup();
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main();
