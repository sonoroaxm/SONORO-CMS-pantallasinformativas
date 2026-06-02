// ============================================================
// SONORO Queue v2 — R1 · Validadores de campos appointments
// Archivo: backend/src/queue/validation.js
// ============================================================
// Reglas R1-PLAN §2.1 (request body POST /api/queue/appointments):
//   client_name        : trim, longitud [3,120]
//   client_phone       : regex /^\+?[0-9\s\-]{7,}$/, longitud ≤30
//   client_id_number   : trim, longitud [4,40]
//   currency_at_booking: ISO 4217 ^[A-Z]{3}$ (cuando provisto)
//
// Funciones puras. Devuelven { ok, value, error }:
//   ok=true  → value es el campo saneado (trim, etc.)
//   ok=false → error es string corto en español para 400
// Sin acceso a BD ni a req/res. Test unitarios en §4.1.
// ============================================================

'use strict';

const PHONE_RE    = /^\+?[0-9\s\-]{7,}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function ok(value)  { return { ok: true,  value }; }
function err(msg)   { return { ok: false, error: msg }; }

function validateClientName(raw) {
  if (raw === undefined || raw === null) {
    return err('client_name es requerido');
  }
  if (typeof raw !== 'string') {
    return err('client_name debe ser texto');
  }
  const trimmed = raw.trim();
  if (trimmed.length < 3)   return err('client_name muy corto (mínimo 3 caracteres)');
  if (trimmed.length > 120) return err('client_name muy largo (máximo 120 caracteres)');
  return ok(trimmed);
}

function validateClientPhone(raw) {
  if (raw === undefined || raw === null) {
    return err('client_phone es requerido');
  }
  if (typeof raw !== 'string') {
    return err('client_phone debe ser texto');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return err('client_phone es requerido');
  if (trimmed.length > 30)  return err('client_phone muy largo (máximo 30 caracteres)');
  if (!PHONE_RE.test(trimmed)) {
    return err('client_phone con formato inválido (dígitos, espacios, guiones; opcional +)');
  }
  return ok(trimmed);
}

function validateClientIdNumber(raw) {
  if (raw === undefined || raw === null) {
    return err('client_id_number es requerido');
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return err('client_id_number debe ser texto o número');
  }
  const trimmed = String(raw).trim();
  if (trimmed.length < 4)  return err('client_id_number muy corto (mínimo 4 caracteres)');
  if (trimmed.length > 40) return err('client_id_number muy largo (máximo 40 caracteres)');
  return ok(trimmed);
}

function validateCurrencyAtBooking(raw) {
  if (raw === undefined || raw === null) {
    return ok(null);
  }
  if (typeof raw !== 'string') {
    return err('currency_at_booking debe ser texto ISO 4217');
  }
  const upper = raw.trim().toUpperCase();
  if (!CURRENCY_RE.test(upper)) {
    return err('currency_at_booking debe ser ISO 4217 (3 letras mayúsculas)');
  }
  return ok(upper);
}

module.exports = {
  validateClientName,
  validateClientPhone,
  validateClientIdNumber,
  validateCurrencyAtBooking,
  // expuestos para tests
  _regex: { PHONE_RE, CURRENCY_RE },
};
