#!/bin/bash
# deploy.sh — Despliega SONORO CMS al VPS cms.sonoro.com.co
#
# Uso (desde Git Bash en Windows):
#   ./deploy.sh           → HTML/JS/CSS + imágenes ligeras
#   ./deploy.sh --assets  → incluye también los videos (mp4, ~250MB, lento)
#
# Prerequisito: la clave SSH debe estar en la ruta definida en SSH_KEY.
# Si la moviste, edita esa variable.

SSH_KEY="/c/Users/sonor/Documents/Documentos/1. SONORO 2026/CONTRATOS-PROYECTOS/SIGNAGE PI/SERVER CON WEB/Key/ssh_sonoro.key"
VPS="debian@45.181.156.171"
VPS_PUBLIC="/opt/sonoro-cms/backend/public"
REPO="$(cd "$(dirname "$0")" && pwd)"
PUBLIC="$REPO/backend/public"

# ── flags ──────────────────────────────────────────────────────
DEPLOY_ASSETS=0
[[ "$1" == "--assets" ]] && DEPLOY_ASSETS=1

# ── helpers ────────────────────────────────────────────────────
S() { scp -i "$SSH_KEY" -o StrictHostKeyChecking=no "$@"; }
H() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$VPS" "$@"; }

ok()   { echo "  ✓ $1"; }
skip() { echo "  – $1 (sin cambios)"; }
fail() { echo "  ✗ $1 — ERROR"; exit 1; }

echo ""
echo "🚀  Deploy SONORO CMS  →  cms.sonoro.com.co"
echo "    $(date '+%Y-%m-%d %H:%M')"
echo ""

# ── 1. HTML / JS / CSS ─────────────────────────────────────────
echo "📄  HTML / JS / CSS"
for ext in html js css; do
  for f in "$PUBLIC"/*.$ext; do
    [[ -f "$f" ]] || continue
    S "$f" "$VPS:$VPS_PUBLIC/" && ok "$(basename "$f")" || fail "$(basename "$f")"
  done
done

# ── 2. Imágenes ligeras (png, jpg) ─────────────────────────────
echo ""
echo "🖼️  Imágenes"
for ext in png jpg jpeg svg; do
  for f in "$PUBLIC"/*.$ext; do
    [[ -f "$f" ]] || continue
    S "$f" "$VPS:$VPS_PUBLIC/" && ok "$(basename "$f")" || fail "$(basename "$f")"
  done
done

# Subdirectorio Procesoplataforma/
if [[ -d "$PUBLIC/Procesoplataforma" ]]; then
  H "mkdir -p $VPS_PUBLIC/Procesoplataforma"
  S "$PUBLIC/Procesoplataforma/"*.png "$VPS:$VPS_PUBLIC/Procesoplataforma/" \
    && ok "Procesoplataforma/" || fail "Procesoplataforma/"
fi

# ── 3. Videos (solo con --assets) ──────────────────────────────
if [[ $DEPLOY_ASSETS -eq 1 ]]; then
  echo ""
  echo "🎬  Videos (esto puede tardar varios minutos)..."
  for f in "$PUBLIC"/*.mp4 "$PUBLIC"/*.webm "$PUBLIC"/*.mov; do
    [[ -f "$f" ]] || continue
    size=$(du -sh "$f" 2>/dev/null | cut -f1)
    echo "    Subiendo $(basename "$f") ($size)..."
    S "$f" "$VPS:$VPS_PUBLIC/" && ok "$(basename "$f")" || fail "$(basename "$f")"
  done
fi

# ── 4. Verificación rápida ─────────────────────────────────────
echo ""
echo "🔍  Verificando..."
http_code=$(curl -sk -o /dev/null -w '%{http_code}' https://cms.sonoro.com.co/)
if [[ "$http_code" == "200" ]]; then
  echo "  ✓ cms.sonoro.com.co/ responde HTTP $http_code"
else
  echo "  ⚠ cms.sonoro.com.co/ responde HTTP $http_code — revisar nginx"
fi

echo ""
echo "✅  Deploy completado."
echo ""
echo "Próximo paso: git add -A && git commit -m 'deploy: $(date +%Y-%m-%d)'"
echo ""
