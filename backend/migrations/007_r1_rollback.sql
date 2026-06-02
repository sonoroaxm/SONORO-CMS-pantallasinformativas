-- ============================================================
-- SONORO Queue v2 — R1 · Rollback
-- Archivo: 007_r1_rollback.sql
-- Revierte: 007_r1_kiosk_token.sql
-- ============================================================
-- ⚠️  ATENCIÓN:
--   Solo ejecutar si la migración 007 produjo inconsistencia
--   detectada en < 24h (Framework §9.2).
--   Si han pasado > 24h, no hacer rollback: aplicar rollforward.
-- ============================================================
-- Anti-destructive:
--   Si alguna sucursal ACTIVA tiene un kiosko en uso, su tablet/pantalla
--   tiene el token cacheado y dejará de funcionar tras DROP COLUMN.
--   Conservador: abortar si existen branches activas (active = true)
--   con kiosk_token NOT NULL — Daniel debe deshabilitar branches o
--   coordinar el corte de kioskos antes del rollback.
-- ============================================================

BEGIN;

\echo '== R1 · 007 · Rollback: verificando que no haya kioskos potencialmente activos =='

DO $$
DECLARE
  active_with_token INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='branches' AND column_name='kiosk_token') THEN
    SELECT COUNT(*) INTO active_with_token
      FROM branches
      WHERE kiosk_token IS NOT NULL AND active = true;
    IF active_with_token > 0 THEN
      RAISE EXCEPTION
        'branches tiene % filas activas con kiosk_token IS NOT NULL — rollback destructivo (kioskos cacheados dejarían de funcionar), abortar. Deshabilitar branches o coordinar corte antes de rollback.',
        active_with_token;
    END IF;
  END IF;
END $$;

\echo '== R1 · 007 · Rollback: removiendo UNIQUE constraint =='

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'branches_kiosk_token_uniq') THEN
    ALTER TABLE branches DROP CONSTRAINT branches_kiosk_token_uniq;
    RAISE NOTICE 'UNIQUE constraint branches_kiosk_token_uniq eliminado';
  END IF;
END $$;

\echo '== R1 · 007 · Rollback: removiendo columna kiosk_token =='

ALTER TABLE branches
  DROP COLUMN IF EXISTS kiosk_token;

\echo '== R1 · 007 · Rollback: verificación post-rollback =='

SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'branches' AND column_name = 'kiosk_token') AS column_remaining,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname = 'branches_kiosk_token_uniq') AS unique_remaining;

-- Esperado: column_remaining=0, unique_remaining=0.

COMMIT;

\echo '== R1 · 007 · Rollback completado =='
