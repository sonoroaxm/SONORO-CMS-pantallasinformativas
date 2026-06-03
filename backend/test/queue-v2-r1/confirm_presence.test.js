'use strict';
// ── Integration §4.2 tests 5-6: POST /api/queue/appointments/:id/confirm-presence
// Test 5: cédula correcta → {confirmed:true, token_number, queue_position, estimated_wait_minutes}
// Test 6: cédula errónea → {confirmed:false} (anti-enumeración, 200 uniforme)
// ─────────────────────────────────────────────────────────────────────────────

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  pool, BRANCH_ID, SVC_ID, USER_ID, API, authHdr, todayBogotaSlot, cleanAppts,
} = require('./helpers/testDb');

// Inserta directamente en BD para control total del estado inicial
async function seedConfirmedAppt(idNumber) {
  const scheduledAt = todayBogotaSlot(14); // hoy Bogotá 14:00 local
  const r = await pool.query(
    `INSERT INTO appointments
       (user_id, branch_id, service_id, client_name, client_phone,
        client_id_number, scheduled_at, status, origin, created_by)
     VALUES ($1,$2,$3,'Test Confirm','0000000000',$4,$5,'confirmed','admin',$1)
     RETURNING id`,
    [USER_ID, BRANCH_ID, SVC_ID, idNumber, scheduledAt]
  );
  return r.rows[0].id;
}

// ── Test 5: match correcto ────────────────────────────────────
test('confirm-presence — cédula correcta: {confirmed:true, token_number}', async (t) => {
  const ID_NUM = 'TEST55555555';
  const aptId  = await seedConfirmedAppt(ID_NUM);

  const res = await fetch(`${API}/api/queue/appointments/${aptId}/confirm-presence`, {
    method:  'POST',
    headers: authHdr(),
    body:    JSON.stringify({ client_id_number: ID_NUM, branch_id: BRANCH_ID }),
  });
  const body = await res.json();

  assert.equal(res.status, 200, `Esperado 200: ${JSON.stringify(body)}`);
  assert.equal(body.confirmed, true, 'confirmed debe ser true');
  assert.ok(body.token_number, 'Debe retornar token_number');
  assert.equal(typeof body.estimated_wait_minutes, 'number');
  assert.equal(typeof body.queue_position, 'number');

  // El appointment debe haber pasado a 'attended'
  const chk = await pool.query(`SELECT status FROM appointments WHERE id = $1`, [aptId]);
  assert.equal(chk.rows[0]?.status, 'attended');

  // Cleanup: appointment fue marcado 'attended' — limpiar queue_tokens también
  t.after(() => cleanAppts([aptId]));
});

// ── Test 6: cédula errónea → {confirmed:false} (200 uniforme) ─
test('confirm-presence — cédula errónea: 200 {confirmed:false} anti-enumeración', async (t) => {
  const ID_NUM = 'TEST66666666';
  const aptId  = await seedConfirmedAppt(ID_NUM);

  const res = await fetch(`${API}/api/queue/appointments/${aptId}/confirm-presence`, {
    method:  'POST',
    headers: authHdr(),
    body:    JSON.stringify({ client_id_number: 'WRONG99999', branch_id: BRANCH_ID }),
  });
  const body = await res.json();

  assert.equal(res.status, 200, `Esperado 200: ${JSON.stringify(body)}`);
  assert.equal(body.confirmed, false);
  // Sin token_number cuando no hay match
  assert.equal(body.token_number, undefined);

  // El appointment debe seguir en 'confirmed' (no se tocó)
  const chk = await pool.query(`SELECT status FROM appointments WHERE id = $1`, [aptId]);
  assert.equal(chk.rows[0]?.status, 'confirmed');

  t.after(() => cleanAppts([aptId]));
});

process.on('exit', () => pool.end().catch(() => {}));
