-- ============================================================
-- SONORO Queue v2 — R1 · Rollback
-- Archivo: 005_r1_rollback.sql
-- Revierte: 005_r1_price_snapshot.sql
-- ============================================================
-- ⚠️  ATENCIÓN:
--   Solo ejecutar si la migración 005 produjo inconsistencia
--   detectada en < 24h (Framework §9.2).
--   Si han pasado > 24h, no hacer rollback: aplicar rollforward.
-- ============================================================
-- Este rollback elimina columnas con datos (potencialmente
-- valores de precio capturados por admins). Pre-condición:
-- si hay filas con price IS NOT NULL, abortar — son datos
-- de configuración deliberados que rollback perdería.
--
-- NO toca appointments.price_at_booking / currency_at_booking
-- (creadas por 002, no por 005).
-- ============================================================

BEGIN;

\echo '== R1 · 005 · Rollback: verificando que no haya precios capturados =='

DO $$
DECLARE
  priced_count INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='services' AND column_name='price') THEN
    SELECT COUNT(*) INTO priced_count FROM services WHERE price IS NOT NULL;
    IF priced_count > 0 THEN
      RAISE EXCEPTION
        'services tiene % filas con price IS NOT NULL — rollback destructivo, abortar. Aplicar rollforward.',
        priced_count;
    END IF;
  END IF;
END $$;

\echo '== R1 · 005 · Rollback: removiendo CHECK currency =='

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'services_currency_check') THEN
    ALTER TABLE services DROP CONSTRAINT services_currency_check;
    RAISE NOTICE 'CHECK services_currency_check eliminado';
  END IF;
END $$;

\echo '== R1 · 005 · Rollback: removiendo columnas price + currency =='

ALTER TABLE services
  DROP COLUMN IF EXISTS currency,
  DROP COLUMN IF EXISTS price;

\echo '== R1 · 005 · Rollback: verificación post-rollback =='

SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'services' AND column_name IN ('price','currency')) AS columns_remaining,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname = 'services_currency_check') AS check_remaining,
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'appointments'
     AND column_name IN ('price_at_booking','currency_at_booking')) AS snapshot_preserved;

-- Esperado: columns_remaining=0, check_remaining=0,
--           snapshot_preserved=2 (intactos, son de migración 002).

COMMIT;

\echo '== R1 · 005 · Rollback completado =='
