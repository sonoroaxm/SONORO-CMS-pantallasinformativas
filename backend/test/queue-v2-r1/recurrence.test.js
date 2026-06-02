// ============================================================
// SONORO Queue v2 — R1 · Tests unit · timeBlocks.validateRecurrence
// Archivo: backend/test/queue-v2-r1/recurrence.test.js
// ============================================================
// Cobertura R1-PLAN §4.1 (parte 4 de 4):
//   - RRULE acotada (UNTIL o COUNT) → ok=true
//   - RRULE infinita (FREQ sin UNTIL ni COUNT) → ok=false
//
// Decisión sesión 66: rechazamos recurrencias infinitas para
// evitar explotar la memoria al expandir slots. Un bloque
// recurrente debe declarar explícitamente cuándo termina.
// ============================================================

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  validateRecurrence,
  validateTimeBlockInput,
  expandOccurrences,
} = require('../../src/queue/timeBlocks');

// ── Acotadas: aceptadas ───────────────────────────────────────
test('validateRecurrence: acepta RRULE con UNTIL o COUNT; null/empty → ok null', () => {
  // null/undefined → ok con recurrence:null
  assert.deepEqual(validateRecurrence(null),      { ok: true, recurrence: null });
  assert.deepEqual(validateRecurrence(undefined), { ok: true, recurrence: null });
  assert.deepEqual(validateRecurrence(''),        { ok: true, recurrence: null });
  assert.deepEqual(validateRecurrence('   '),     { ok: true, recurrence: null });

  // RRULE semanal con UNTIL → ok
  const withUntil = 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231T000000Z';
  const r1 = validateRecurrence(withUntil);
  assert.equal(r1.ok, true);
  assert.equal(r1.recurrence, withUntil);

  // RRULE diario con COUNT → ok
  const withCount = 'RRULE:FREQ=DAILY;COUNT=10';
  const r2 = validateRecurrence(withCount);
  assert.equal(r2.ok, true);
  assert.equal(r2.recurrence, withCount);

  // expandOccurrences honra COUNT (sanity check de la lib rrule)
  // Nota: rrule@2.8 sin DTSTART explícito usa "now" → rango debe cubrir hoy
  const start = new Date('2020-01-01T00:00:00Z');
  const end   = new Date('2100-01-01T00:00:00Z');
  const occ   = expandOccurrences(withCount, start, end);
  assert.ok(Array.isArray(occ));
  assert.equal(occ.length, 10, 'COUNT=10 debe rendir 10 ocurrencias');
});

// ── Infinitas y malformadas: rechazadas ───────────────────────
test('validateRecurrence: rechaza recurrencias infinitas y strings inválidos', () => {
  // FREQ sin UNTIL ni COUNT → infinita → rechazada
  const infinite = 'RRULE:FREQ=WEEKLY;BYDAY=MO';
  const r1 = validateRecurrence(infinite);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /UNTIL o COUNT/);

  // String que no es RRULE válida
  const garbage = 'esto no es rrule';
  const r2 = validateRecurrence(garbage);
  assert.equal(r2.ok, false);

  // Tipo no string
  assert.equal(validateRecurrence(42).ok, false);
  assert.equal(validateRecurrence({}).ok, false);

  // Demasiado largo (>500 chars)
  const huge = 'RRULE:FREQ=DAILY;COUNT=1;' + 'X'.repeat(600);
  assert.equal(validateRecurrence(huge).ok, false);

  // validateTimeBlockInput propaga el rechazo de recurrence
  const body = {
    branch_id:  '11111111-1111-1111-1111-111111111111',
    starts_at:  '2026-06-10T10:00:00Z',
    ends_at:    '2026-06-10T11:00:00Z',
    recurrence: infinite,
  };
  const v = validateTimeBlockInput(body);
  assert.equal(v.ok, false);
  assert.match(v.error, /UNTIL o COUNT/);
});
