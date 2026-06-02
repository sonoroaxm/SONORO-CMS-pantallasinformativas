-- ============================================================
-- SONORO Queue v2 — R1 · Migración 005
-- Archivo: 005_r1_price_snapshot.sql
-- Objetivo: ALTER services → añadir price + currency.
-- Pre-cond:  ejecutar después de 002/003/004.
-- ============================================================
-- Decisión sesión 53 (firmada por Daniel):
--   · services.price NUMERIC(10,2) NULL — un precio por servicio,
--     sin variación por sucursal en R1.
--   · services.currency CHAR(3) DEFAULT 'COP' — ISO 4217.
--   · NULL inicial: admin debe definir explícitamente en
--     Configuración antes de que el precio aparezca en revenue.
--
-- Snapshot histórico ya está en appointments.price_at_booking +
-- appointments.currency_at_booking (creados en migración 002).
-- Esta migración solo agrega las columnas fuente en services.
-- ============================================================
-- Visibilidad UI (refinada sesión 54):
--   · Admin Configuración: sí — fuente de verdad.
--   · Admin Dashboard: sí, agregado (revenue card).
--   · Admin Vista del día: NO (timeline es operativo, no finanzas).
--   · Agente: pendiente (default oculto a menos que feature flag).
--   · Kiosko y Público R1.5: NO (enforced en serializador).
-- ============================================================
-- Idempotencia: ADD COLUMN IF NOT EXISTS + CHECK vía DO $$.
-- ============================================================

BEGIN;

\echo '== R1 · 005 · Añadiendo columnas price + currency a services =='

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS price    NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS currency CHAR(3) DEFAULT 'COP';

\echo '== R1 · 005 · CHECK currency ISO 4217 (idempotente) =='

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'services_currency_check'
  ) THEN
    ALTER TABLE services
      ADD CONSTRAINT services_currency_check
      CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
    RAISE NOTICE 'CHECK services_currency_check creado';
  ELSE
    RAISE NOTICE 'CHECK services_currency_check ya existía — skip';
  END IF;
END $$;

\echo '== R1 · 005 · Verificación post-migración =='

SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'services' AND column_name IN ('price','currency')) AS new_columns_present,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname = 'services_currency_check') AS check_present,
  (SELECT COUNT(*) FROM services WHERE price IS NULL) AS services_without_price,
  (SELECT COUNT(*) FROM services WHERE currency = 'COP') AS services_currency_cop;

-- Esperado: new_columns_present=2, check_present=1.
-- services_without_price = COUNT(*) FROM services al inicio (nadie tenía precio).
-- services_currency_cop  = COUNT(*) FROM services (default aplicó a todos).

COMMIT;

\echo '== R1 · 005 · Migración completada =='
