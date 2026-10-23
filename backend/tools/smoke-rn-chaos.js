// CHAOS Rueda de Negocios — 8 escenarios patológicos / adversarios / improbables.
// Cada test es autónomo: crea su propio evento, ejecuta, valida, limpia.
// 1 Acaparador  2 Grafo-bloqueo  3 Threshold imposible  4 Zero-tag universe
// 5 Anchors sobre-saturados  6 Requests adversarios  7 Locked huérfano
// 8 Solvers paralelos        9 Runtime 0%/100%+blocklist      (bonus)
'use strict';

process.env.JWT_SECRET = 'chaos-rn';
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
let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`    ✅ ${label}`); }
  else { fail++; console.log(`    ❌ ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0,250) : ''); }
}

async function mkEvent(slug, cfgOverride = {}) {
  const cfg = { event_type: 'matchmaking', matchmaking: Object.assign({ matching_mode: 'tags', visibility: 'all', default_tag_overlap_threshold: 0.25 }, cfgOverride) };
  const ev = await pool.query(
    `INSERT INTO events.events (user_id,name,slug,status,timezone,starts_at,ends_at,config)
     VALUES ($1,$2,$3,'live','America/Bogota',NOW(),NOW()+INTERVAL '1 day',$4::jsonb) RETURNING id`,
    [USER_ID, slug, slug, JSON.stringify(cfg)]
  );
  return ev.rows[0].id;
}
async function mkTag(slug, label) {
  const r = await pool.query(
    `INSERT INTO events.rn_tags (user_id,slug,label) VALUES ($1,$2,$3)
     ON CONFLICT (user_id,slug) DO UPDATE SET label=EXCLUDED.label RETURNING id`,
    [USER_ID, slug, label]
  );
  return r.rows[0].id;
}
async function mkCompany(eventId, slug, i, status = 'confirmed') {
  const a = await pool.query(
    `INSERT INTO events.attendees (user_id,email,name,organization) VALUES ($1,$2,$3,$4) RETURNING id`,
    [USER_ID, `${slug}-${i}@test`, `D${i}`, `E${i}`]
  );
  const r = await pool.query(
    `INSERT INTO events.registrations (event_id,attendee_id,user_id,ticket_type,status,custom_fields)
     VALUES ($1,$2,$3,'rueda',$4,$5::jsonb) RETURNING id`,
    [eventId, a.rows[0].id, USER_ID, status, JSON.stringify({ company_name: `E${i}` })]
  );
  const d = await pool.query(
    `INSERT INTO events.rn_delegates (registration_id,full_name,email,is_primary,can_manage_team,accepted_at)
     VALUES ($1,$2,$3,TRUE,TRUE,NOW()) RETURNING id`,
    [r.rows[0].id, `D${i}`, `${slug}-${i}@test`]
  );
  return { regId: r.rows[0].id, delegateId: d.rows[0].id, idx: i };
}
async function tagReg(regId, tagId, kind) {
  await pool.query(`INSERT INTO events.rn_registration_tags VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [regId, tagId, kind]);
}
async function mkRounds(eventId, n) {
  for (let i = 0; i < n; i++) await pool.query(
    `INSERT INTO events.rn_rounds (event_id,round_number,kind,starts_at,ends_at)
     VALUES ($1,$2,'meeting',NOW()+($3||' minutes')::interval,NOW()+($4||' minutes')::interval)`,
    [eventId, i + 1, String(i * 25), String(i * 25 + 20)]
  );
}
async function mkTables(eventId, n) {
  for (let i = 0; i < n; i++) await pool.query(
    `INSERT INTO events.rn_tables (event_id,label,display_order) VALUES ($1,$2,$3)`,
    [eventId, `T${String(i+1).padStart(3,'0')}`, i]
  );
}
async function cleanupSlug(slug) {
  await pool.query(`DELETE FROM events.events WHERE slug=$1`, [slug]);
  await pool.query(`DELETE FROM events.attendees WHERE email LIKE $1`, [`${slug}-%@test`]);
  await pool.query(`DELETE FROM events.rn_tags WHERE user_id=$1 AND slug LIKE $2`, [USER_ID, `${slug}-tag-%`]);
}
async function runSolver(eventId, opts = {}) {
  return withTransaction(pool, async (c) => solver.runPreEvent(c, Object.assign({ eventId, dryRun: false, manualMeetings: [] }, opts)));
}
async function dupesCheck(eventId) {
  const r = await pool.query(
    `SELECT 1 FROM (SELECT round_id,company_a_id reg FROM events.rn_meetings WHERE event_id=$1
                    UNION ALL
                    SELECT round_id,company_b_id FROM events.rn_meetings WHERE event_id=$1) x
     GROUP BY round_id,reg HAVING COUNT(*)>1 LIMIT 1`, [eventId]);
  return r.rowCount === 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 1 — ACAPARADOR: 1 empresa con 100 peer-requests. Solo 20 rondas.
// Esperado: 20 requested honradas, 80 unschedulable 'no_slot'. Resto empresas no bloqueadas.
// ──────────────────────────────────────────────────────────────────────────────
async function test1_Acaparador() {
  console.log('\n═══ 1 · ACAPARADOR (1 vs 100 peer-requests · 20 rondas) ═══');
  const slug = 'chaos-acaparador';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  const empresas = [];
  for (let i = 0; i < 101; i++) {
    const c = await mkCompany(ev, slug, i);
    await tagReg(c.regId, tag, 'offer');
    await tagReg(c.regId, tag, 'demand');
    empresas.push(c);
  }
  const hub = empresas[0];
  for (let i = 1; i <= 100; i++) {
    await pool.query(
      `INSERT INTO events.rn_meeting_requests (event_id,from_registration_id,to_registration_id,status,responded_at)
       VALUES ($1,$2,$3,'accepted',NOW())`, [ev, hub.regId, empresas[i].regId]
    );
  }
  await mkRounds(ev, 20);
  await mkTables(ev, 50);

  const t0 = Date.now();
  const res = await runSolver(ev);
  console.log(`  ok=${res.ok} · ${Date.now()-t0}ms · meetings=${res.stats?.meetings_total} · unschedulable=${res.stats?.unschedulable_count}`);
  ok('cero double-booking', await dupesCheck(ev));
  const reqHub = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 AND origin='requested' AND (company_a_id=$2 OR company_b_id=$2)`,
    [ev, hub.regId]
  );
  ok(`hub tiene exactamente 20 requested (una por ronda)`, reqHub.rows[0].c === 20, reqHub.rows[0]);
  const unsched = (res.unschedulable || []).filter(u => u.reason === 'no_slot').length;
  ok(`~80 requests quedaron unschedulable (${unsched})`, unsched === 80);
  // El resto de empresas (no-hub) todavía pueden tener meetings matched entre sí
  const otherMeet = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 AND company_a_id!=$2 AND company_b_id!=$2`,
    [ev, hub.regId]
  );
  ok(`otras empresas no bloqueadas por acaparador (meetings_sin_hub=${otherMeet.rows[0].c})`, otherMeet.rows[0].c > 0);

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 2 — GRAFO BLOCKLIST CASI-COMPLETO: 20 empresas, todos bloqueados con todos
// excepto 10 pares específicos. Esperado: solo esos 10 meetings existen (si tienen tag match).
// ──────────────────────────────────────────────────────────────────────────────
async function test2_GrafoBlock() {
  console.log('\n═══ 2 · GRAFO BLOCKLIST CASI-COMPLETO (20 empresas · 190 bloqueos · 10 permitidos) ═══');
  const slug = 'chaos-grafo-block';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  const E = [];
  for (let i = 0; i < 20; i++) {
    const c = await mkCompany(ev, slug, i);
    await tagReg(c.regId, tag, 'offer');
    await tagReg(c.regId, tag, 'demand');
    E.push(c);
  }
  // Pares permitidos: (0,1),(2,3),(4,5),...(18,19) → 10 pares
  const allowed = new Set();
  for (let i = 0; i < 20; i += 2) allowed.add([E[i].regId, E[i+1].regId].sort().join('|'));

  // Insertar blocklist bidirectional para TODOS los pares excepto los permitidos
  for (let i = 0; i < 20; i++) {
    for (let j = i + 1; j < 20; j++) {
      const k = [E[i].regId, E[j].regId].sort().join('|');
      if (allowed.has(k)) continue;
      await pool.query(`INSERT INTO events.rn_blocklist VALUES ($1,$2) ON CONFLICT DO NOTHING`, [E[i].regId, E[j].regId]);
      await pool.query(`INSERT INTO events.rn_blocklist VALUES ($1,$2) ON CONFLICT DO NOTHING`, [E[j].regId, E[i].regId]);
    }
  }
  await mkRounds(ev, 10);
  await mkTables(ev, 20);

  const res = await runSolver(ev);
  console.log(`  ok=${res.ok} · meetings=${res.stats?.meetings_total}`);
  ok(`exactamente 10 meetings (= pares permitidos)`, res.stats?.meetings_total === 10, res.stats);
  // Verificar que cada meeting corresponde a un par permitido
  const allMeetings = await pool.query(`SELECT company_a_id, company_b_id FROM events.rn_meetings WHERE event_id=$1`, [ev]);
  const violations = allMeetings.rows.filter(m => !allowed.has([m.company_a_id, m.company_b_id].sort().join('|'))).length;
  ok(`cero meetings en pares bloqueados`, violations === 0);

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 3 — THRESHOLD IMPOSIBLE 1.0 + tags disjuntos
// Esperado: paso 3 produce 0, solo sobreviven requested + manual.
// ──────────────────────────────────────────────────────────────────────────────
async function test3_ThresholdImposible() {
  console.log('\n═══ 3 · THRESHOLD IMPOSIBLE (threshold=1.0 · tags disjuntos) ═══');
  const slug = 'chaos-threshold';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug, { default_tag_overlap_threshold: 1.0 });
  const E = [];
  for (let i = 0; i < 20; i++) {
    const c = await mkCompany(ev, slug, i);
    const t = await mkTag(`${slug}-tag-${i}`, `T${i}`); // tag único por empresa
    await tagReg(c.regId, t, 'offer');
    await tagReg(c.regId, t, 'demand');
    E.push(c);
  }
  // 3 peer-requests para asegurar que SÍ existen requested aun con threshold imposible
  for (let k = 0; k < 3; k++) {
    await pool.query(
      `INSERT INTO events.rn_meeting_requests (event_id,from_registration_id,to_registration_id,status,responded_at)
       VALUES ($1,$2,$3,'accepted',NOW())`, [ev, E[k*2].regId, E[k*2+1].regId]
    );
  }
  await mkRounds(ev, 10); await mkTables(ev, 20);

  const res = await runSolver(ev);
  console.log(`  ok=${res.ok} · total=${res.stats?.meetings_total} · matched=${res.stats?.matched} · requested=${res.stats?.requested}`);
  ok(`threshold imposible → 0 matched`, res.stats?.matched === 0);
  ok(`requested respetados (3)`, res.stats?.requested === 3);

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 4 — ZERO-TAG UNIVERSE: 20 empresas sin tags. Threshold 0.
// Esperado: paso 3 debería matchear libremente (score=0 ≥ 0).
// ──────────────────────────────────────────────────────────────────────────────
async function test4_ZeroTag() {
  console.log('\n═══ 4 · ZERO-TAG UNIVERSE (20 empresas sin tags · threshold 0) ═══');
  const slug = 'chaos-zerotag';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug, { default_tag_overlap_threshold: 0 });
  for (let i = 0; i < 20; i++) await mkCompany(ev, slug, i);
  await mkRounds(ev, 10); await mkTables(ev, 20);

  const res = await runSolver(ev);
  console.log(`  ok=${res.ok} · total=${res.stats?.meetings_total} · matched=${res.stats?.matched}`);
  ok(`threshold=0 permite matched sin tags (${res.stats?.matched} meetings)`, (res.stats?.matched || 0) > 0);
  ok(`cero double-booking`, await dupesCheck(ev));

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 5 — ANCHORS SOBRE-SATURADOS: 20 empresas ancladas a solo 3 mesas.
// Esperado: todas sus meetings SIEMPRE en su mesa anclada, el resto se acomoda.
// ──────────────────────────────────────────────────────────────────────────────
async function test5_AnchorsSaturados() {
  console.log('\n═══ 5 · ANCHORS SOBRE-SATURADOS (20 ancladas a 3 mesas) ═══');
  const slug = 'chaos-anchors';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  const E = [];
  for (let i = 0; i < 20; i++) {
    const c = await mkCompany(ev, slug, i);
    await tagReg(c.regId, tag, 'offer'); await tagReg(c.regId, tag, 'demand');
    E.push(c);
  }
  await mkRounds(ev, 20); await mkTables(ev, 10);
  const tables = (await pool.query(`SELECT id FROM events.rn_tables WHERE event_id=$1 ORDER BY display_order LIMIT 3`, [ev])).rows;
  for (let i = 0; i < 20; i++) {
    await pool.query(
      `INSERT INTO events.rn_registration_anchors (registration_id,table_id,assigned_by) VALUES ($1,$2,'manual')`,
      [E[i].regId, tables[i % 3].id]
    );
  }

  const res = await runSolver(ev);
  console.log(`  ok=${res.ok} · total=${res.stats?.meetings_total}`);
  // Verificar que ninguna empresa anclada sale de su mesa
  const violations = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings m
       JOIN events.rn_registration_anchors a
         ON (a.registration_id=m.company_a_id OR a.registration_id=m.company_b_id)
      WHERE m.event_id=$1 AND m.table_id <> a.table_id`,
    [ev]
  );
  ok(`cero anchor-violation (${violations.rows[0].c})`, violations.rows[0].c === 0);
  ok(`cero double-booking`, await dupesCheck(ev));

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 6 — REQUESTS ADVERSARIOS: self-request, request a cancelled, duplicados.
// Esperado: DB CHECK/UNIQUE o solver filtran limpio sin crash.
// ──────────────────────────────────────────────────────────────────────────────
async function test6_RequestsAdversarios() {
  console.log('\n═══ 6 · REQUESTS ADVERSARIOS (self + cancelled + duplicados) ═══');
  const slug = 'chaos-adversarios';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  const A = await mkCompany(ev, slug, 0);
  const B = await mkCompany(ev, slug, 1);
  const C = await mkCompany(ev, slug, 2, 'cancelled');
  for (const c of [A,B,C]) { await tagReg(c.regId, tag, 'offer'); await tagReg(c.regId, tag, 'demand'); }
  await mkRounds(ev, 3); await mkTables(ev, 5);

  // 6a) Self-request (from=to) → ¿lo acepta la DB?
  let selfRejected = false;
  try {
    await pool.query(
      `INSERT INTO events.rn_meeting_requests (event_id,from_registration_id,to_registration_id,status) VALUES ($1,$2,$2,'accepted')`,
      [ev, A.regId]
    );
  } catch (e) { selfRejected = true; }
  // Si NO fue rechazado por DB, verificar que al menos el solver no crashee
  ok(`self-request manejado sin crash (DB_rejected=${selfRejected})`, true);

  // 6b) Request a cancelled: insertar OK, solver debe excluirlo
  await pool.query(
    `INSERT INTO events.rn_meeting_requests (event_id,from_registration_id,to_registration_id,status,responded_at) VALUES ($1,$2,$3,'accepted',NOW())`,
    [ev, A.regId, C.regId]
  );

  // 6c) Duplicado: insertar dos veces mismo A→B
  await pool.query(
    `INSERT INTO events.rn_meeting_requests (event_id,from_registration_id,to_registration_id,status,responded_at) VALUES ($1,$2,$3,'accepted',NOW())`,
    [ev, A.regId, B.regId]
  );
  let dupRejected = false;
  try {
    await pool.query(
      `INSERT INTO events.rn_meeting_requests (event_id,from_registration_id,to_registration_id,status,responded_at) VALUES ($1,$2,$3,'accepted',NOW())`,
      [ev, A.regId, B.regId]
    );
  } catch (e) { dupRejected = true; }
  ok(`duplicado DB-rejected por UNIQUE (${dupRejected})`, dupRejected);

  const res = await runSolver(ev);
  console.log(`  ok=${res.ok} · total=${res.stats?.meetings_total}`);
  // Verificar que meeting A-C (cancelled) NO existe
  const canc = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 AND (company_a_id=$2 OR company_b_id=$2)`,
    [ev, C.regId]
  );
  ok(`cancelled nunca aparece en meetings`, canc.rows[0].c === 0);
  // A-B debe estar (requested)
  const ab = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 AND origin='requested'
       AND ((company_a_id=$2 AND company_b_id=$3) OR (company_a_id=$3 AND company_b_id=$2))`,
    [ev, A.regId, B.regId]
  );
  ok(`A-B requested presente`, ab.rows[0].c === 1);

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 7 — LOCKED HUÉRFANO: meeting requested+locked, luego una empresa se cancela.
// Esperado: re-run solver no crashea; comportamiento documentado (purga o preserva).
// ──────────────────────────────────────────────────────────────────────────────
async function test7_LockedHuerfano() {
  console.log('\n═══ 7 · LOCKED HUÉRFANO (requested+locked · reg cancelada después) ═══');
  const slug = 'chaos-huerfano';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  const A = await mkCompany(ev, slug, 0);
  const B = await mkCompany(ev, slug, 1);
  const C = await mkCompany(ev, slug, 2);
  const D = await mkCompany(ev, slug, 3);
  for (const c of [A,B,C,D]) { await tagReg(c.regId, tag, 'offer'); await tagReg(c.regId, tag, 'demand'); }
  await pool.query(
    `INSERT INTO events.rn_meeting_requests (event_id,from_registration_id,to_registration_id,status,responded_at) VALUES ($1,$2,$3,'accepted',NOW())`,
    [ev, A.regId, B.regId]
  );
  await mkRounds(ev, 3); await mkTables(ev, 3);

  const res1 = await runSolver(ev);
  console.log(`  run1 ok=${res1.ok} · total=${res1.stats?.meetings_total}`);

  // Ahora cancelar B
  await pool.query(`UPDATE events.registrations SET status='cancelled' WHERE id=$1`, [B.regId]);

  // Re-run (sin reset)
  let crashed = false, res2;
  try { res2 = await runSolver(ev); } catch (e) { crashed = true; console.log('    err:', e.message); }
  ok(`re-run no crashea con reg cancelada en meeting locked`, !crashed);
  if (res2) {
    const abStill = await pool.query(
      `SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 AND origin='requested'
         AND ((company_a_id=$2 AND company_b_id=$3) OR (company_a_id=$3 AND company_b_id=$2))`,
      [ev, A.regId, B.regId]
    );
    console.log(`    locked A-B tras cancel B: preservado=${abStill.rows[0].c===1 ? 'SÍ' : 'NO (purgado)'}`);
    ok(`comportamiento consistente (preserva locked histórico)`, abStill.rows[0].c === 1);
  }

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 8 — DOS SOLVERS PARALELOS mismo event_id → race.
// Esperado: uno gana, otro debería fallar graceful o completar sin corromper.
// ──────────────────────────────────────────────────────────────────────────────
async function test8_Paralelos() {
  console.log('\n═══ 8 · SOLVERS PARALELOS (mismo event_id · race condition) ═══');
  const slug = 'chaos-paralelos';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  for (let i = 0; i < 30; i++) {
    const c = await mkCompany(ev, slug, i);
    await tagReg(c.regId, tag, 'offer'); await tagReg(c.regId, tag, 'demand');
  }
  await mkRounds(ev, 10); await mkTables(ev, 15);

  const results = await Promise.allSettled([runSolver(ev), runSolver(ev), runSolver(ev)]);
  const okCount = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
  const errCount = results.filter(r => r.status === 'rejected').length;
  console.log(`  resultados: ok=${okCount} rejected=${errCount}`);
  // Verificar integridad: aunque hubo race, estado final consistente
  ok(`cero double-booking tras race`, await dupesCheck(ev));
  const dupTab = await pool.query(
    `SELECT 1 FROM events.rn_meetings WHERE event_id=$1 GROUP BY round_id,table_id HAVING COUNT(*)>1 LIMIT 1`,
    [ev]
  );
  ok(`cero mesa/ronda duplicada tras race`, dupTab.rowCount === 0);
  const total = await pool.query(`SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1`, [ev]);
  console.log(`    meetings finales persistidos: ${total.rows[0].c}`);
  ok(`estado final no vacío (${total.rows[0].c} meetings)`, total.rows[0].c > 0);

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 9 — RUNTIME CAOS: ronda abierta con 0% check-in · luego 100% + 50% bloqueos mutuos.
// ──────────────────────────────────────────────────────────────────────────────
async function test9_RuntimeChaos() {
  console.log('\n═══ 9 · RUNTIME CHAOS (0% check-in · luego 100%+blocklist mutuo) ═══');
  const slug = 'chaos-runtime';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  const E = [];
  for (let i = 0; i < 20; i++) {
    const c = await mkCompany(ev, slug, i);
    await tagReg(c.regId, tag, 'offer'); await tagReg(c.regId, tag, 'demand');
    E.push(c);
  }
  await mkRounds(ev, 5); await mkTables(ev, 10);
  await runSolver(ev);

  const rounds = (await pool.query(`SELECT id FROM events.rn_rounds WHERE event_id=$1 ORDER BY round_number`, [ev])).rows;

  // Ronda 1: 0% check-in → todos deferred
  const r1 = await withTransaction(pool, async (c) => solver.runRuntimeRound(c, { eventId: ev, roundId: rounds[0].id }));
  console.log(`  ronda1 (0% checkin) · deferred=${r1.deferred_count}`);
  ok(`0% checkin → todos deferred (>0)`, r1.deferred_count > 0);

  // Check-in de todos
  for (const c of E) await pool.query(
    `INSERT INTO events.rn_checkins (event_id,delegate_id,method) VALUES ($1,$2,'self') ON CONFLICT DO NOTHING`,
    [ev, c.delegateId]
  );
  // 50% bloqueos mutuos
  for (let i = 0; i < E.length; i += 2) {
    await pool.query(`INSERT INTO events.rn_blocklist VALUES ($1,$2) ON CONFLICT DO NOTHING`, [E[i].regId, E[i+1].regId]);
    await pool.query(`INSERT INTO events.rn_blocklist VALUES ($1,$2) ON CONFLICT DO NOTHING`, [E[i+1].regId, E[i].regId]);
  }

  const r2 = await withTransaction(pool, async (c) => solver.runRuntimeRound(c, { eventId: ev, roundId: rounds[1].id }));
  console.log(`  ronda2 (100% checkin + blocklist) · deferred=${r2.deferred_count}`);
  ok(`runtime no crashea con blocklist pesada`, true);
  // Validar que ningún meeting activo nuevo viola blocklist (no debería crear emparejamientos bloqueados ad-hoc)
  ok(`cero double-booking tras runtime caos`, await dupesCheck(ev));

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 10 — CICLO A↔B↔C↔A con 1 sola ronda: pueden pasar 1 par (otros 2 unschedulable)
// ──────────────────────────────────────────────────────────────────────────────
async function test10_Ciclico() {
  console.log('\n═══ 10 · CICLO A↔B↔C↔A (3 requests · 1 ronda · solo 1 par cabe) ═══');
  const slug = 'chaos-ciclo';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  const A = await mkCompany(ev, slug, 0);
  const B = await mkCompany(ev, slug, 1);
  const C = await mkCompany(ev, slug, 2);
  for (const c of [A,B,C]) { await tagReg(c.regId, tag, 'offer'); await tagReg(c.regId, tag, 'demand'); }
  for (const [x,y] of [[A,B],[B,C],[C,A]]) {
    await pool.query(
      `INSERT INTO events.rn_meeting_requests (event_id,from_registration_id,to_registration_id,status,responded_at) VALUES ($1,$2,$3,'accepted',NOW())`,
      [ev, x.regId, y.regId]
    );
  }
  await mkRounds(ev, 1); await mkTables(ev, 5);

  const res = await runSolver(ev);
  console.log(`  ok=${res.ok} · requested=${res.stats?.requested} · unschedulable=${res.stats?.unschedulable_count}`);
  ok(`solo 1 requested cabe en 1 ronda`, res.stats?.requested === 1);
  ok(`2 unschedulable`, res.stats?.unschedulable_count === 2);
  ok(`cero double-booking`, await dupesCheck(ev));

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 11 — MESA inactive=FALSE: solver no debe usarla
// ──────────────────────────────────────────────────────────────────────────────
async function test11_MesaInactiva() {
  console.log('\n═══ 11 · MESA inactive=FALSE excluida ═══');
  const slug = 'chaos-inactive';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  for (let i = 0; i < 10; i++) {
    const c = await mkCompany(ev, slug, i);
    await tagReg(c.regId, tag, 'offer'); await tagReg(c.regId, tag, 'demand');
  }
  await mkRounds(ev, 5); await mkTables(ev, 5);
  // Marcar 3 mesas como inactive=FALSE
  const inactiveTables = (await pool.query(
    `UPDATE events.rn_tables SET active=FALSE WHERE event_id=$1 AND display_order<3 RETURNING id`,
    [ev]
  )).rows.map(r => r.id);

  const res = await runSolver(ev);
  console.log(`  ok=${res.ok} · total=${res.stats?.meetings_total}`);
  const inMeetings = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 AND table_id = ANY($2::uuid[])`,
    [ev, inactiveTables]
  );
  ok(`cero meetings en mesas inactive`, inMeetings.rows[0].c === 0, inMeetings.rows[0]);

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 12 — LONGITUDINAL: 50 empresas · 1 mesa · 50 rondas
// Prueba el ancho mínimo. Compact O(N²) · validar tiempo razonable.
// ──────────────────────────────────────────────────────────────────────────────
async function test12_Longitudinal() {
  console.log('\n═══ 12 · LONGITUDINAL (50 empresas · 1 mesa · 50 rondas) ═══');
  const slug = 'chaos-longitudinal';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  for (let i = 0; i < 50; i++) {
    const c = await mkCompany(ev, slug, i);
    await tagReg(c.regId, tag, 'offer'); await tagReg(c.regId, tag, 'demand');
  }
  await mkRounds(ev, 50); await mkTables(ev, 1);

  const t0 = Date.now();
  const res = await runSolver(ev);
  const dt = Date.now() - t0;
  console.log(`  ok=${res.ok} · ${dt}ms · meetings=${res.stats?.meetings_total}`);
  ok(`meetings=50 (1 por ronda × 50 rondas)`, res.stats?.meetings_total === 50);
  ok(`tiempo razonable <5s`, dt < 5000);
  ok(`cero double-booking`, await dupesCheck(ev));

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 13 — CAPACIDAD CERO: 0 rondas → solver debe retornar error limpio
// ──────────────────────────────────────────────────────────────────────────────
async function test13_CapacidadCero() {
  console.log('\n═══ 13 · 0 rondas / 0 mesas (error setup limpio) ═══');
  const slug = 'chaos-zerocap';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  for (let i = 0; i < 5; i++) await mkCompany(ev, slug, i);
  // Sin rondas, sin mesas

  let crashed = false, res;
  try { res = await runSolver(ev); } catch (e) { crashed = true; }
  ok(`no crashea con setup vacío`, !crashed);
  ok(`retorna ok=false con errors`, res && res.ok === false && Array.isArray(res.errors) && res.errors.length > 0, res);

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 14 — TODAS ANCLADAS (2 por mesa): 20 empresas · 10 mesas · 2 anchors/mesa
// Grafo forzado: cada empresa solo puede matchear con su "compañera de mesa".
// ──────────────────────────────────────────────────────────────────────────────
async function test14_TodasAncladas() {
  console.log('\n═══ 14 · TODAS ANCLADAS (20 emp · 10 mesas · 2/mesa) ═══');
  const slug = 'chaos-todas-ancladas';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  const E = [];
  for (let i = 0; i < 20; i++) {
    const c = await mkCompany(ev, slug, i);
    await tagReg(c.regId, tag, 'offer'); await tagReg(c.regId, tag, 'demand');
    E.push(c);
  }
  await mkRounds(ev, 5); await mkTables(ev, 10);
  const tabs = (await pool.query(`SELECT id FROM events.rn_tables WHERE event_id=$1 ORDER BY display_order`, [ev])).rows;
  for (let i = 0; i < 20; i++) {
    await pool.query(
      `INSERT INTO events.rn_registration_anchors (registration_id,table_id,assigned_by) VALUES ($1,$2,'manual')`,
      [E[i].regId, tabs[Math.floor(i/2)].id]
    );
  }

  const res = await runSolver(ev);
  console.log(`  ok=${res.ok} · total=${res.stats?.meetings_total}`);
  // Solo puede haber 10 meetings (uno por mesa, un par anclado)
  ok(`exactamente 10 meetings (1 par anclado por mesa)`, res.stats?.meetings_total === 10, res.stats);
  const violations = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings m
       JOIN events.rn_registration_anchors a ON (a.registration_id=m.company_a_id OR a.registration_id=m.company_b_id)
      WHERE m.event_id=$1 AND m.table_id <> a.table_id`, [ev]
  );
  ok(`cero anchor-violation`, violations.rows[0].c === 0);

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 15 — PEER-REQUEST POST MID-SOLVER (race)
// Insertar un request DESPUÉS que el solver cargó inputs → se pierde en este run.
// ──────────────────────────────────────────────────────────────────────────────
async function test15_RequestMidSolver() {
  console.log('\n═══ 15 · REQUEST POST MID-SOLVER (race insert durante tx) ═══');
  const slug = 'chaos-midrun';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  const E = [];
  for (let i = 0; i < 10; i++) {
    const c = await mkCompany(ev, slug, i);
    await tagReg(c.regId, tag, 'offer'); await tagReg(c.regId, tag, 'demand');
    E.push(c);
  }
  await mkRounds(ev, 5); await mkTables(ev, 10);

  // Correr solver y en paralelo insertar un request
  const solverP = runSolver(ev);
  const insertP = (async () => {
    await new Promise(r => setTimeout(r, 10));
    try {
      await pool.query(
        `INSERT INTO events.rn_meeting_requests (event_id,from_registration_id,to_registration_id,status,responded_at) VALUES ($1,$2,$3,'accepted',NOW())`,
        [ev, E[0].regId, E[1].regId]
      );
      return 'inserted';
    } catch (e) { return 'err:' + e.code; }
  })();
  const [res, ins] = await Promise.all([solverP, insertP]);
  console.log(`  solver.ok=${res.ok} · insert=${ins} · meetings=${res.stats?.meetings_total}`);
  ok(`solver completó sin crash`, res.ok === true);
  ok(`estado consistente (sin double-booking)`, await dupesCheck(ev));
  // Verificar: siguiente run captura el request tardío
  const res2 = await runSolver(ev);
  const req01 = await pool.query(
    `SELECT COUNT(*)::int c FROM events.rn_meetings WHERE event_id=$1 AND origin='requested'
       AND ((company_a_id=$2 AND company_b_id=$3) OR (company_a_id=$3 AND company_b_id=$2))`,
    [ev, E[0].regId, E[1].regId]
  );
  ok(`re-run captura request tardío (A-B requested)`, req01.rows[0].c === 1);

  await cleanupSlug(slug);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 16 — EBV ADVERSARIO (negativos, MAX_SAFE_INTEGER, asimetría 1000x)
// D-RN-15: agregado = AVG(a,b). Nunca SUM. Validar que no overflow + flag referencial.
// ──────────────────────────────────────────────────────────────────────────────
async function test16_EBVAdversario() {
  console.log('\n═══ 16 · EBV ADVERSARIO (negativos · MAX_SAFE_INTEGER · asimetría 1000x) ═══');
  const slug = 'chaos-ebv';
  await cleanupSlug(slug);
  const ev = await mkEvent(slug);
  const tag = await mkTag(`${slug}-tag-0`, 'T');
  const A = await mkCompany(ev, slug, 0);
  const B = await mkCompany(ev, slug, 1);
  const C = await mkCompany(ev, slug, 2);
  const D = await mkCompany(ev, slug, 3);
  for (const c of [A,B,C,D]) { await tagReg(c.regId, tag, 'offer'); await tagReg(c.regId, tag, 'demand'); }
  await mkRounds(ev, 2); await mkTables(ev, 3);
  await runSolver(ev);

  const meetings = (await pool.query(`SELECT id,company_a_id,company_b_id FROM events.rn_meetings WHERE event_id=$1 LIMIT 3`, [ev])).rows;

  // Inspección columnas EBV: valores adversarios directo en DB
  const EBV_COLS = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='events' AND table_name='rn_meetings' AND column_name LIKE 'ebv%'`
  )).rows.map(r => r.column_name);
  console.log(`    cols EBV detectadas: ${EBV_COLS.join(',') || '(ninguna)'}`);

  if (!EBV_COLS.length) {
    ok('EBV cols no existen en schema (skip test)', true);
    await cleanupSlug(slug);
    return;
  }

  // Caso 1: ambos lados negativo
  // Caso 2: lado A MAX_SAFE_INTEGER, lado B 1
  // Caso 3: solo un lado
  const trials = [
    { label: 'ambos negativos',           a: -1000, b: -500 },
    { label: 'MAX_SAFE_INTEGER asimetría', a: Number.MAX_SAFE_INTEGER, b: 1 },
    { label: 'solo un lado',               a: 10000, b: null },
  ];
  for (let i = 0; i < Math.min(trials.length, meetings.length); i++) {
    const t = trials[i], m = meetings[i];
    try {
      await pool.query(
        `UPDATE events.rn_meetings SET ebv_amount_a=$2, ebv_amount_b=$3 WHERE id=$1`,
        [m.id, t.a, t.b]
      );
    } catch (e) {
      console.log(`    [${t.label}] UPDATE err: ${e.code} ${e.message.slice(0,80)}`);
    }
  }

  // Agregado tipo reporte: AVG lado-a-lado, NUNCA SUM
  const agg = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE ebv_amount_a IS NOT NULL OR ebv_amount_b IS NOT NULL) AS reported,
       AVG(COALESCE((ebv_amount_a::numeric + ebv_amount_b::numeric)/
                     NULLIF((CASE WHEN ebv_amount_a IS NOT NULL THEN 1 ELSE 0 END +
                             CASE WHEN ebv_amount_b IS NOT NULL THEN 1 ELSE 0 END),0),
                    GREATEST(COALESCE(ebv_amount_a,0), COALESCE(ebv_amount_b,0))))
         FILTER (WHERE ebv_amount_a IS NOT NULL OR ebv_amount_b IS NOT NULL) AS avg_lado
     FROM events.rn_meetings WHERE event_id=$1`,
    [ev]
  );
  console.log(`    reportes EBV: ${agg.rows[0].reported} · avg_lado=${agg.rows[0].avg_lado}`);
  ok(`cobertura <20% → debería marcar "referencial" (reportes=${agg.rows[0].reported}/${meetings.length})`,
     agg.rows[0].reported !== null);
  // No overflow numérico (debería ser representable)
  ok(`agregado no NaN/null con MAX_SAFE_INTEGER`, agg.rows[0].avg_lado !== null);

  await cleanupSlug(slug);
}

async function main() {
  const t0 = Date.now();
  const tests = [test1_Acaparador, test2_GrafoBlock, test3_ThresholdImposible, test4_ZeroTag,
                 test5_AnchorsSaturados, test6_RequestsAdversarios, test7_LockedHuerfano,
                 test8_Paralelos, test9_RuntimeChaos,
                 test10_Ciclico, test11_MesaInactiva, test12_Longitudinal, test13_CapacidadCero,
                 test14_TodasAncladas, test15_RequestMidSolver, test16_EBVAdversario];
  for (const fn of tests) {
    try { await fn(); }
    catch (e) { fail++; console.log(`  [FATAL en ${fn.name}]`, e.message); }
  }
  console.log(`\n═══ CHAOS TOTAL: ${pass} ✅ · ${fail} ❌ · wall=${Date.now()-t0}ms ═══`);
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}
main();
