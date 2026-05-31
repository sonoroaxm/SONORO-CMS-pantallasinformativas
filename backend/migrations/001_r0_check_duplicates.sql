-- ============================================================
-- SONORO Queue v2 — R0 · Pre-flight check
-- Archivo: 001_r0_check_duplicates.sql
-- Propósito: detectar duplicados pre-existentes en queue_tokens
--            antes de aplicar la UNIQUE constraint.
-- ============================================================
-- Read-only. NO modifica datos. Seguro ejecutar en producción.
-- ============================================================
-- Uso:
--   sudo -u postgres psql -d cms_signage -f 001_r0_check_duplicates.sql
--
-- Interpretación:
--   - Si "duplicates_found" devuelve 0 filas → seguro aplicar 001_r0_token_uniq.sql
--   - Si devuelve ≥1 fila → ESCALAR a Daniel. NO ejecutar la migración.
--     Habrá que decidir si los duplicados se renumeran, se archivan o se borran.
-- ============================================================

\echo '== Buscando duplicados en queue_tokens (branch_id, service_id, date_key, token_number) =='

WITH duplicates_found AS (
  SELECT
    branch_id,
    service_id,
    date_key,
    token_number,
    COUNT(*)                       AS occurrences,
    ARRAY_AGG(id ORDER BY created_at)            AS token_ids,
    ARRAY_AGG(created_at ORDER BY created_at)    AS created_timestamps,
    ARRAY_AGG(status ORDER BY created_at)        AS statuses
  FROM queue_tokens
  GROUP BY branch_id, service_id, date_key, token_number
  HAVING COUNT(*) > 1
)
SELECT * FROM duplicates_found ORDER BY occurrences DESC, date_key DESC;

\echo ''
\echo '== Conteo total de duplicados =='

SELECT COUNT(*) AS duplicate_groups
FROM (
  SELECT 1
  FROM queue_tokens
  GROUP BY branch_id, service_id, date_key, token_number
  HAVING COUNT(*) > 1
) sub;

\echo ''
\echo '== Resumen de queue_tokens por sucursal/servicio (últimos 7 días) =='

SELECT
  branch_id,
  service_id,
  date_key,
  COUNT(*)             AS total_tokens,
  COUNT(DISTINCT token_number) AS distinct_token_numbers,
  COUNT(*) - COUNT(DISTINCT token_number) AS conflict_delta
FROM queue_tokens
WHERE date_key >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY branch_id, service_id, date_key
HAVING COUNT(*) <> COUNT(DISTINCT token_number)
ORDER BY date_key DESC;

\echo ''
\echo '== FIN del check =='
\echo 'Si "duplicate_groups" = 0 → seguro aplicar 001_r0_token_uniq.sql'
\echo 'Si "duplicate_groups" > 0 → DETENERSE y escalar a Daniel'
