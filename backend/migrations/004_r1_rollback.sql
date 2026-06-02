-- ============================================================
-- SONORO Queue v2 — R1 · Rollback
-- Archivo: 004_r1_rollback.sql
-- Revierte: 004_r1_operation_mode.sql
-- ============================================================
-- ⚠️  ATENCIÓN:
--   Solo ejecutar si la migración 004 produjo inconsistencia
--   detectada en < 24h (Framework §9.2).
--   Si han pasado > 24h, no hacer rollback: aplicar rollforward.
-- ============================================================
-- Esta migración es un ADD COLUMN puro: el rollback es seguro
-- incluso con datos vivos porque solo elimina la columna
-- añadida (no toca appointments_enabled legacy).
--
-- NO se chequea pre-condición de filas — la información
-- importante (qué sucursales tienen citas activas) sigue viva
-- en appointments_enabled, que esta migración nunca tocó.
-- ============================================================

BEGIN;

\echo '== R1 · 004 · Rollback: removiendo índice =='

DROP INDEX IF EXISTS idx_branches_operation_mode;

\echo '== R1 · 004 · Rollback: removiendo CHECK =='

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'branches_operation_mode_check') THEN
    ALTER TABLE branches DROP CONSTRAINT branches_operation_mode_check;
    RAISE NOTICE 'CHECK branches_operation_mode_check eliminado';
  END IF;
END $$;

\echo '== R1 · 004 · Rollback: removiendo columna operation_mode =='

ALTER TABLE branches DROP COLUMN IF EXISTS operation_mode;

\echo '== R1 · 004 · Rollback: verificación post-rollback =='

SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'branches' AND column_name = 'operation_mode') AS column_remaining,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname = 'branches_operation_mode_check') AS check_remaining,
  (SELECT COUNT(*) FROM pg_indexes
   WHERE indexname = 'idx_branches_operation_mode') AS index_remaining,
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'branches' AND column_name = 'appointments_enabled') AS legacy_preserved;

-- Esperado: column_remaining=0, check_remaining=0, index_remaining=0,
--           legacy_preserved=1 (appointments_enabled intacto).

COMMIT;

\echo '== R1 · 004 · Rollback completado =='
