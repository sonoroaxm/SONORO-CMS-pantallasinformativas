// ============================================================
// SONORO Queue v2 — R1 · Tests unit · validation.js
// Archivo: backend/test/queue-v2-r1/validation.test.js
// ============================================================
// Cobertura R1-PLAN §4.1 (parte 1 de 4):
//   - validateClientName        — trim, longitud [3,120], tipos
//   - validateClientPhone       — regex /^\+?[0-9\s\-]{7,}$/, ≤30
//   - validateClientIdNumber    — trim, longitud [4,40], string|number
//   - validateCurrencyAtBooking — ISO 4217 /^[A-Z]{3}$/ o null
//
// Framework: node --test (built-in Node ≥20). Sin deps externas.
// ============================================================

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  validateClientName,
  validateClientPhone,
  validateClientIdNumber,
  validateCurrencyAtBooking,
} = require('../../src/queue/validation');

// ── validateClientName ────────────────────────────────────────
test('validateClientName: válido, vacío, demasiado corto, demasiado largo, tipo inválido', () => {
  // OK con trim
  assert.deepEqual(validateClientName('  Juan Pérez  '), { ok: true, value: 'Juan Pérez' });
  // OK borde inferior (3)
  assert.deepEqual(validateClientName('Ana'), { ok: true, value: 'Ana' });
  // OK borde superior (120)
  const max = 'a'.repeat(120);
  assert.deepEqual(validateClientName(max), { ok: true, value: max });

  // Faltante
  assert.equal(validateClientName(undefined).ok, false);
  assert.equal(validateClientName(null).ok, false);

  // Tipo no string
  assert.equal(validateClientName(42).ok, false);
  assert.equal(validateClientName({}).ok, false);

  // Muy corto (post-trim)
  assert.equal(validateClientName('  ab  ').ok, false);
  assert.equal(validateClientName('').ok, false);

  // Muy largo
  assert.equal(validateClientName('x'.repeat(121)).ok, false);
});

// ── validateClientPhone ───────────────────────────────────────
test('validateClientPhone: formatos +/dígitos/espacios/guiones, ≤30 chars', () => {
  // OK con + y mezcla
  assert.deepEqual(validateClientPhone('+57 300 123 4567'), { ok: true, value: '+57 300 123 4567' });
  // OK sin +
  assert.deepEqual(validateClientPhone('3001234567'), { ok: true, value: '3001234567' });
  // OK con guiones
  assert.deepEqual(validateClientPhone('300-123-4567'), { ok: true, value: '300-123-4567' });
  // OK borde longitud: 7 chars mínimo por regex (la regex exige ≥7 dígitos/espacios/guiones)
  assert.equal(validateClientPhone('1234567').ok, true);

  // Faltante
  assert.equal(validateClientPhone(undefined).ok, false);
  assert.equal(validateClientPhone(null).ok, false);

  // Tipo no string
  assert.equal(validateClientPhone(3001234567).ok, false);

  // Caracteres inválidos (letras)
  assert.equal(validateClientPhone('300abc4567').ok, false);
  // Caracteres inválidos (paréntesis no permitidos por la regex)
  assert.equal(validateClientPhone('(300) 123 4567').ok, false);

  // Demasiado corto (6 chars)
  assert.equal(validateClientPhone('123456').ok, false);

  // Demasiado largo (>30)
  assert.equal(validateClientPhone('1'.repeat(31)).ok, false);

  // Vacío post-trim
  assert.equal(validateClientPhone('   ').ok, false);
});

// ── validateClientIdNumber ────────────────────────────────────
test('validateClientIdNumber: acepta string|number, longitud [4,40]', () => {
  // OK string normal
  assert.deepEqual(validateClientIdNumber('12345678'), { ok: true, value: '12345678' });
  // OK number coercionado a string
  assert.deepEqual(validateClientIdNumber(12345678), { ok: true, value: '12345678' });
  // OK con trim
  assert.deepEqual(validateClientIdNumber('  ABC1234  '), { ok: true, value: 'ABC1234' });
  // OK borde inferior (4)
  assert.deepEqual(validateClientIdNumber('1234'), { ok: true, value: '1234' });
  // OK borde superior (40)
  const max = '1'.repeat(40);
  assert.deepEqual(validateClientIdNumber(max), { ok: true, value: max });

  // Faltante
  assert.equal(validateClientIdNumber(undefined).ok, false);
  assert.equal(validateClientIdNumber(null).ok, false);

  // Tipo inválido (objeto)
  assert.equal(validateClientIdNumber({}).ok, false);
  assert.equal(validateClientIdNumber([]).ok, false);

  // Muy corto
  assert.equal(validateClientIdNumber('123').ok, false);
  assert.equal(validateClientIdNumber(12).ok, false);

  // Muy largo
  assert.equal(validateClientIdNumber('1'.repeat(41)).ok, false);
});

// ── validateCurrencyAtBooking ─────────────────────────────────
test('validateCurrencyAtBooking: ISO 4217, mayúscula automática, null aceptado', () => {
  // OK mayúsculas directas
  assert.deepEqual(validateCurrencyAtBooking('COP'), { ok: true, value: 'COP' });
  assert.deepEqual(validateCurrencyAtBooking('USD'), { ok: true, value: 'USD' });

  // OK con minúsculas → upper
  assert.deepEqual(validateCurrencyAtBooking('cop'), { ok: true, value: 'COP' });

  // OK con trim + upper
  assert.deepEqual(validateCurrencyAtBooking('  eur  '), { ok: true, value: 'EUR' });

  // Null/undefined → ok con value=null (campo opcional)
  assert.deepEqual(validateCurrencyAtBooking(null), { ok: true, value: null });
  assert.deepEqual(validateCurrencyAtBooking(undefined), { ok: true, value: null });

  // Tipo no string
  assert.equal(validateCurrencyAtBooking(123).ok, false);

  // Longitud inválida (2 / 4 letras)
  assert.equal(validateCurrencyAtBooking('US').ok, false);
  assert.equal(validateCurrencyAtBooking('USDX').ok, false);

  // Contiene dígitos
  assert.equal(validateCurrencyAtBooking('US1').ok, false);
});
