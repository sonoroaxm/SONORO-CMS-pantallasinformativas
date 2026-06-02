// ============================================================
// SONORO Queue v2 — R1 · Tests unit · serializers.js
// Archivo: backend/test/queue-v2-r1/serializers.test.js
// ============================================================
// Cobertura R1-PLAN §4.1 (parte 3 de 4):
//   - serializeForAdmin  incluye price_at_booking + currency
//                        + datos cliente completos
//   - serializeForBranch NO incluye price ni client_phone
//                        client_id_number → masked (****1234)
//
// Esto es el guardarraíl §3.4: una sola fuente de verdad por
// sala. Si un día alguien añade price a la sala branch, este
// test debe fallar.
// ============================================================

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  serializeForAdmin,
  serializeForBranch,
  serializeForKiosk,
} = require('../../src/queue/serializers');

// Row simulada de PG (snake_case, price como string como pg numeric).
const SAMPLE_ROW = {
  id:                 'apt-uuid-1',
  user_id:            7,
  branch_id:          'br-uuid-1',
  service_id:         'sv-uuid-1',
  scheduled_at:       '2026-06-10T15:00:00.000Z',
  status:             'pending',
  origin:             'admin',
  client_name:        'Juan Pérez',
  client_phone:       '+57 300 1234567',
  client_email:       'juan@example.com',
  client_id_number:   '1023456789',
  agent_id:           3,
  parent_token_id:    null,
  created_by:         7,
  price_at_booking:   '85000.00',   // string como retorna pg para NUMERIC
  currency_at_booking:'COP',
  notes:              'cliente VIP',
  created_at:         '2026-06-01T10:00:00.000Z',
  updated_at:         '2026-06-01T10:00:00.000Z',
};

// ── Admin payload completo ────────────────────────────────────
test('serializeForAdmin: incluye price (Number), currency y datos cliente completos', () => {
  const out = serializeForAdmin(SAMPLE_ROW);

  // Precio convertido a Number desde string PG
  assert.equal(out.price_at_booking, 85000);
  assert.equal(typeof out.price_at_booking, 'number');
  assert.equal(out.currency_at_booking, 'COP');

  // Datos sensibles del cliente presentes
  assert.equal(out.client_name,      'Juan Pérez');
  assert.equal(out.client_phone,     '+57 300 1234567');
  assert.equal(out.client_email,     'juan@example.com');
  assert.equal(out.client_id_number, '1023456789');

  // Metadatos administrativos
  assert.equal(out.user_id,    7);
  assert.equal(out.agent_id,   3);
  assert.equal(out.created_by, 7);
  assert.equal(out.notes,      'cliente VIP');

  // Base
  assert.equal(out.id, 'apt-uuid-1');
  assert.equal(out.status, 'pending');

  // Sin client_id_masked (eso es exclusivo de branch)
  assert.equal(out.client_id_masked, undefined);

  // price=null cuando viene null/undefined desde DB
  const out2 = serializeForAdmin({ ...SAMPLE_ROW, price_at_booking: null });
  assert.equal(out2.price_at_booking, null);
});

// ── Branch payload SIN precio ─────────────────────────────────
test('serializeForBranch: NO incluye price/currency/phone/email; client_id enmascarado', () => {
  const out = serializeForBranch(SAMPLE_ROW);

  // Guardarraíl §3.4: precio NUNCA en sala branch
  assert.equal(out.price_at_booking,    undefined);
  assert.equal(out.currency_at_booking, undefined);

  // Datos sensibles omitidos
  assert.equal(out.client_phone,     undefined);
  assert.equal(out.client_email,     undefined);
  assert.equal(out.client_id_number, undefined);
  assert.equal(out.notes,            undefined);
  assert.equal(out.created_by,       undefined);

  // client_name SÍ se conserva (la sucursal lo necesita para llamar)
  assert.equal(out.client_name, 'Juan Pérez');

  // ID enmascarado: últimos 4 dígitos visibles
  assert.equal(out.client_id_masked, '******6789');

  // Base intacta
  assert.equal(out.id, 'apt-uuid-1');
  assert.equal(out.branch_id, 'br-uuid-1');
  assert.equal(out.status, 'pending');
  assert.equal(out.agent_id, 3);

  // Kiosk también: payload mínimo, sin nombre cliente
  const k = serializeForKiosk(SAMPLE_ROW);
  assert.equal(k.client_name, undefined);
  assert.equal(k.price_at_booking, undefined);
  assert.equal(k.id, 'apt-uuid-1');
  assert.equal(k.status, 'pending');
});
