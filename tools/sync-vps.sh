#!/usr/bin/env bash
# tools/sync-vps.sh — Sincroniza archivos del VPS al repo con validación de contenido.
# Uso: bash tools/sync-vps.sh [--dry-run] [--force-branch]
# Ejecutar siempre desde la raíz del repo.
#
# Comparación basada en md5sum (contenido), no en timestamps.
# VPS es la fuente de verdad — siempre gana cuando el contenido difiere.
# Si repo difiere del VPS Y el repo fue modificado después del último sync,
# el script advierte antes de sobreescribir.

set -uo pipefail

# ── Configuración ─────────────────────────────────────────────────────────────
KEY="${SONORO_SSH_KEY:-/c/Users/sonor/Documents/Documentos/1. SONORO 2026/CONTRATOS-PROYECTOS/SIGNAGE PI/SERVER CON WEB/Key/ssh_sonoro.key}"
VPS="debian@45.181.156.171"
VPS_ROOT="/opt/sonoro-cms"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
FORCE_BRANCH=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force-branch) FORCE_BRANCH=1 ;;
  esac
done

# ── Archivos rastreados ───────────────────────────────────────────────────────
# Al agregar un archivo nuevo al VPS: añadirlo aquí antes de cerrar la sesión.
TRACKED=(
  "backend/public/dashboard.html"
  "backend/public/admin-dashboard.html"
  "backend/public/evento.html"
  "backend/public/evento-staff.html"
  "backend/public/evento-produccion.html"
  "backend/public/evento-kiosko.html"
  "backend/public/proveedor-registro.html"
  "backend/public/cotizacion.html"
  "backend/public/fids.html"
  "backend/public/queue-agent.html"
  "backend/public/queue-kiosk.html"
  "backend/public/queue-display.html"
  "backend/public/queue-reports.html"
  "backend/public/queue-rating.html"
  "backend/public/booking.html"
  "backend/public/cita.html"
  "backend/public/mailer.html"
  "backend/public/politica-datos.html"
  "backend/public/index.html"
  "backend/src/index.js"
  "backend/src/services/email.js"
  "backend/src/routes/events.js"
  "backend/src/routes/events-public.js"
  "backend/src/routes/events-staff.js"
  "backend/src/routes/admin.js"
  "backend/src/queues/videoConversionQueue.js"
)

# ── Colores ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YLW='\033[1;33m'; GRN='\033[0;32m'; CYN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'

# ── Estado ────────────────────────────────────────────────────────────────────
COPIED=(); SKIPPED=(); WARNED=(); MISSING_VPS=()
TOUCHED_DASHBOARD=0; ERRORS=0

ssh_run() { ssh -i "$KEY" -o ConnectTimeout=10 -o BatchMode=yes "$VPS" "$@"; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYN}══════════════════════════════════════════════════════════${NC}"
echo -e "${CYN}  SONORO CMS — sync-vps.sh  │  VPS → repo${NC}"
[[ $DRY_RUN -eq 1 ]] && echo -e "${YLW}  MODO DRY-RUN — no se copiarán archivos${NC}"
echo -e "${CYN}══════════════════════════════════════════════════════════${NC}"
echo ""

# ── Verificar conexión SSH ────────────────────────────────────────────────────
echo -n "  Conectando al VPS ... "
if ! ssh_run "true" 2>/dev/null; then
  echo -e "${RED}FALLO${NC}"
  echo -e "${RED}  ERROR: No se pudo conectar a $VPS.${NC}"
  echo    "  KEY: $KEY"
  exit 1
fi
echo -e "${GRN}OK${NC}"

# ── Validar rama activa VPS vs repo local (S172b, learn from S171 drift) ──────
echo -n "  Validando rama activa VPS ↔ repo ... "
VPS_BRANCH=$(ssh_run "git -C $VPS_ROOT rev-parse --abbrev-ref HEAD 2>/dev/null" 2>/dev/null || echo "unknown")
LOCAL_BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

if [[ "$VPS_BRANCH" != "$LOCAL_BRANCH" ]]; then
  echo -e "${RED}MISMATCH${NC}"
  echo ""
  echo -e "  ${RED}⚠ VPS está en rama '$VPS_BRANCH' pero el repo local está en '$LOCAL_BRANCH'.${NC}"
  echo -e "  ${YLW}En S171 este drift ocultó 2 meses de trabajo sin commitear.${NC}"
  echo -e "  ${YLW}Sync'ear sobre rama distinta puede pisar cambios legítimos.${NC}"
  echo ""
  if [[ $FORCE_BRANCH -eq 1 ]]; then
    echo -e "  ${YLW}--force-branch activo — continuando bajo tu responsabilidad.${NC}"
    echo ""
  else
    echo -e "  ${YLW}Opciones:${NC}"
    echo -e "    1. Cambiar rama local ($LOCAL_BRANCH → $VPS_BRANCH) y reintentar."
    echo -e "    2. Cambiar rama VPS ($VPS_BRANCH → $LOCAL_BRANCH) — requiere reconciliar working tree."
    echo -e "    3. Pasar --force-branch para ignorar (solo si sabes exactamente qué haces)."
    exit 1
  fi
else
  echo -e "${GRN}$VPS_BRANCH${NC}"
fi

# ── Obtener md5sums del VPS en un solo SSH call ───────────────────────────────
echo -n "  Obteniendo checksums del VPS ... "

VPS_PATHS=""
for f in "${TRACKED[@]}"; do
  VPS_PATHS="$VPS_PATHS $VPS_ROOT/$f"
done

# md5sum devuelve "hash  ruta" por línea; 2>/dev/null omite archivos ausentes en VPS
VPS_MD5_RAW=$(ssh_run "md5sum $VPS_PATHS 2>/dev/null" 2>/dev/null || true)
echo -e "${GRN}OK${NC}"
echo ""

# Construir mapa: ruta_relativa → md5
declare -A VPS_HASH
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  hash="${line%% *}"
  vps_path="${line##* }"
  rel="${vps_path#$VPS_ROOT/}"
  VPS_HASH["$rel"]="$hash"
done <<< "$VPS_MD5_RAW"

# ── Tabla de comparación ──────────────────────────────────────────────────────
printf "  %-52s  %-10s  %s\n" "Archivo" "Estado" "Acción"
printf "  %s\n" "$(printf '─%.0s' {1..78})"

for rel in "${TRACKED[@]}"; do
  local_path="$REPO_ROOT/$rel"
  vps_hash="${VPS_HASH[$rel]:-}"

  # ── Archivo ausente en VPS ──────────────────────────────────────────────────
  if [[ -z "$vps_hash" ]]; then
    printf "  %-52s  %-10s  " "$rel" "sin VPS"
    echo -e "${DIM}[no existe en VPS — omitido]${NC}"
    MISSING_VPS+=("$rel")
    continue
  fi

  # ── Archivo ausente en repo ─────────────────────────────────────────────────
  if [[ ! -f "$local_path" ]]; then
    printf "  %-52s  %-10s  " "$rel" "NUEVO"
    echo -e "${GRN}[copiar desde VPS]${NC}"
    if [[ $DRY_RUN -eq 0 ]]; then
      mkdir -p "$(dirname "$local_path")"
      if scp -pq -i "$KEY" "$VPS:$VPS_ROOT/$rel" "$local_path" 2>/dev/null; then
        COPIED+=("$rel")
        [[ "$rel" == "backend/public/dashboard.html" ]] && TOUCHED_DASHBOARD=1
      else
        echo -e "    ${RED}ERROR al copiar $rel${NC}"; ((ERRORS++))
      fi
    else
      COPIED+=("$rel")
    fi
    continue
  fi

  # ── Comparar md5 ────────────────────────────────────────────────────────────
  local_hash=$(md5sum "$local_path" 2>/dev/null | cut -d' ' -f1 || echo "")

  if [[ "$vps_hash" == "$local_hash" ]]; then
    printf "  %-52s  %-10s  " "$rel" "igual"
    echo -e "${DIM}[sin cambios]${NC}"
    SKIPPED+=("$rel")
    continue
  fi

  # Contenido difiere: VPS gana (fuente de verdad).
  # Verificar si el repo tiene uncommitted changes para advertir.
  repo_dirty=$(git -C "$REPO_ROOT" diff --name-only HEAD -- "$rel" 2>/dev/null)
  repo_staged=$(git -C "$REPO_ROOT" diff --cached --name-only -- "$rel" 2>/dev/null)

  if [[ -n "$repo_dirty" || -n "$repo_staged" ]]; then
    printf "  %-52s  %-10s  " "$rel" "CONFLICTO"
    echo -e "${RED}[repo tiene cambios sin commitear — VPS sobreescribirá]${NC}"
    WARNED+=("$rel")
  else
    printf "  %-52s  %-10s  " "$rel" "ACTUALIZAR"
    echo -e "${GRN}[copiar desde VPS]${NC}"
  fi

  if [[ $DRY_RUN -eq 0 ]]; then
    if scp -pq -i "$KEY" "$VPS:$VPS_ROOT/$rel" "$local_path" 2>/dev/null; then
      COPIED+=("$rel")
      [[ "$rel" == "backend/public/dashboard.html" ]] && TOUCHED_DASHBOARD=1
    else
      echo -e "    ${RED}ERROR al copiar $rel${NC}"; ((ERRORS++))
    fi
  else
    COPIED+=("$rel")
  fi
done

echo ""

# ── Validar dashboard.html si fue tocado ──────────────────────────────────────
if [[ $TOUCHED_DASHBOARD -eq 1 && $DRY_RUN -eq 0 ]]; then
  echo -n "  Validando integridad Queue v2 en dashboard.html ... "
  if bash "$REPO_ROOT/tools/validate-dashboard.sh" &>/dev/null; then
    echo -e "${GRN}OK${NC}"
  else
    echo -e "${RED}FALLO${NC}"
    echo ""
    echo -e "${RED}  CRITICAL: dashboard.html no pasa la validación Queue v2.${NC}"
    echo -e "${YLW}  Corre 'bash tools/validate-dashboard.sh' para ver qué falta.${NC}"
    echo -e "${YLW}  NO commitear hasta restaurar los elementos faltantes.${NC}"
    ((ERRORS++))
  fi
  echo ""
fi

# ── Resumen ───────────────────────────────────────────────────────────────────
printf "  %s\n" "$(printf '─%.0s' {1..78})"
echo -e "  Copiados  : ${GRN}${#COPIED[@]}${NC}"
echo -e "  Iguales   : ${DIM}${#SKIPPED[@]}${NC}"
echo -e "  Sin VPS   : ${DIM}${#MISSING_VPS[@]}${NC}"

if [[ ${#WARNED[@]} -gt 0 ]]; then
  echo ""
  echo -e "  ${RED}CONFLICTOS — repo tenía cambios sin commitear (${#WARNED[@]} archivo/s):${NC}"
  for f in "${WARNED[@]}"; do
    echo -e "    ${YLW}→ $f${NC}"
  done
  echo ""
  echo -e "  ${YLW}Estos archivos fueron sobreescritos con la versión del VPS.${NC}"
  echo -e "  ${YLW}Si los cambios del repo eran válidos, deployarlos primero (./deploy.sh).${NC}"
fi

echo ""
if [[ $ERRORS -gt 0 ]]; then
  echo -e "  ${RED}Sync completado con $ERRORS error(es). Revisar antes de commitear.${NC}"
  exit 1
elif [[ ${#COPIED[@]} -gt 0 ]]; then
  echo -e "  ${GRN}Sync OK. Revisar con 'git diff' y luego commitear.${NC}"
else
  echo -e "  ${GRN}Todo sincronizado — no hay cambios pendientes.${NC}"
fi
echo ""
