#!/usr/bin/env bash
# assign-tunnel-ports.sh — feature/tunnel-ports-v1
#
# Asigna tunnel_port en rango 22200-22299 a devices RPi (rpi4/rpi5) que
# tengan tunnel_port NULL. NO toca devices win/fids (no usan tunel SSH).
# NO toca devices con puerto ya asignado (idempotente).
#
# Uso (en VPS): sudo -u postgres bash assign-tunnel-ports.sh [--dry-run]
set -euo pipefail
DB="${DB:-cms_signage}"
DRY_RUN="${1:-}"

echo "== assign-tunnel-ports.sh =="
echo "DB: $DB   dry-run: ${DRY_RUN:-false}"
echo ""

SQL_PREVIEW="
SELECT id, device_id, name, model, tunnel_port
FROM devices
WHERE tunnel_port IS NULL
  AND (model ILIKE 'rpi%' OR device_id ILIKE 'rpi%')
ORDER BY id;
"
echo "-- Candidatos (rpi con tunnel_port NULL):"
psql -d "$DB" -c "$SQL_PREVIEW"

if [ "$DRY_RUN" = "--dry-run" ]; then
  echo ""
  echo "DRY-RUN: no se asigna. Re-run sin --dry-run para aplicar."
  exit 0
fi

SQL_ASSIGN="
WITH candidates AS (
  SELECT id FROM devices
  WHERE tunnel_port IS NULL
    AND (model ILIKE 'rpi%' OR device_id ILIKE 'rpi%')
  ORDER BY id
),
free_ports AS (
  SELECT p FROM generate_series(22200, 22299) AS p
  WHERE p NOT IN (SELECT tunnel_port FROM devices WHERE tunnel_port IS NOT NULL)
  ORDER BY p
),
pairs AS (
  SELECT c.id, fp.p
  FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM candidates) c
  JOIN (SELECT p, row_number() OVER (ORDER BY p) rn FROM free_ports) fp
    ON c.rn = fp.rn
)
UPDATE devices d SET tunnel_port = p.p
FROM pairs p
WHERE d.id = p.id
RETURNING d.id, d.device_id, d.name, d.tunnel_port;
"
echo ""
echo "-- Asignando..."
psql -d "$DB" -c "$SQL_ASSIGN"
echo ""
echo "-- Estado final:"
psql -d "$DB" -c "SELECT id, device_id, name, tunnel_port FROM devices WHERE tunnel_port IS NOT NULL ORDER BY tunnel_port;"
