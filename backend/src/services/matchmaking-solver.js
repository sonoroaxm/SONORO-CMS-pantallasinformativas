// Rueda de Negocios v1 — Solver greedy re-entrante
// Framework: docs/EVENTS-RUEDA-NEGOCIOS-FRAMEWORK.md §4
// Fase: E-RN-3
//
// Fase pre-evento (5 pasos):
//   1. Pre-colocación inmutable  (requests aceptados)   origin='requested' locked=true
//   2. Pre-colocación manual     (reuniones fijadas UI) origin='manual'    locked=true/false
//   3. Colocación algorítmica    (score por tag overlap) origin='matched'  locked=false
//   4. Compactación de huecos    (empuja hacia rondas iniciales, respeta locked)
//   5. Estimar total_rounds_effective y persistir en events.config.matchmaking
//
// Fase runtime (re-entrant por ronda, invocado al abrir ronda):
//   - requested+locked se queda scheduled hasta no_show
//   - matched/manual con faltante → status='deferred', slot libre
//   - Re-emparejar presentes del pool diferido
//
// Dependencias: cero. Node.js puro + queries vía `client` del transaction.
'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// Carga de inputs
// ──────────────────────────────────────────────────────────────────────────────
async function loadInputs(client, eventId) {
  const ev = await client.query(
    `SELECT id, config, timezone FROM events.events WHERE id = $1`, [eventId]
  );
  if (ev.rowCount === 0) {
    const e = new Error('Evento no encontrado'); e.httpStatus = 404; throw e;
  }
  const cfg = ev.rows[0].config || {};
  const mm  = cfg.matchmaking || {};

  const regs = (await client.query(
    `SELECT r.id, r.custom_fields->>'company_name' AS company_name
       FROM events.registrations r
      WHERE r.event_id = $1 AND r.ticket_type = 'rueda' AND r.status != 'cancelled'`,
    [eventId]
  )).rows;

  const tables = (await client.query(
    `SELECT id, label, zone_id FROM events.rn_tables
      WHERE event_id = $1 AND active = TRUE
      ORDER BY display_order, label`,
    [eventId]
  )).rows;

  const rounds = (await client.query(
    `SELECT id, round_number, kind FROM events.rn_rounds
      WHERE event_id = $1 AND kind = 'meeting'
      ORDER BY round_number`,
    [eventId]
  )).rows;

  // Tags por registration — kind: offer|demand
  const tagRows = (await client.query(
    `SELECT rt.registration_id, rt.tag_id, rt.kind
       FROM events.rn_registration_tags rt
       JOIN events.registrations r ON r.id = rt.registration_id
      WHERE r.event_id = $1`,
    [eventId]
  )).rows;
  const tagsByReg = new Map(); // regId -> {offer:Set, demand:Set}
  for (const t of tagRows) {
    if (!tagsByReg.has(t.registration_id)) {
      tagsByReg.set(t.registration_id, { offer: new Set(), demand: new Set() });
    }
    tagsByReg.get(t.registration_id)[t.kind].add(t.tag_id);
  }

  // Anclas registration_id → table_id
  const anchors = new Map();
  for (const a of (await client.query(
    `SELECT ra.registration_id, ra.table_id
       FROM events.rn_registration_anchors ra
       JOIN events.registrations r ON r.id = ra.registration_id
      WHERE r.event_id = $1`,
    [eventId]
  )).rows) {
    anchors.set(a.registration_id, a.table_id);
  }

  // Blocklist bidireccional → Set("a|b" ordenado)
  const blocklist = new Set();
  for (const b of (await client.query(
    `SELECT b.registration_id AS a, b.blocked_registration_id AS c
       FROM events.rn_blocklist b
       JOIN events.registrations r ON r.id = b.registration_id
      WHERE r.event_id = $1`,
    [eventId]
  )).rows) {
    const [x, y] = [b.a, b.c].sort();
    blocklist.add(`${x}|${y}`);
  }

  // Requests aceptados (orden FIFO por responded_at)
  // Filtra requests cuyas empresas estén cancelled (JOIN con registrations activas).
  const requests = (await client.query(
    `SELECT mr.id, mr.from_registration_id, mr.to_registration_id, mr.responded_at
       FROM events.rn_meeting_requests mr
       JOIN events.registrations rf ON rf.id = mr.from_registration_id AND rf.status != 'cancelled'
       JOIN events.registrations rt ON rt.id = mr.to_registration_id   AND rt.status != 'cancelled'
      WHERE mr.event_id = $1 AND mr.status = 'accepted'
        AND mr.from_registration_id <> mr.to_registration_id
      ORDER BY mr.responded_at ASC NULLS LAST, mr.created_at ASC`,
    [eventId]
  )).rows;

  return {
    cfg, mm, regs, tables, rounds, tagsByReg, anchors, blocklist, requests,
    threshold: (typeof mm.default_tag_overlap_threshold === 'number')
      ? mm.default_tag_overlap_threshold : 1,
    matchingMode: mm.matching_mode || 'tags',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Score tag overlap: |A.demand ∩ B.offer| + |A.offer ∩ B.demand|
// ──────────────────────────────────────────────────────────────────────────────
function scorePair(tagsA, tagsB) {
  if (!tagsA || !tagsB) return 0;
  let n = 0;
  for (const t of tagsA.demand) if (tagsB.offer.has(t)) n++;
  for (const t of tagsA.offer)  if (tagsB.demand.has(t)) n++;
  return n;
}

function pairKey(a, b) {
  const [x, y] = [a, b].sort();
  return `${x}|${y}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Grid state: ocupación por (round_index, table_index) + agenda por reg
// ──────────────────────────────────────────────────────────────────────────────
class Grid {
  constructor({ rounds, tables, anchors, blocklist }) {
    this.rounds  = rounds;
    this.tables  = tables;
    this.anchors = anchors;
    this.blocklist = blocklist;
    this.R = rounds.length;
    this.T = tables.length;
    // ocupacion[r][t] = regId | null
    this.occ = Array.from({ length: this.R }, () => new Array(this.T).fill(null));
    // regBusy[r] = Set(regId) para lookup O(1)
    this.regBusy = Array.from({ length: this.R }, () => new Set());
    // pairs ya programados
    this.pairsDone = new Set();
    // meetings a persistir
    this.meetings = [];
  }

  tableIndexById(tableId) {
    return this.tables.findIndex(t => t.id === tableId);
  }

  // Busca slot libre respetando anclas y ocupación
  findSlot(regA, regB) {
    const anchA = this.anchors.get(regA);
    const anchB = this.anchors.get(regB);
    if (anchA && anchB && anchA !== anchB) return null; // ambas ancladas distintas → imposible
    const anchoredTable = anchA || anchB || null;

    for (let r = 0; r < this.R; r++) {
      if (this.regBusy[r].has(regA) || this.regBusy[r].has(regB)) continue;
      if (anchoredTable) {
        const ti = this.tableIndexById(anchoredTable);
        if (ti < 0) continue;
        if (this.occ[r][ti] === null) return { r, t: ti };
        continue;
      }
      for (let t = 0; t < this.T; t++) {
        if (this.occ[r][t] !== null) continue;
        return { r, t };
      }
    }
    return null;
  }

  place(regA, regB, origin, locked, score) {
    const slot = this.findSlot(regA, regB);
    if (!slot) return null;
    this.occ[slot.r][slot.t] = { a: regA, b: regB };
    this.regBusy[slot.r].add(regA);
    this.regBusy[slot.r].add(regB);
    this.pairsDone.add(pairKey(regA, regB));
    const m = {
      round_id: this.rounds[slot.r].id,
      table_id: this.tables[slot.t].id,
      company_a_id: regA,
      company_b_id: regB,
      origin,
      locked,
      tag_overlap_score: score || 0,
    };
    this.meetings.push(m);
    return m;
  }

  // Fuerza una mesa específica (uso: manual con table_id elegido). Devuelve null si colisiona.
  placeAt(regA, regB, tableId, origin, locked) {
    const ti = this.tableIndexById(tableId);
    if (ti < 0) return null;
    for (let r = 0; r < this.R; r++) {
      if (this.occ[r][ti] !== null) continue;
      if (this.regBusy[r].has(regA) || this.regBusy[r].has(regB)) continue;
      this.occ[r][ti] = { a: regA, b: regB };
      this.regBusy[r].add(regA);
      this.regBusy[r].add(regB);
      this.pairsDone.add(pairKey(regA, regB));
      const m = { round_id: this.rounds[r].id, table_id: tableId,
        company_a_id: regA, company_b_id: regB, origin, locked, tag_overlap_score: 0 };
      this.meetings.push(m);
      return m;
    }
    return null;
  }

  // Paso 4: compactación — intenta adelantar reuniones no locked a rondas iniciales
  compact() {
    for (let r = 1; r < this.R; r++) {
      for (let t = 0; t < this.T; t++) {
        const cell = this.occ[r][t];
        if (!cell) continue;
        const m = this.meetings.find(x =>
          x.round_id === this.rounds[r].id && x.table_id === this.tables[t].id
        );
        if (!m || m.locked) continue;
        // Si alguna empresa tiene ancla, respetarla al compactar (no mover a mesa distinta)
        const anchA = this.anchors.get(cell.a);
        const anchB = this.anchors.get(cell.b);
        if (anchA && anchB && anchA !== anchB) continue;
        const forcedTable = anchA || anchB || null;
        // Buscar primera ronda anterior libre para ambos
        for (let r2 = 0; r2 < r; r2++) {
          if (this.regBusy[r2].has(cell.a) || this.regBusy[r2].has(cell.b)) continue;
          let t2 = -1;
          if (forcedTable) {
            const ti = this.tableIndexById(forcedTable);
            if (ti >= 0 && this.occ[r2][ti] === null) t2 = ti;
          } else if (this.occ[r2][t] === null) {
            t2 = t;
          } else {
            for (let tt = 0; tt < this.T; tt++) {
              if (this.occ[r2][tt] === null) { t2 = tt; break; }
            }
          }
          if (t2 < 0) continue;
          // Mover
          this.occ[r2][t2] = cell;
          this.regBusy[r2].add(cell.a);
          this.regBusy[r2].add(cell.b);
          this.occ[r][t] = null;
          this.regBusy[r].delete(cell.a);
          this.regBusy[r].delete(cell.b);
          m.round_id = this.rounds[r2].id;
          m.table_id = this.tables[t2].id;
          break;
        }
      }
    }
  }

  // Última ronda con alguna reunión
  maxRoundNumber() {
    for (let r = this.R - 1; r >= 0; r--) {
      for (let t = 0; t < this.T; t++) if (this.occ[r][t]) return this.rounds[r].round_number;
    }
    return 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Validaciones de setup antes de correr
// ──────────────────────────────────────────────────────────────────────────────
function validateSetup(input) {
  const errors = [];
  if (input.rounds.length === 0) errors.push('No hay rondas definidas (POST /rounds/plan)');
  if (input.tables.length === 0) errors.push('No hay mesas activas');
  if (input.regs.length < 2) errors.push('Se requieren al menos 2 empresas inscritas');
  return errors;
}

// ──────────────────────────────────────────────────────────────────────────────
// Pre-event solver
// ──────────────────────────────────────────────────────────────────────────────
async function runPreEvent(client, { eventId, dryRun = false, manualMeetings = [] }) {
  const input = await loadInputs(client, eventId);
  const errors = validateSetup(input);
  if (errors.length) return { ok: false, errors };

  const grid = new Grid(input);
  const unschedulable = [];

  // Paso 0 — Seed grid con meetings locked ya persistidas (re-entrant preserva sagradas).
  // Sin esto, un re-run tras reset genera doble-booking vs. requested existentes.
  const existingLocked = (await client.query(
    `SELECT round_id, table_id, company_a_id, company_b_id
       FROM events.rn_meetings WHERE event_id=$1 AND locked = TRUE`,
    [eventId]
  )).rows;
  const roundIdx = new Map(input.rounds.map((r, i) => [r.id, i]));
  const tableIdx = new Map(input.tables.map((t, i) => [t.id, i]));
  for (const m of existingLocked) {
    const r = roundIdx.get(m.round_id);
    const t = tableIdx.get(m.table_id);
    if (r == null || t == null) continue;
    grid.occ[r][t] = { a: m.company_a_id, b: m.company_b_id };
    grid.regBusy[r].add(m.company_a_id);
    grid.regBusy[r].add(m.company_b_id);
    grid.pairsDone.add(pairKey(m.company_a_id, m.company_b_id));
  }

  // Paso 1 — requests aceptados → origin='requested' locked=true
  for (const req of input.requests) {
    if (input.blocklist.has(pairKey(req.from_registration_id, req.to_registration_id))) {
      unschedulable.push({ request_id: req.id, reason: 'blocklist' });
      continue;
    }
    if (grid.pairsDone.has(pairKey(req.from_registration_id, req.to_registration_id))) continue;
    const placed = grid.place(
      req.from_registration_id, req.to_registration_id,
      'requested', true,
      scorePair(input.tagsByReg.get(req.from_registration_id),
                input.tagsByReg.get(req.to_registration_id))
    );
    if (!placed) unschedulable.push({ request_id: req.id, reason: 'no_slot' });
  }

  // Paso 2 — manual (ya validado por caller: {company_a_id, company_b_id, table_id?, locked?})
  for (const m of manualMeetings) {
    if (!m.company_a_id || !m.company_b_id || m.company_a_id === m.company_b_id) continue;
    if (input.blocklist.has(pairKey(m.company_a_id, m.company_b_id))) continue;
    if (grid.pairsDone.has(pairKey(m.company_a_id, m.company_b_id))) continue;
    if (m.table_id) {
      const placed = grid.placeAt(m.company_a_id, m.company_b_id, m.table_id, 'manual', !!m.locked);
      if (!placed) unschedulable.push({ manual: m, reason: 'no_slot_at_table' });
    } else {
      const placed = grid.place(m.company_a_id, m.company_b_id, 'manual', !!m.locked, 0);
      if (!placed) unschedulable.push({ manual: m, reason: 'no_slot' });
    }
  }

  // Paso 3 — colocación algorítmica (skip si manual_only)
  if (input.matchingMode !== 'manual_only') {
    const candidates = [];
    for (let i = 0; i < input.regs.length; i++) {
      for (let j = i + 1; j < input.regs.length; j++) {
        const a = input.regs[i].id, b = input.regs[j].id;
        const key = pairKey(a, b);
        if (grid.pairsDone.has(key)) continue;
        if (input.blocklist.has(key)) continue;
        const score = scorePair(input.tagsByReg.get(a), input.tagsByReg.get(b));
        if (score < input.threshold) continue;
        candidates.push({ a, b, score });
      }
    }
    candidates.sort((x, y) => y.score - x.score);
    for (const c of candidates) {
      grid.place(c.a, c.b, 'matched', false, c.score);
    }
  }

  // Paso 4 — compactación
  grid.compact();

  // Paso 5 — total rondas efectivas
  const totalRounds = grid.maxRoundNumber();

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      stats: {
        meetings_total: grid.meetings.length,
        requested: grid.meetings.filter(m => m.origin === 'requested').length,
        manual:    grid.meetings.filter(m => m.origin === 'manual').length,
        matched:   grid.meetings.filter(m => m.origin === 'matched').length,
        total_rounds_effective: totalRounds,
        unschedulable_count: unschedulable.length,
      },
      unschedulable,
    };
  }

  // Persistir
  // Borrar meetings previas no locked (preservar locked=TRUE del productor si re-run)
  await client.query(
    `DELETE FROM events.rn_meetings WHERE event_id = $1 AND locked = FALSE`, [eventId]
  );

  for (const m of grid.meetings) {
    await client.query(
      `INSERT INTO events.rn_meetings
         (event_id, round_id, table_id, company_a_id, company_b_id,
          origin, locked, tag_overlap_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (round_id, table_id) DO NOTHING`,
      [eventId, m.round_id, m.table_id, m.company_a_id, m.company_b_id,
       m.origin, m.locked, m.tag_overlap_score]
    );
  }

  // Persistir total_rounds_estimated en config
  await client.query(
    `UPDATE events.events
        SET config = jsonb_set(
          COALESCE(config, '{}'::jsonb),
          '{matchmaking,total_rounds_estimated}',
          to_jsonb($2::int)
        )
      WHERE id = $1`,
    [eventId, totalRounds]
  );

  return {
    ok: true,
    stats: {
      meetings_total: grid.meetings.length + existingLocked.length,
      requested: grid.meetings.filter(m => m.origin === 'requested').length + existingLocked.length,
      manual:    grid.meetings.filter(m => m.origin === 'manual').length,
      matched:   grid.meetings.filter(m => m.origin === 'matched').length,
      total_rounds_effective: totalRounds,
      unschedulable_count: unschedulable.length,
    },
    unschedulable,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Reset — borra solo las no locked (preserva requested + manual-locked)
// ──────────────────────────────────────────────────────────────────────────────
async function resetMeetings(client, eventId) {
  const r = await client.query(
    `DELETE FROM events.rn_meetings WHERE event_id = $1 AND locked = FALSE`,
    [eventId]
  );
  return { deleted: r.rowCount };
}

// ──────────────────────────────────────────────────────────────────────────────
// Runtime re-entrant por ronda (minimal stub — E-RN-5 lo expande con sockets)
// Decide status según presencia de delegados primarios y marca deferred.
// ──────────────────────────────────────────────────────────────────────────────
async function runRuntimeRound(client, { eventId, roundId }) {
  // Presencia a nivel registration: ≥1 delegado de la registration con fila en events.rn_checkins.
  const meetings = (await client.query(
    `SELECT m.id, m.company_a_id, m.company_b_id, m.origin, m.locked, m.status
       FROM events.rn_meetings m
      WHERE m.event_id = $1 AND m.round_id = $2`,
    [eventId, roundId]
  )).rows;

  const regs = new Set();
  for (const m of meetings) { regs.add(m.company_a_id); regs.add(m.company_b_id); }
  const absent = new Set();
  if (regs.size > 0) {
    const presentRows = (await client.query(
      `SELECT DISTINCT d.registration_id
         FROM events.rn_checkins c
         JOIN events.rn_delegates d ON d.id = c.delegate_id
        WHERE c.event_id = $1
          AND d.registration_id = ANY($2::uuid[])`,
      [eventId, Array.from(regs)]
    )).rows;
    const present = new Set(presentRows.map(r => r.registration_id));
    for (const r of regs) if (!present.has(r)) absent.add(r);
  }

  const deferred = [];
  for (const m of meetings) {
    if (m.status !== 'scheduled') continue;
    const aOk = !absent.has(m.company_a_id);
    const bOk = !absent.has(m.company_b_id);
    if (aOk && bOk) continue;

    if (m.origin === 'requested' && m.locked) {
      // requested sagrado — se queda scheduled, no re-agenda.
      continue;
    }
    // matched/manual con faltante → defer + liberar slot
    await client.query(
      `UPDATE events.rn_meetings SET status = 'deferred' WHERE id = $1`, [m.id]
    );
    deferred.push({ id: m.id, missing_a: !aOk, missing_b: !bOk });
  }

  return { ok: true, deferred_count: deferred.length, deferred };
}

module.exports = {
  runPreEvent,
  resetMeetings,
  runRuntimeRound,
  // exports internos útiles para tests
  _scorePair: scorePair,
  _pairKey: pairKey,
};
