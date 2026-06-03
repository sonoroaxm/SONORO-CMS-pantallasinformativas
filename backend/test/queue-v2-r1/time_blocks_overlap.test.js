'use strict';
// ── Integration §4.2 tests 8-10: solapamiento de time_blocks ─────────────────
// Test 8:  mismo service_id solapando → 2do recibe 409 BLOCKED_SAME_SCOPE
// Test 9:  ambos NULL "todos los servicios" solapando → 409 BLOCKED_SAME_SCOPE
// Test 10: NULL "todos" + específico que solapa → 409 BLOCKED_CROSS_SCOPE
// ─────────────────────────────────────────────────────────────────────────────

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  BRANCH_ID, SVC_ID, apiPost, cleanBlocks,
} = require('./helpers/testDb');

// Ventana fija para overlap tests (fecha fija lejana, no interfiere con hoy)
const T1 = '2026-08-01T13:00:00.000Z';
const T2 = '2026-08-01T14:00:00.000Z';
const T3 = '2026-08-01T15:00:00.000Z';

// ── Test 8: mismo service_id solapando ───────────────────────
test('time_blocks — mismo service_id que solapa → 409 BLOCKED_SAME_SCOPE', async (t) => {
  const first = await apiPost('/api/queue/time-blocks', {
    branch_id: BRANCH_ID, service_id: SVC_ID,
    starts_at: T1, ends_at: T3, reason: 'test-overlap-1a',
  });
  assert.equal(first.status, 201, `1er block debe crearse: ${JSON.stringify(first.body)}`);
  const id1 = first.body.id;

  const second = await apiPost('/api/queue/time-blocks', {
    branch_id: BRANCH_ID, service_id: SVC_ID,
    starts_at: T2, ends_at: T3, reason: 'test-overlap-1b',
  });
  assert.equal(second.status, 409, `2do debe ser 409: ${JSON.stringify(second.body)}`);
  assert.match(second.body.code || second.body.error || '', /SAME_SCOPE|BLOCKED/i);

  t.after(() => cleanBlocks([id1]));
});

// ── Test 9: ambos NULL "todos los servicios" solapando ───────
test('time_blocks — dos bloques NULL "todos" que solapan → 409 BLOCKED_SAME_SCOPE', async (t) => {
  const first = await apiPost('/api/queue/time-blocks', {
    branch_id: BRANCH_ID, service_id: null,
    starts_at: T1, ends_at: T3, reason: 'test-overlap-2a',
  });
  assert.equal(first.status, 201, `1er block (null) debe crearse: ${JSON.stringify(first.body)}`);
  const id1 = first.body.id;

  const second = await apiPost('/api/queue/time-blocks', {
    branch_id: BRANCH_ID, service_id: null,
    starts_at: T2, ends_at: T3, reason: 'test-overlap-2b',
  });
  assert.equal(second.status, 409, `2do debe ser 409: ${JSON.stringify(second.body)}`);
  assert.match(second.body.code || second.body.error || '', /SAME_SCOPE|BLOCKED/i);

  t.after(() => cleanBlocks([id1]));
});

// ── Test 10: NULL "todos" + específico solapando → CROSS_SCOPE ─
test('time_blocks — NULL "todos" + específico que solapa → 409 BLOCKED_CROSS_SCOPE', async (t) => {
  // Crear bloque NULL primero
  const first = await apiPost('/api/queue/time-blocks', {
    branch_id: BRANCH_ID, service_id: null,
    starts_at: T1, ends_at: T3, reason: 'test-overlap-3a',
  });
  assert.equal(first.status, 201, `1er block (null) debe crearse: ${JSON.stringify(first.body)}`);
  const id1 = first.body.id;

  // Intentar crear bloque específico que solapa
  const second = await apiPost('/api/queue/time-blocks', {
    branch_id: BRANCH_ID, service_id: SVC_ID,
    starts_at: T2, ends_at: T3, reason: 'test-overlap-3b',
  });
  assert.equal(second.status, 409, `2do debe ser 409: ${JSON.stringify(second.body)}`);
  assert.match(second.body.code || second.body.error || '', /CROSS_SCOPE|BLOCKED/i);

  t.after(() => cleanBlocks([id1]));
});
