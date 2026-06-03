'use strict';
// ── Integration §4.2 test 7: PATCH /api/queue/branches/:id/operation-mode ────
// Verifica cambio de modo + response con previous_mode + changed:true
// ─────────────────────────────────────────────────────────────────────────────

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  pool, BRANCH_ID, apiPatch,
} = require('./helpers/testDb');

test('PATCH operation-mode — cambia modo, retorna previous_mode + changed:true', async (t) => {
  // Leer modo actual para restaurarlo después
  const { rows } = await pool.query(
    `SELECT operation_mode FROM branches WHERE id = $1`, [BRANCH_ID]
  );
  const original = rows[0]?.operation_mode || 'queue_only';

  // Cambiar a un modo diferente
  const targetMode = original === 'queue_only' ? 'queue_and_appointments' : 'queue_only';

  const { status, body } = await apiPatch(
    `/api/queue/branches/${BRANCH_ID}/operation-mode`,
    { operation_mode: targetMode }
  );

  assert.equal(status, 200, `Esperado 200: ${JSON.stringify(body)}`);
  assert.equal(body.operation_mode, targetMode);
  assert.equal(body.previous_mode, original);
  assert.equal(body.changed, true);
  assert.ok(body.branch_id, 'Debe retornar branch_id');

  // Test no-op: mismo modo → changed:false
  const noop = await apiPatch(
    `/api/queue/branches/${BRANCH_ID}/operation-mode`,
    { operation_mode: targetMode }
  );
  assert.equal(noop.status, 200);
  assert.equal(noop.body.changed, false);

  // Restaurar modo original
  t.after(() =>
    apiPatch(`/api/queue/branches/${BRANCH_ID}/operation-mode`, { operation_mode: original })
  );
});

process.on('exit', () => pool.end().catch(() => {}));
