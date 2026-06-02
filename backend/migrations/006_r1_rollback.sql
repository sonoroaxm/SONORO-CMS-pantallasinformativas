-- ============================================================
-- SONORO Queue v2 — R1 · Rollback
-- Archivo: 006_r1_rollback.sql
-- Revierte: 006_r1_slot_duration.sql
-- ============================================================
-- ⚠️  ATENCIÓN:
--   Solo ejecutar si la migración 006 produjo inconsistencia
--   detectada en < 24h (Framework §9.2).
--   Si han pasado > 24h, no hacer rollback: aplicar rollforward.
-- ============================================================
-- Este rollback elimina una columna con potenciales datos
-- configurados por admins. Pre-condición: si hay filas con
-- slot_duration_minutes IS NOT NULL, abortar — son valores
-- deliberados que el rollback perdería silenciosamente.
-- ============================================================

BEGIN;

\echo '== R1 · 006 · Rollback: verificando que no haya duraciones explícitas =='

DO $$
DECLARE
  configured_count INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='services' AND column_name='slot_duration_minutes') THEN
    SELECT COUNT(*) INTO configured_count
      FROM services WHERE slot_duration_minutes IS NOT NULL;
    IF configured_count > 0 THEN
      RAISE EXCEPTION
        'services tiene % filas con slot_duration_minutes IS NOT NULL — rollback destructivo, abortar. Aplicar rollforward.',
        configured_count;
    END IF;
  END IF;
END $$;

\echo '== R1 · 006 · Rollback: removiendo CHECK =='

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'services_slot_duration_minutes_check') THEN
    ALTER TABLE services DROP CONSTRAINT services_slot_duration_minutes_check;
    RAISE NOTICE 'CHECK services_slot_duration_minutes_check eliminado';
  END IF;
END $$;

\echo '== R1 · 006 · Rollback: removiendo columna slot_duration_minutes =='

ALTER TABLE services
  DROP COLUMN IF EXISTS slot_duration_minutes;

\echo '== R1 · 006 · Rollback: verificación post-rollback =='

SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'services' AND column_name = 'slot_duration_minutes') AS column_remaining,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname = 'services_slot_duration_minutes_check') AS check_remaining,
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'services' AND column_name = 'avg_attention_min') AS legacy_preserved;

-- Esperado: column_remaining=0, check_remaining=0,
--           legacy_preserved=1 (avg_attention_min intacto).

COMMIT;

\echo '== R1 · 006 · Rollback completado =='
