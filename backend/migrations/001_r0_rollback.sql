-- ============================================================
-- SONORO Queue v2 — R0 · Rollback
-- Archivo: 001_r0_rollback.sql
-- Revierte: 001_r0_token_uniq.sql
-- ============================================================
-- ⚠️  ATENCIÓN:
--   Solo ejecutar si la migración 001 produjo inconsistencia
--   detectada en < 24h (Framework §9.2).
--   Si han pasado > 24h, no hacer rollback: aplicar rollforward.
-- ============================================================
-- Backup obligatorio antes del rollback:
--   pg_dump cms_signage > /opt/backups/pre_001_rollback_$(date +%Y%m%d_%H%M).sql
-- ============================================================

BEGIN;

\echo '== R0 · Rollback: removiendo UNIQUE constraint =='

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'queue_tokens_branch_service_date_token_uniq'
  ) THEN
    ALTER TABLE queue_tokens
      DROP CONSTRAINT queue_tokens_branch_service_date_token_uniq;
    RAISE NOTICE 'Constraint queue_tokens_branch_service_date_token_uniq eliminada';
  ELSE
    RAISE NOTICE 'Constraint queue_tokens_branch_service_date_token_uniq no existe — skip';
  END IF;
END $$;

\echo '== R0 · Rollback: eliminando idempotency_keys =='

-- ⚠️  Si idempotency_keys tiene datos de R2+, ABORTAR rollback aquí
DO $$
DECLARE
  row_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO row_count FROM idempotency_keys;
  IF row_count > 0 THEN
    RAISE EXCEPTION 'idempotency_keys tiene % filas — NO se puede rollback sin pérdida. Abortar.', row_count;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_idempotency_keys_user_endpoint;
DROP INDEX IF EXISTS idx_idempotency_keys_expires;
DROP TABLE IF EXISTS idempotency_keys;

\echo '== R0 · Verificación post-rollback =='

SELECT
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname = 'queue_tokens_branch_service_date_token_uniq') AS uniq_constraint_present,
  (SELECT COUNT(*) FROM information_schema.tables
   WHERE table_name = 'idempotency_keys') AS idempotency_table_present;

COMMIT;

\echo '== R0 · Rollback completado =='
