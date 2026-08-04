// ============================================================
// SONORO Queue v2 — R1 · Generador de grilla de slots
// Archivo: backend/src/queue/slots.js
// ============================================================
// Función pura sin acceso a BD. Recibe los datos ya leídos por
// el endpoint y devuelve la grilla del día con cada slot marcado
// disponible / ocupado / bloqueado.
//
// El endpoint GET /api/queue/appointments/slots (§2.5) hace el
// fetch (services + branch + appointments + time_blocks) y
// delega la generación de la grilla a este módulo. Test §4.1.
// ============================================================
// Reglas:
//   · El grid arranca en openTime y avanza en steps de stepMinutes
//     hasta superar closeTime. El último slot que cabe COMPLETO
//     antes de closeTime queda incluido; uno que se pasa, no.
//   · Cada slot se marca:
//       available=true           — libre
//       available=false, reason  — 'occupied' (appointment activa
//                                   en ese instante) o 'blocked'
//                                   (time_block cubre ese instante)
//   · 'blocked' tiene precedencia sobre 'occupied' si ambos aplican
//     (raro, pero hace el output determinista).
// ============================================================

'use strict';

// Parsea "HH:MM" o "HH:MM:SS" a {hh, mm}. Lanza si formato inválido.
function parseHHMM(raw, fallback) {
  if (!raw) return fallback;
  const m = String(raw).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return fallback;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(hh) || hh < 0 || hh > 23) return fallback;
  if (!Number.isFinite(mm) || mm < 0 || mm > 59) return fallback;
  return { hh, mm };
}

// Construye un Date TIMESTAMPTZ a partir de fecha YYYY-MM-DD + {hh,mm} + tz offset.
// Usamos UTC porque el endpoint compara contra TIMESTAMPTZ; la branch.timezone se
// resuelve antes de llamar (el caller pasa el offset ya aplicado en openTime/closeTime
// si quiere localizar). Para R1 trabajamos en UTC consistente — el front muestra
// horario local; el back guarda UTC.
function dateAt(dateYYYYMMDD, hhmm) {
  const [y, m, d] = dateYYYYMMDD.split('-').map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d, hhmm.hh, hhmm.mm, 0, 0));
}

// occupiedSet: Set<ISO string> con scheduled_at de cada appointment activa del día.
// blockedRanges: Array<{starts_at: Date|string, ends_at: Date|string}>.
function inAnyRange(ts, blockedRanges) {
  const t = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
  for (const r of blockedRanges) {
    const s = r.starts_at instanceof Date ? r.starts_at.getTime() : new Date(r.starts_at).getTime();
    const e = r.ends_at   instanceof Date ? r.ends_at.getTime()   : new Date(r.ends_at).getTime();
    // Rango semiabierto [s, e) — coherente con tstzrange '[)' usado en EXCLUDE.
    if (t >= s && t < e) return true;
  }
  return false;
}

function buildSlotsGrid({
  date,                 // YYYY-MM-DD
  openTime,             // 'HH:MM' o 'HH:MM:SS' o null/undefined
  closeTime,            // idem
  stepMinutes,          // integer ≥ 5
  occupiedSet,          // Set<ISO string>
  blockedRanges,        // Array<{starts_at, ends_at}>
}) {
  const defaultOpen  = { hh: 8,  mm: 0 };
  const defaultClose = { hh: 18, mm: 0 };
  const o = parseHHMM(openTime,  defaultOpen);
  const c = parseHHMM(closeTime, defaultClose);

  if (!Number.isFinite(stepMinutes) || stepMinutes < 5) stepMinutes = 30;

  const start = dateAt(date, o);
  const end   = dateAt(date, c);

  // Si close < open o son iguales, devuelve grilla vacía (configuración inválida).
  if (end.getTime() <= start.getTime()) {
    return { date, slot_duration_minutes: stepMinutes, slots: [] };
  }

  const occupied = occupiedSet || new Set();
  const blocks   = blockedRanges || [];

  const slots = [];
  const stepMs = stepMinutes * 60 * 1000;

  // Genera slots cuyo inicio + duración ≤ closeTime (el último COMPLETO antes de cerrar).
  for (let t = start.getTime(); t + stepMs <= end.getTime(); t += stepMs) {
    const slotStart = new Date(t);
    const iso = slotStart.toISOString();
    const isBlocked  = inAnyRange(slotStart, blocks);
    const isOccupied = occupied.has(iso);

    if (isBlocked) {
      slots.push({ starts_at: iso, available: false, reason: 'blocked' });
    } else if (isOccupied) {
      slots.push({ starts_at: iso, available: false, reason: 'occupied' });
    } else {
      slots.push({ starts_at: iso, available: true });
    }
  }

  return { date, slot_duration_minutes: stepMinutes, slots };
}

module.exports = {
  buildSlotsGrid,
  // expuestos para tests
  _internals: { parseHHMM, dateAt, inAnyRange },
};
