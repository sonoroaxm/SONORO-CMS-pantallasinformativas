'use strict';
// ── Integration §4.2 tests 1-3: POST /api/queue/appointments ──────────────────
// Test 1: happy path → 201 + snapshot de precio + evento shape
// Test 2: mismo slot dos veces → 2do recibe 409 SLOT_TAKEN
// Test 3: slot dentro de time_block → 409 BLOCKED
// ─────────────────────────────────────────────────────────────────────────────

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  pool, BRANCH_ID, SVC_ID, apiPost, futureSlot, cleanAppts, cleanBlocks,
} = require('./helpers/testDb');

const BASE_APPT = {
  branch_id:        BRANCH_ID,
  service_id:       SVC_ID,
  client_name:      'Test QV2R1',
  client_phone:     '+57 300 0000001',
  client_id_number: 'TEST00000001',
  origin:           'admin',
};

// ── Test 1: happy path ────────────────────────────────────────
test('POST /appointments — happy path: 201 + precio snapshot inmutable', async (t) => {
  const scheduled_at = futureSlot(40, 10);
  const { status, body } = await apiPost('/api/queue/appointments', {
    ...BASE_APPT,
    scheduled_at,
    client_id_number: 'TEST00000011',
  });

  assert.equal(status, 201, `Esperado 201, recibido ${status}: ${JSON.stringify(body)}`);
  assert.ok(body.id, 'Debe retornar id');
  assert.equal(body.status, 'pending');
  assert.equal(body.branch_id, BRANCH_ID);
  assert.equal(body.service_id, SVC_ID);
  // Snapshot de precio capturado (Consulta General = 60000 COP)
  assert.equal(typeof body.price_at_booking, 'number', 'price_at_booking debe ser number');
  assert.equal(body.price_at_booking, 60000);
  assert.equal(body.currency_at_booking, 'COP');

  t.after(() => cleanAppts([body.id]));
});

// ── Test 2: doble booking mismo slot → 409 SLOT_TAKEN ────────
test('POST /appointments — slot doble → 409 SLOT_TAKEN', async (t) => {
  const scheduled_at = futureSlot(41, 11);
  const payload = { ...BASE_APPT, scheduled_at, client_id_number: 'TEST00000021' };

  const first = await apiPost('/api/queue/appointments', payload);
  assert.equal(first.status, 201, `1er POST debe ser 201: ${JSON.stringify(first.body)}`);

  const second = await apiPost('/api/queue/appointments', {
    ...payload, client_id_number: 'TEST00000022',
  });
  assert.equal(second.status, 409, `2do POST debe ser 409: ${JSON.stringify(second.body)}`);
  assert.equal(second.body.code, 'SLOT_TAKEN');

  t.after(() => cleanAppts([first.body.id]));
});

// ── Test 3: slot cubierto por time_block → 409 BLOCKED ───────
test('POST /appointments — slot dentro de time_block → 409 BLOCKED', async (t) => {
  // Crear bloqueo vía API
  const blockStart = futureSlot(42, 9);
  const blockEnd   = futureSlot(42, 11);
  const blkRes = await apiPost('/api/queue/time-blocks', {
    branch_id: BRANCH_ID,
    service_id: SVC_ID,
    starts_at: blockStart,
    ends_at:   blockEnd,
    reason:    'test block',
  });
  assert.equal(blkRes.status, 201, `time-block creation failed: ${JSON.stringify(blkRes.body)}`);
  const blockId = blkRes.body.id;

  // Intentar crear cita dentro del bloqueo
  const { status, body } = await apiPost('/api/queue/appointments', {
    ...BASE_APPT,
    scheduled_at:     futureSlot(42, 10),
    client_id_number: 'TEST00000031',
  });
  assert.equal(status, 409, `Esperado 409 BLOCKED: ${JSON.stringify(body)}`);
  assert.equal(body.code, 'BLOCKED');

  t.after(() => cleanBlocks([blockId]));
});

// Cierra pool al terminar todos los tests de este archivo
process.on('exit', () => pool.end().catch(() => {}));
