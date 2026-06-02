// ============================================================
// SONORO Queue v2 — R1 · Serializers de appointments
// Archivo: backend/src/queue/serializers.js
// ============================================================
// Decisión sesión 53 reforzada sesión 54 (R1-PLAN §3.4):
//
//   price_at_booking + currency_at_booking solo deben verse en
//   payloads consumidos por admin/agente. Kioskos y sockets de
//   sucursal o públicos NUNCA reciben esos campos.
//
// La sanitización ocurre server-side. Una sola fuente de
// verdad por sala. No truncar en cliente.
//
// Sala → función:
//   user_${user_id}       → serializeForAdmin   (con precio)
//   branch_${branch_id}   → serializeForBranch  (sin precio)
//   kiosko / público R1.5 → serializeForKiosk   (mínimo)
// ============================================================
// Funciones puras: input row de Postgres, output objeto plano.
// Sin acceso a BD, sin side effects. Test unitarios en §4.1.
// ============================================================

'use strict';

// Campos compartidos por TODAS las salas (no leak de precio).
function baseFields(row) {
  return {
    id:                row.id,
    branch_id:         row.branch_id,
    service_id:        row.service_id,
    scheduled_at:      row.scheduled_at,
    status:            row.status,
    origin:            row.origin,
    created_at:        row.created_at,
  };
}

// ── Admin / agente: payload completo, incluye snapshot precio ──
function serializeForAdmin(row) {
  return {
    ...baseFields(row),
    user_id:              row.user_id,
    client_name:          row.client_name,
    client_phone:         row.client_phone,
    client_email:         row.client_email ?? null,
    client_id_number:     row.client_id_number,
    agent_id:             row.agent_id ?? null,
    parent_token_id:      row.parent_token_id ?? null,
    created_by:           row.created_by ?? null,
    price_at_booking:     row.price_at_booking !== null && row.price_at_booking !== undefined
                            ? Number(row.price_at_booking)
                            : null,
    currency_at_booking:  row.currency_at_booking ?? null,
    notes:                row.notes ?? null,
    updated_at:           row.updated_at,
  };
}

// ── Sala branch: agentes operativos, NO precio ──
// Mantiene client_name (la sucursal sí lo necesita para llamar al cliente)
// pero omite teléfono/cédula completos por defensa: si el front necesita
// teléfono para contactar, lo pedirá vía GET autenticado del admin.
function serializeForBranch(row) {
  return {
    ...baseFields(row),
    client_name:       row.client_name,
    client_id_masked:  maskIdNumber(row.client_id_number),
    agent_id:          row.agent_id ?? null,
  };
}

// ── Kiosko / público R1.5: lo mínimo para confirmar presencia / status ──
function serializeForKiosk(row) {
  return {
    id:           row.id,
    branch_id:    row.branch_id,
    service_id:   row.service_id,
    scheduled_at: row.scheduled_at,
    status:       row.status,
  };
}

// Helper interno — no exportado.
function maskIdNumber(idNumber) {
  if (!idNumber) return null;
  const s = String(idNumber);
  if (s.length <= 4) return '*'.repeat(s.length);
  return '*'.repeat(s.length - 4) + s.slice(-4);
}

module.exports = {
  serializeForAdmin,
  serializeForBranch,
  serializeForKiosk,
};
