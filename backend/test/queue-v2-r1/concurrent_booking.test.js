'use strict';
// ── Concurrency §4.3 tests 1-2: booking simultáneo ──────────────────────────
// Test 1: 10 requests al mismo slot → exactamente 1 gana (201) + 9 reciben 409
// Test 2: 10 requests a slots distintos → los 10 ganan (201)
// ─────────────────────────────────────────────────────────────────────────────

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  pool, BRANCH_ID, SVC_ID, apiPost, futureSlot, cleanAppts,
} = require('./helpers/testDb');

// ── Test 1: 10 concurrent al mismo slot → 1 ganador + 9 con 409 ──
test('concurrent booking — mismo slot: exactamente 1 gana, 9 reciben 409', async (t) => {
  const scheduled_at = futureSlot(60, 10); // +60 días, 10:00 UTC

  const requests = Array.from({ length: 10 }, (_, i) =>
    apiPost('/api/queue/appointments', {
      branch_id:        BRANCH_ID,
      service_id:       SVC_ID,
      client_name:      `Concurrent Test ${i + 1}`,
      client_phone:     '+57 300 1111111',
      client_id_number: `CONC${String(i + 1).padStart(8, '0')}`,
      scheduled_at,
      origin:           'admin',
    })
  );

  const results = await Promise.all(requests);

  const winners = results.filter(r => r.status === 201);
  const losers  = results.filter(r => r.status === 409);
  const others  = results.filter(r => r.status !== 201 && r.status !== 409);

  assert.equal(others.length, 0,
    `Respuestas inesperadas: ${JSON.stringify(others.map(r => r.status))}`);
  assert.equal(winners.length, 1,
    `Exactamente 1 ganador esperado, recibidos: ${winners.length}`);
  assert.equal(losers.length, 9,
    `Exactamente 9 perdedores esperados, recibidos: ${losers.length}`);
  losers.forEach(l => assert.equal(l.body.code, 'SLOT_TAKEN'));

  const winnerId = winners[0].body.id;
  t.after(() => cleanAppts([winnerId]));
});

// ── Test 2: 10 concurrent a slots distintos → todos ganan ────
test('concurrent booking — slots distintos del mismo servicio: todos ganan', async (t) => {
  const createdIds = [];
  // Usar slots distintos (+61 días, horas 09-18)
  const requests = Array.from({ length: 10 }, (_, i) =>
    apiPost('/api/queue/appointments', {
      branch_id:        BRANCH_ID,
      service_id:       SVC_ID,
      client_name:      `Multi Slot ${i + 1}`,
      client_phone:     '+57 300 2222222',
      client_id_number: `MSLOT${String(i + 1).padStart(7, '0')}`,
      scheduled_at:     futureSlot(61, 9 + i), // horas 09..18
      origin:           'admin',
    })
  );

  const results = await Promise.all(requests);

  const winners = results.filter(r => r.status === 201);
  const losers  = results.filter(r => r.status !== 201);

  assert.equal(losers.length, 0,
    `No debe haber fallos: ${JSON.stringify(losers.map(r => ({ s: r.status, c: r.body.code })))}`);
  assert.equal(winners.length, 10, 'Los 10 deben ganar');

  winners.forEach(w => createdIds.push(w.body.id));
  t.after(() => cleanAppts(createdIds));
});

process.on('exit', () => pool.end().catch(() => {}));
