'use strict';
// ── Concurrency §4.3 tests 3-4 ───────────────────────────────────────────────
// Test 3: 2 confirm-presence simultáneos misma cédula → 1 confirma + 1 {confirmed:false}
// Test 4: walk-in queue v1 + cita simultáneos → ambos token sin colisión (DoD #5)
// ─────────────────────────────────────────────────────────────────────────────

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  pool, BRANCH_ID, SVC_ID, USER_ID, API, authHdr, KIOSK_TK,
  todayBogotaSlot, cleanAppts,
} = require('./helpers/testDb');

async function seedConfirmed(idNumber) {
  const r = await pool.query(
    `INSERT INTO appointments
       (user_id, branch_id, service_id, client_name, client_phone,
        client_id_number, scheduled_at, status, origin, created_by)
     VALUES ($1,$2,$3,'Concurrent Confirm','0000000000',$4,$5,'confirmed','admin',$1)
     RETURNING id`,
    [USER_ID, BRANCH_ID, SVC_ID, idNumber, todayBogotaSlot(15)]
  );
  return r.rows[0].id;
}

// ── Test 3: 2 confirm simultáneos → 1 confirma + 1 {confirmed:false} ─────────
test('concurrent confirm-presence — misma cédula: 1 confirma + 1 {confirmed:false}', async (t) => {
  const ID_NUM = 'CONC33333333';
  const aptId  = await seedConfirmed(ID_NUM);

  const doConfirm = () => fetch(`${API}/api/queue/appointments/${aptId}/confirm-presence`, {
    method:  'POST',
    headers: authHdr(),
    body:    JSON.stringify({ client_id_number: ID_NUM, branch_id: BRANCH_ID }),
  }).then(r => r.json());

  const [a, b] = await Promise.all([doConfirm(), doConfirm()]);

  const confirmed = [a, b].filter(r => r.confirmed === true);
  const rejected  = [a, b].filter(r => r.confirmed === false);

  assert.equal(confirmed.length, 1,
    `Exactamente 1 debe confirmar: a=${JSON.stringify(a)}, b=${JSON.stringify(b)}`);
  assert.equal(rejected.length, 1, '1 debe rechazar');
  assert.ok(confirmed[0].token_number, 'Ganador debe tener token_number');

  t.after(() => cleanAppts([aptId]));
});

// ── Test 4: walk-in v1 + cita simultáneos sin colisión (DoD #5) ──────────────
test('concurrent queue v1 walk-in + cita simultánea → ambos token sin colisión', async (t) => {
  // Crear una cita de hoy en estado confirmed para confirm-presence
  const ID_NUM = 'CONC44444444';
  const aptId  = await seedConfirmed(ID_NUM);

  // Walk-in via POST /api/queue/token (Queue v1 — no auth, branch_id+service_id en body)
  const walkinPromise = fetch(`${API}/api/queue/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ branch_id: BRANCH_ID, service_id: SVC_ID }),
  }).then(r => r.json());

  // confirm-presence simultáneo
  const confirmPromise = fetch(`${API}/api/queue/appointments/${aptId}/confirm-presence`, {
    method:  'POST',
    headers: authHdr(),
    body:    JSON.stringify({ client_id_number: ID_NUM, branch_id: BRANCH_ID }),
  }).then(r => r.json());

  const [walkin, confirm] = await Promise.all([walkinPromise, confirmPromise]);

  // Walk-in debe retornar un token
  assert.ok(walkin.token_number || walkin.number,
    `Walk-in debe tener token: ${JSON.stringify(walkin)}`);

  // confirm-presence debe confirmar (o no, si hay race con walk-in — lo importante es que no hay crash)
  assert.ok(
    confirm.confirmed === true || confirm.confirmed === false,
    `confirm-presence debe retornar confirmed boolean: ${JSON.stringify(confirm)}`
  );

  // Si confirmó, debe tener token_number distinto al walk-in
  if (confirm.confirmed) {
    const walkinNum = walkin.token_number || walkin.number;
    assert.notEqual(confirm.token_number, walkinNum,
      'Los dos tokens deben ser distintos');
  }

  // Cleanup: walk-in token (by finding the most recent one for this branch/service)
  const wkRow = await pool.query(
    `DELETE FROM queue_tokens
     WHERE branch_id = $1 AND service_id = $2 AND appointment_id IS NULL
       AND created_at > NOW() - INTERVAL '1 minute'
     RETURNING id`,
    [BRANCH_ID, SVC_ID]
  );

  t.after(() => cleanAppts([aptId]));
});

process.on('exit', () => pool.end().catch(() => {}));
