#!/usr/bin/env bash
# validate-dashboard.sh
# Verifica que dashboard.html contenga todos los elementos críticos de Queue v2.
# Uso: bash tools/validate-dashboard.sh
# También lo ejecuta el pre-commit hook automáticamente cuando dashboard.html está staged.
#
# Agrega marcadores nuevos si Queue v2 crece con más modales/tabs.

set -euo pipefail

FILE="backend/public/dashboard.html"
ERRORS=0

check_marker() {
  local marker="$1"
  local description="$2"
  if ! grep -q "$marker" "$FILE" 2>/dev/null; then
    echo "  FALTA: $description"
    echo "         Marcador: $marker"
    ERRORS=$((ERRORS + 1))
  fi
}

if [ ! -f "$FILE" ]; then
  echo "ERROR: $FILE no encontrado. Ejecuta desde la raiz del repo."
  exit 1
fi

echo "Validando integridad Queue v2 en $FILE ..."

# ── Tab principal de Citas ──────────────────────────────────────────────────
check_marker 'id="appointments-tab"'          "Tab Gestion de Citas (seccion principal)"

# ── Modal Nueva Cita ────────────────────────────────────────────────────────
check_marker 'id="appointmentModal"'          "Modal Nueva Cita (contenedor)"
check_marker 'id="apptCreateBranch"'          "Modal Nueva Cita > select Sucursal"
check_marker 'id="apptCreateService"'         "Modal Nueva Cita > select Servicio"
check_marker 'id="apptCreateDate"'            "Modal Nueva Cita > input Fecha"
check_marker 'id="apptCreateName"'            "Modal Nueva Cita > input Nombre cliente"
check_marker 'id="apptCreateIdNumber"'        "Modal Nueva Cita > input Cedula"
check_marker 'id="apptCreateSubmitBtn"'       "Modal Nueva Cita > boton Crear cita"

# ── Filtros y controles del tab ─────────────────────────────────────────────
check_marker 'id="apptBranchFilter"'          "Filtro Sucursal en tab Citas"
check_marker 'id="apptDateFilter"'            "Filtro Fecha en tab Citas"
check_marker 'openCreateAppointmentModal'     "Boton + Nueva cita (onclick)"

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "BLOQUEADO: $ERRORS elemento(s) de Queue v2 falta(n) en dashboard.html."
  echo ""
  echo "Causa probable: sync de Events sobreescribio adiciones de Queue v2."
  echo "Solucion:       restaura los elementos antes de continuar."
  echo "Referencia:     docs/CLAUDE.md > seccion 'Proceso de Deploy'"
  exit 1
fi

echo "OK: Queue v2 integridad verificada ($FILE)"
exit 0
