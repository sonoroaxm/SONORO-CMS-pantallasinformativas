// ============================================================
// SONORO Queue v2 — R1 · Validación y parseo de time_blocks
// Archivo: backend/src/queue/timeBlocks.js
// ============================================================
// Funciones puras sin acceso a BD. Encapsulan:
//   1) Validación del input recibido por POST /api/queue/time-blocks
//   2) Parseo seguro de RRULE (RFC 5545 subset soportado por la lib
//      `rrule@^2.8`), incluyendo guardar contra recurrencias infinitas.
//   3) Helper para expandir ocurrencias entre dos fechas (lo usa el
//      endpoint GET /api/queue/appointments/slots cuando se introduzca
//      en sesión posterior — aquí queda listo para reuso).
//
// Decisión sesión 66: el módulo NO realiza chequeos de solapamiento
// con la BD; ese trabajo vive en la transacción del endpoint usando
// EXCLUDE (mismo scope) + query SQL (cross-NULL scope).
// ============================================================

'use strict';

const { RRuleSet, rrulestr } = require('rrule');

const REASON_MAX_LEN     = 200;
const RECURRENCE_MAX_LEN = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Convierte una cadena ISO-8601 a Date. Devuelve null si no es válida.
function parseIsoDate(s) {
  if (typeof s !== 'string') return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Valida la cadena de recurrencia (RRULE/RRULESET RFC 5545). Acepta el
// formato `RRULE:FREQ=...` o múltiples líneas (RDATE/EXDATE/RRULE).
// Rechaza recurrencias infinitas (sin UNTIL ni COUNT) en TODAS las RRULE
// componentes — evita generar series ilimitadas en endpoints de slots.
function validateRecurrence(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, recurrence: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'recurrence debe ser string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, recurrence: null };
  if (trimmed.length > RECURRENCE_MAX_LEN) {
    return { ok: false, error: `recurrence excede ${RECURRENCE_MAX_LEN} caracteres` };
  }
  let parsed;
  try {
    parsed = rrulestr(trimmed);
  } catch (err) {
    return { ok: false, error: `recurrence inválida: ${err.message || 'parse error'}` };
  }
  // Recolectar todas las RRULE (1 si rrulestr devuelve RRule; N si RRuleSet).
  const rules = parsed instanceof RRuleSet ? parsed.rrules() : [parsed];
  if (rules.length === 0) {
    return { ok: false, error: 'recurrence sin regla base' };
  }
  for (const r of rules) {
    const opts = r.origOptions || r.options || {};
    const hasUntil = !!opts.until;
    const hasCount = Number.isFinite(opts.count) && opts.count > 0;
    if (!hasUntil && !hasCount) {
      return { ok: false, error: 'recurrence debe incluir UNTIL o COUNT (acotada)' };
    }
  }
  return { ok: true, recurrence: trimmed };
}

// Valida el cuerpo completo de un POST /api/queue/time-blocks.
// NO valida solapamientos (eso es responsabilidad del endpoint con BD).
function validateTimeBlockInput(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body inválido' };
  }
  const { branch_id, service_id, starts_at, ends_at, reason, recurrence } = body;

  if (!branch_id || typeof branch_id !== 'string' || !UUID_RE.test(branch_id)) {
    return { ok: false, error: 'branch_id inválido' };
  }
  if (service_id !== undefined && service_id !== null && service_id !== '') {
    if (typeof service_id !== 'string' || !UUID_RE.test(service_id)) {
      return { ok: false, error: 'service_id inválido' };
    }
  }
  const startsDate = parseIsoDate(starts_at);
  const endsDate   = parseIsoDate(ends_at);
  if (!startsDate) return { ok: false, error: 'starts_at no es ISO-8601 válido' };
  if (!endsDate)   return { ok: false, error: 'ends_at no es ISO-8601 válido' };
  if (endsDate <= startsDate) {
    return { ok: false, error: 'ends_at debe ser posterior a starts_at' };
  }
  if (reason !== undefined && reason !== null) {
    if (typeof reason !== 'string') return { ok: false, error: 'reason debe ser string' };
    if (reason.length > REASON_MAX_LEN) {
      return { ok: false, error: `reason excede ${REASON_MAX_LEN} caracteres` };
    }
  }
  const rv = validateRecurrence(recurrence);
  if (!rv.ok) return rv;

  return {
    ok: true,
    value: {
      branch_id,
      service_id: (service_id && service_id !== '') ? service_id : null,
      starts_at:  startsDate.toISOString(),
      ends_at:    endsDate.toISOString(),
      reason:     (reason && reason.trim()) || null,
      recurrence: rv.recurrence,
    },
  };
}

// Expande ocurrencias de una recurrencia entre rangeStart y rangeEnd (Dates).
// Retorna array de Dates ordenadas. Si la cadena es null/falsy devuelve [].
// EXDATE/RDATE del propio string se honran automáticamente (vía rrulestr).
function expandOccurrences(recurrenceStr, rangeStart, rangeEnd) {
  if (!recurrenceStr) return [];
  if (!(rangeStart instanceof Date) || !(rangeEnd instanceof Date)) return [];
  let parsed;
  try {
    parsed = rrulestr(recurrenceStr);
  } catch (_) {
    return [];
  }
  if (parsed instanceof RRuleSet) {
    return parsed.between(rangeStart, rangeEnd, /* inc= */ true);
  }
  return parsed.between(rangeStart, rangeEnd, /* inc= */ true);
}

module.exports = {
  validateTimeBlockInput,
  validateRecurrence,
  expandOccurrences,
  // Exportadas para tests:
  _parseIsoDate: parseIsoDate,
};
