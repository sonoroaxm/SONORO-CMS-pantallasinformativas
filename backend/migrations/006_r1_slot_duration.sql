-- ============================================================
-- SONORO Queue v2 — R1 · Migración 006
-- Archivo: 006_r1_slot_duration.sql
-- Objetivo: ALTER services → añadir slot_duration_minutes.
-- Pre-cond: ejecutar después de 002/003/004/005.
-- ============================================================
-- Origen de la decisión (sesión 65):
--   Verificación SSH read-only descubrió que services.slot_duration_minutes
--   no existe (a diferencia de lo afirmado en R1-PLAN §2.5 ≤v1.3).
--   Existe services.avg_attention_min (INTEGER) que sirve como fallback
--   natural. Esta migración añade el campo dedicado; el endpoint
--   GET /api/queue/appointments/slots usa:
--     COALESCE(slot_duration_minutes, avg_attention_min, 30)
--   donde 30 es el último fallback si ambos son NULL.
--
--   El campo permite que el admin afine la grilla independiente de la
--   duración promedio de atención (p.ej. servicio de atención=45 min
--   pero slots cada 60 min por buffer de seguridad).
-- ============================================================
-- Idempotencia: ADD COLUMN IF NOT EXISTS + CHECK vía DO $$.
-- ============================================================

BEGIN;

\echo '== R1 · 006 · Añadiendo columna slot_duration_minutes a services =='

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS slot_duration_minutes INTEGER;

\echo '== R1 · 006 · CHECK rango [5,480] (idempotente) =='

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'services_slot_duration_minutes_check'
  ) THEN
    ALTER TABLE services
      ADD CONSTRAINT services_slot_duration_minutes_check
      CHECK (slot_duration_minutes IS NULL
             OR (slot_duration_minutes BETWEEN 5 AND 480));
    RAISE NOTICE 'CHECK services_slot_duration_minutes_check creado';
  ELSE
    RAISE NOTICE 'CHECK services_slot_duration_minutes_check ya existía — skip';
  END IF;
END $$;

\echo '== R1 · 006 · Verificación post-migración =='

SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'services' AND column_name = 'slot_duration_minutes') AS column_present,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname = 'services_slot_duration_minutes_check') AS check_present,
  (SELECT COUNT(*) FROM services WHERE slot_duration_minutes IS NULL) AS services_without_explicit_duration;

-- Esperado: column_present=1, check_present=1.
-- services_without_explicit_duration = COUNT(*) FROM services al inicio
-- (todos NULL — admins definirán explícitamente en Configuración cuando
-- quieran sobreescribir avg_attention_min).

COMMIT;

\echo '== R1 · 006 · Migración completada =='
