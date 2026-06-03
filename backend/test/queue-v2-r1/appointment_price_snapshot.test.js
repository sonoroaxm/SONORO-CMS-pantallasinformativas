'use strict';
// ── Integration §4.2 test 4: snapshot precio inmutable (DoD #3) ──────────────
// Crea cita → UPDATE services.price → GET cita → price_at_booking sin cambio
// ─────────────────────────────────────────────────────────────────────────────

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  pool, BRANCH_ID, SVC_ID, apiPost, apiGet, futureSlot, cleanAppts,
} = require('./helpers/testDb');

test('appointment price_at_booking es inmutable tras cambio en services.price', async (t) => {
  // 1. Crear cita — captura precio actual (60000 COP)
  const { status: s1, body: created } = await apiPost('/api/queue/appointments', {
    branch_id:        BRANCH_ID,
    service_id:       SVC_ID,
    client_name:      'Test Snapshot',
    client_phone:     '+57 300 0000099',
    client_id_number: 'TEST00000099',
    scheduled_at:     futureSlot(45, 10),
    origin:           'admin',
  });
  assert.equal(s1, 201, `POST debe ser 201: ${JSON.stringify(created)}`);
  assert.equal(created.price_at_booking, 60000);

  // 2. Cambiar precio del servicio directamente en BD
  await pool.query(`UPDATE services SET price = 99999 WHERE id = $1`, [SVC_ID]);

  try {
    // 3. GET la cita — price_at_booking no debe haber cambiado
    const { status: s2, body: data } = await apiGet(
      `/api/queue/appointments?branch_id=${BRANCH_ID}&date=${created.scheduled_at.slice(0,10)}`
    );
    assert.equal(s2, 200);
    const item = (data.items || []).find(a => a.id === created.id);
    assert.ok(item, 'Cita no encontrada en GET');
    assert.equal(item.price_at_booking, 60000,
      `Snapshot debe ser 60000, recibido: ${item.price_at_booking}`);
  } finally {
    // 4. Restaurar precio original y limpiar
    await pool.query(`UPDATE services SET price = 60000 WHERE id = $1`, [SVC_ID]);
    await cleanAppts([created.id]);
  }
});

process.on('exit', () => pool.end().catch(() => {}));
