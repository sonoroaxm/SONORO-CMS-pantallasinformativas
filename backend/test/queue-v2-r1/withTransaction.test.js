// ============================================================
// SONORO Queue v2 — R1 · Tests unit · withTransaction.js
// Archivo: backend/test/queue-v2-r1/withTransaction.test.js
// ============================================================
// Cobertura R1-PLAN §4.1 (parte 2 de 4):
//   - Commit: si fn resuelve, ejecuta BEGIN→fn→COMMIT y release()
//   - Rollback: si fn lanza, ejecuta ROLLBACK y release()
//   - Propagación: el error original llega al caller (no se traga)
//
// Estrategia: mock manual de pool/client (sin pg real). El helper
// solo necesita pool.connect() → { query, release }.
// ============================================================

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { withTransaction } = require('../../src/db/withTransaction');

// Fábrica de mock — registra cada query y si release fue llamado.
function makeMockPool() {
  const calls = [];
  let released = false;
  const client = {
    query: async (sql) => {
      calls.push(sql);
      return { rows: [] };
    },
    release: () => { released = true; },
  };
  const pool = {
    connect: async () => client,
  };
  return { pool, client, calls, getReleased: () => released };
}

// ── COMMIT path ───────────────────────────────────────────────
test('withTransaction: caso happy — BEGIN, fn, COMMIT, release; retorna valor', async () => {
  const { pool, calls, getReleased } = makeMockPool();

  const result = await withTransaction(pool, async (client) => {
    await client.query('SELECT 1');
    return { ok: true, n: 42 };
  });

  assert.deepEqual(result, { ok: true, n: 42 });
  assert.deepEqual(calls, ['BEGIN', 'SELECT 1', 'COMMIT']);
  assert.equal(getReleased(), true, 'client.release() debe haberse llamado');
});

// ── ROLLBACK path ─────────────────────────────────────────────
test('withTransaction: fn lanza → ROLLBACK, release y rethrow', async () => {
  const { pool, calls, getReleased } = makeMockPool();
  const boom = new Error('boom');

  await assert.rejects(
    () => withTransaction(pool, async (client) => {
      await client.query('SELECT 1');
      throw boom;
    }),
    (err) => err === boom,
  );

  assert.deepEqual(calls, ['BEGIN', 'SELECT 1', 'ROLLBACK']);
  assert.equal(getReleased(), true, 'client.release() debe ejecutarse aun con error');
});

// ── Validación de argumentos ──────────────────────────────────
test('withTransaction: argumentos inválidos lanzan antes de connect()', async () => {
  // pool inválido
  await assert.rejects(
    () => withTransaction(null, async () => {}),
    /Pool válido/,
  );
  await assert.rejects(
    () => withTransaction({}, async () => {}),
    /Pool válido/,
  );

  // fn inválida
  const { pool } = makeMockPool();
  await assert.rejects(
    () => withTransaction(pool, null),
    /función async/,
  );
  await assert.rejects(
    () => withTransaction(pool, 'no soy función'),
    /función async/,
  );
});
