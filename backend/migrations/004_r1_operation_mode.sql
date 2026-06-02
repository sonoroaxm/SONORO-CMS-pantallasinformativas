-- ============================================================
-- SONORO Queue v2 — R1 · Migración 004
-- Archivo: 004_r1_operation_mode.sql
-- Objetivo: ALTER branches → añadir operation_mode + CHECK +
--           UPDATE migratorio de appointments_enabled legacy +
--           índice de filtrado.
-- Pre-cond:  ejecutar después de 002/003.
-- ============================================================
-- Política DROP-deferred (framework §3.3):
--   appointments_enabled NO se elimina en R1. Se mantiene
--   convivente con operation_mode hasta R3 — punto en el que
--   todo código de lectura ya migró a operation_mode.
-- ============================================================
-- Default 'queue_only': preserva el comportamiento actual de
-- Queue v1 (sucursales sin acción explícita no cambian de modo).
-- El UPDATE migratorio promueve solo aquellas que ya tenían
-- appointments_enabled=TRUE → queue_and_appointments.
-- ============================================================
-- Idempotencia: ADD COLUMN IF NOT EXISTS + CHECK vía DO $$.
-- ============================================================

BEGIN;

\echo '== R1 · 004 · Añadiendo columna operation_mode =='

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS operation_mode VARCHAR(30) NOT NULL DEFAULT 'queue_only';

\echo '== R1 · 004 · Añadiendo CHECK operation_mode (idempotente) =='

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'branches_operation_mode_check'
  ) THEN
    ALTER TABLE branches
      ADD CONSTRAINT branches_operation_mode_check
      CHECK (operation_mode IN ('queue_only','appointments_only','queue_and_appointments'));
    RAISE NOTICE 'CHECK branches_operation_mode_check creado';
  ELSE
    RAISE NOTICE 'CHECK branches_operation_mode_check ya existía — skip';
  END IF;
END $$;

\echo '== R1 · 004 · Migración de datos: appointments_enabled=TRUE → queue_and_appointments =='

-- Solo migra filas que aún están en el default 'queue_only'. Si
-- una sucursal ya fue ajustada manualmente, no la sobre-escribe.
UPDATE branches
   SET operation_mode = 'queue_and_appointments'
 WHERE appointments_enabled = TRUE
   AND operation_mode = 'queue_only';

\echo '== R1 · 004 · Índice (user_id, operation_mode) =='

CREATE INDEX IF NOT EXISTS idx_branches_operation_mode
  ON branches (user_id, operation_mode);

\echo '== R1 · 004 · Verificación post-migración =='

SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'branches' AND column_name = 'operation_mode') AS column_present,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname = 'branches_operation_mode_check') AS check_present,
  (SELECT COUNT(*) FROM pg_indexes
   WHERE indexname = 'idx_branches_operation_mode') AS index_present,
  (SELECT COUNT(*) FROM branches WHERE operation_mode = 'queue_only') AS branches_queue_only,
  (SELECT COUNT(*) FROM branches WHERE operation_mode = 'queue_and_appointments') AS branches_dual,
  (SELECT COUNT(*) FROM branches WHERE operation_mode = 'appointments_only') AS branches_appts_only;

-- Esperado: column_present=1, check_present=1, index_present=1.
-- branches_queue_only debe coincidir con COUNT(*) WHERE appointments_enabled=FALSE.
-- branches_dual debe coincidir con COUNT(*) WHERE appointments_enabled=TRUE.
-- branches_appts_only=0 (nadie lo ha activado manualmente todavía).

COMMIT;

\echo '== R1 · 004 · Migración completada =='
