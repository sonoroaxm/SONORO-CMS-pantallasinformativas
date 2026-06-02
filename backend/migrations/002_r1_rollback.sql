-- ============================================================
-- SONORO Queue v2 — R1 · Rollback
-- Archivo: 002_r1_rollback.sql
-- Revierte: 002_r1_appointments.sql
-- ============================================================
-- ⚠️  ATENCIÓN:
--   Solo ejecutar si la migración 002 produjo inconsistencia
--   detectada en < 24h (Framework §9.2).
--   Si han pasado > 24h, no hacer rollback: aplicar rollforward.
-- ============================================================
-- Pre-condición ABORT:
--   Si appointments tiene filas creadas tras la migración 002,
--   rollback es destructivo. El script aborta si detecta filas.
-- ============================================================
-- Estrategia: revierte SOLO lo que añadió 002. NO toca:
--   · qr_code (legacy)
--   · notes (legacy)
--   · idx_appointments_branch, idx_appointments_date,
--     idx_appointments_qr (legacy de migrate-queue.js)
--   · FK appointments_branch_id_fkey, appointments_service_id_fkey,
--     fk_appointment_token (legacy)
--   · función set_updated_at() — queda para 003+ que la reutilizan
-- ============================================================
-- Backup obligatorio antes del rollback:
--   pg_dump cms_signage > /opt/backups/pre_002_rollback_$(date +%Y%m%d_%H%M).sql
-- ============================================================

BEGIN;

\echo '== R1 · 002 · Rollback: verificando que appointments siga vacía =='

DO $$
DECLARE
  row_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO row_count FROM appointments;
  IF row_count > 0 THEN
    RAISE EXCEPTION
      'appointments tiene % filas creadas tras R1 — rollback destructivo, abortar. Aplicar rollforward.',
      row_count;
  END IF;
END $$;

\echo '== R1 · 002 · Rollback: removiendo trigger updated_at =='

DROP TRIGGER IF EXISTS appointments_set_updated_at ON appointments;

\echo '== R1 · 002 · Rollback: removiendo índices R1 =='

DROP INDEX IF EXISTS idx_appointments_branch_service_time;
DROP INDEX IF EXISTS idx_appointments_user_status;
DROP INDEX IF EXISTS idx_appointments_pending_reschedule;
DROP INDEX IF EXISTS idx_appointments_client_id;
DROP INDEX IF EXISTS appointments_branch_service_slot_uniq;

\echo '== R1 · 002 · Rollback: removiendo CHECK constraints R1 =='

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_status_check') THEN
    ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;
    RAISE NOTICE 'CHECK appointments_status_check eliminado';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_origin_check') THEN
    ALTER TABLE appointments DROP CONSTRAINT appointments_origin_check;
    RAISE NOTICE 'CHECK appointments_origin_check eliminado';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_currency_at_booking_check') THEN
    ALTER TABLE appointments DROP CONSTRAINT appointments_currency_at_booking_check;
    RAISE NOTICE 'CHECK appointments_currency_at_booking_check eliminado';
  END IF;
END $$;

\echo '== R1 · 002 · Rollback: removiendo columnas R1 =='

-- ADD COLUMN IF NOT EXISTS en forward → DROP COLUMN IF EXISTS aquí.
-- Las FK constraints generadas implícitamente caen con la columna.
ALTER TABLE appointments
  DROP COLUMN IF EXISTS user_id,
  DROP COLUMN IF EXISTS origin,
  DROP COLUMN IF EXISTS parent_token_id,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS price_at_booking,
  DROP COLUMN IF EXISTS currency_at_booking;

\echo '== R1 · 002 · Rollback: revirtiendo NOT NULL en client_phone / client_id_number =='

ALTER TABLE appointments
  ALTER COLUMN client_phone     DROP NOT NULL,
  ALTER COLUMN client_id_number DROP NOT NULL;

\echo '== R1 · 002 · Rollback: status VARCHAR(30) → VARCHAR(20), DROP NOT NULL =='

-- status ya no debería tener CHECK (eliminado arriba)
ALTER TABLE appointments
  ALTER COLUMN status DROP NOT NULL,
  ALTER COLUMN status TYPE VARCHAR(20);

\echo '== R1 · 002 · Rollback: TIMESTAMPTZ → TIMESTAMP =='

-- Conversión inversa con misma zona America/Bogota.
-- Seguro porque verificamos arriba que appointments está vacía.
ALTER TABLE appointments
  ALTER COLUMN scheduled_at TYPE TIMESTAMP USING scheduled_at AT TIME ZONE 'America/Bogota',
  ALTER COLUMN created_at   TYPE TIMESTAMP USING created_at   AT TIME ZONE 'America/Bogota',
  ALTER COLUMN updated_at   TYPE TIMESTAMP USING updated_at   AT TIME ZONE 'America/Bogota';

-- Re-aplicar defaults legacy (CURRENT_TIMESTAMP en lugar de NOW())
ALTER TABLE appointments
  ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;

\echo '== R1 · 002 · Rollback: verificación post-rollback =='

SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'appointments'
     AND column_name IN ('user_id','origin','parent_token_id','created_by',
                         'price_at_booking','currency_at_booking')) AS r1_columns_remaining,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname IN ('appointments_status_check',
                     'appointments_origin_check',
                     'appointments_currency_at_booking_check')) AS r1_checks_remaining,
  (SELECT COUNT(*) FROM pg_indexes
   WHERE tablename = 'appointments'
     AND indexname IN ('idx_appointments_branch_service_time',
                       'idx_appointments_user_status',
                       'idx_appointments_pending_reschedule',
                       'idx_appointments_client_id',
                       'appointments_branch_service_slot_uniq')) AS r1_indexes_remaining,
  (SELECT COUNT(*) FROM pg_trigger
   WHERE tgname = 'appointments_set_updated_at') AS r1_trigger_remaining;

-- Esperado: todos los conteos = 0

COMMIT;

\echo '== R1 · 002 · Rollback completado =='
