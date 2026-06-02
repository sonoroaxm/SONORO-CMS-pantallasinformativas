-- ============================================================
-- SONORO Queue v2 — R1 · Migración forward
-- Archivo: 002_r1_appointments.sql
-- Propósito:
--   Adaptar la tabla `appointments` (creada huérfana por
--   migrate-queue.js, 0 filas en producción al 01/06/2026) al
--   contrato R1-PLAN v1.3 §1.2:
--     · Multi-tenancy: user_id NOT NULL (Principio 2.2)
--     · TZ-aware: scheduled_at/created_at/updated_at TIMESTAMPTZ
--     · Status enum con CHECK (6 valores)
--     · Origin enum con CHECK (3 valores) — admin/follow_up/kiosk_future
--     · Snapshot inmutable de precio (sesión 53)
--     · 4 columnas multi-rol: parent_token_id, created_by, price_at_booking, currency_at_booking
--     · 4 índices del hot-path (incluye partial pending_reschedule)
--     · Trigger updated_at
--   Mantiene:
--     · id UUID (forzado por FK entrante queue_tokens.appointment_id UUID)
--     · qr_code VARCHAR(100) UNIQUE (legado, no estorba; se promueve a R1.5)
--     · notes VARCHAR(500) (legado, queda como campo libre admin)
--     · FK appointments_branch_id_fkey, appointments_service_id_fkey, fk_appointment_token
-- ============================================================
-- Estrategia: ADD-only + type widening sobre tabla vacía.
--   Cero DROP de columna. Cero DROP de tabla. Respeta Principio 2.4
--   (backward-compat de migraciones) en su lectura literal.
-- ============================================================
-- Precondición:
--   appointments con 0 filas (verificado por SSH read-only sesión 62).
--   Si esta migración corre con filas existentes, los ALTER TYPE de
--   timestamp → timestamptz usan zona 'America/Bogota' (timezone por
--   defecto de branches en el sistema). Documentado en R1-PLAN §1.2.
-- ============================================================
-- Backup obligatorio (Framework §7.2):
--   pg_dump cms_signage > /opt/backups/pre_002_$(date +%Y%m%d_%H%M).sql
-- ============================================================
-- Uso:
--   sudo -u postgres psql -d cms_signage -f 002_r1_appointments.sql
--
-- Rollback:
--   sudo -u postgres psql -d cms_signage -f 002_r1_rollback.sql
-- ============================================================
-- Idempotencia: cada cambio está envuelto en un DO $$ con verificación
--   de catálogo o usa la sintaxis IF [NOT] EXISTS. Correr dos veces
--   seguidas no falla y deja el estado final igual.
-- ============================================================

BEGIN;

\echo '== R1 · 002 · Asegurando extensión uuid-ossp =='
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ────────────────────────────────────────────────────────────
-- 1. Función trigger updated_at (genérica, reutilizable por R1+)
-- ────────────────────────────────────────────────────────────
\echo '== R1 · 002 · Creando función set_updated_at() =='

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────────────────────
-- 2. ALTER TYPE: scheduled_at, created_at, updated_at → TIMESTAMPTZ
--    Seguro: tabla vacía. Zona America/Bogota como conversión por
--    defecto (alineada con branches.timezone DEFAULT).
-- ────────────────────────────────────────────────────────────
\echo '== R1 · 002 · Migrando timestamps a TIMESTAMPTZ =='

DO $$
BEGIN
  -- scheduled_at
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'appointments'
      AND column_name = 'scheduled_at'
      AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE appointments
      ALTER COLUMN scheduled_at TYPE TIMESTAMPTZ
      USING scheduled_at AT TIME ZONE 'America/Bogota';
    RAISE NOTICE 'appointments.scheduled_at migrada a TIMESTAMPTZ';
  ELSE
    RAISE NOTICE 'appointments.scheduled_at ya es TIMESTAMPTZ — skip';
  END IF;

  -- created_at
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'appointments'
      AND column_name = 'created_at'
      AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE appointments
      ALTER COLUMN created_at TYPE TIMESTAMPTZ
      USING created_at AT TIME ZONE 'America/Bogota';
    ALTER TABLE appointments
      ALTER COLUMN created_at SET DEFAULT NOW();
    RAISE NOTICE 'appointments.created_at migrada a TIMESTAMPTZ';
  ELSE
    RAISE NOTICE 'appointments.created_at ya es TIMESTAMPTZ — skip';
  END IF;

  -- updated_at
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'appointments'
      AND column_name = 'updated_at'
      AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE appointments
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ
      USING updated_at AT TIME ZONE 'America/Bogota';
    ALTER TABLE appointments
      ALTER COLUMN updated_at SET DEFAULT NOW();
    RAISE NOTICE 'appointments.updated_at migrada a TIMESTAMPTZ';
  ELSE
    RAISE NOTICE 'appointments.updated_at ya es TIMESTAMPTZ — skip';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- 3. status: VARCHAR(20) → VARCHAR(30) + NOT NULL + CHECK enum
-- ────────────────────────────────────────────────────────────
\echo '== R1 · 002 · Endureciendo columna status =='

DO $$
DECLARE
  current_len INTEGER;
BEGIN
  SELECT character_maximum_length INTO current_len
  FROM information_schema.columns
  WHERE table_name = 'appointments' AND column_name = 'status';

  IF current_len < 30 THEN
    ALTER TABLE appointments
      ALTER COLUMN status TYPE VARCHAR(30);
    RAISE NOTICE 'appointments.status ampliada a VARCHAR(30)';
  ELSE
    RAISE NOTICE 'appointments.status ya tiene longitud >= 30 — skip';
  END IF;
END $$;

-- NOT NULL (la tabla está vacía, no requiere backfill)
ALTER TABLE appointments
  ALTER COLUMN status SET NOT NULL;

-- CHECK enum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'appointments_status_check'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_status_check
      CHECK (status IN (
        'pending','confirmed','attended',
        'no_show','cancelled','pending_reschedule'
      ));
    RAISE NOTICE 'CHECK appointments_status_check añadido';
  ELSE
    RAISE NOTICE 'CHECK appointments_status_check ya existe — skip';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- 4. client_phone y client_id_number → NOT NULL
--    Tabla vacía: SET NOT NULL es operación O(0).
-- ────────────────────────────────────────────────────────────
\echo '== R1 · 002 · Forzando NOT NULL en client_phone y client_id_number =='

ALTER TABLE appointments
  ALTER COLUMN client_phone     SET NOT NULL,
  ALTER COLUMN client_id_number SET NOT NULL;

-- ────────────────────────────────────────────────────────────
-- 5. Columnas nuevas (ADD COLUMN IF NOT EXISTS — idempotente)
-- ────────────────────────────────────────────────────────────
\echo '== R1 · 002 · Añadiendo columnas R1 =='

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS user_id              INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS origin               VARCHAR(30) DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS parent_token_id      UUID REFERENCES queue_tokens(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS price_at_booking     NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS currency_at_booking  CHAR(3);

-- user_id NOT NULL: tabla vacía, seguro
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'appointments'
      AND column_name = 'user_id'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE appointments
      ALTER COLUMN user_id SET NOT NULL;
    RAISE NOTICE 'appointments.user_id SET NOT NULL';
  ELSE
    RAISE NOTICE 'appointments.user_id ya es NOT NULL — skip';
  END IF;
END $$;

-- CHECK origin
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'appointments_origin_check'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_origin_check
      CHECK (origin IN ('admin','follow_up','kiosk_future'));
    RAISE NOTICE 'CHECK appointments_origin_check añadido';
  ELSE
    RAISE NOTICE 'CHECK appointments_origin_check ya existe — skip';
  END IF;
END $$;

-- CHECK currency_at_booking
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'appointments_currency_at_booking_check'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_currency_at_booking_check
      CHECK (currency_at_booking IS NULL OR currency_at_booking ~ '^[A-Z]{3}$');
    RAISE NOTICE 'CHECK appointments_currency_at_booking_check añadido';
  ELSE
    RAISE NOTICE 'CHECK appointments_currency_at_booking_check ya existe — skip';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- 6. Índices hot-path R1 (los legacy idx_appointments_branch,
--    idx_appointments_date e idx_appointments_qr se conservan)
-- ────────────────────────────────────────────────────────────
\echo '== R1 · 002 · Creando índices R1 =='

CREATE INDEX IF NOT EXISTS idx_appointments_branch_service_time
  ON appointments (branch_id, service_id, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_appointments_user_status
  ON appointments (user_id, status);

CREATE INDEX IF NOT EXISTS idx_appointments_pending_reschedule
  ON appointments (user_id) WHERE status = 'pending_reschedule';

CREATE INDEX IF NOT EXISTS idx_appointments_client_id
  ON appointments (user_id, client_id_number);

-- UNIQUE parcial backstop contra doble-booking del mismo slot.
-- El endpoint POST /api/queue/appointments usa SELECT ... FOR UPDATE
-- + advisory lock; este índice es la red de seguridad a nivel storage.
-- Si dos requests escapan el lock, una recibe 23505 y el endpoint
-- reintenta (patrón R0).
CREATE UNIQUE INDEX IF NOT EXISTS appointments_branch_service_slot_uniq
  ON appointments (branch_id, service_id, scheduled_at)
  WHERE status IN ('pending','confirmed');

-- ────────────────────────────────────────────────────────────
-- 7. Trigger updated_at
-- ────────────────────────────────────────────────────────────
\echo '== R1 · 002 · Conectando trigger updated_at =='

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'appointments_set_updated_at'
      AND tgrelid = 'appointments'::regclass
  ) THEN
    CREATE TRIGGER appointments_set_updated_at
      BEFORE UPDATE ON appointments
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    RAISE NOTICE 'Trigger appointments_set_updated_at creado';
  ELSE
    RAISE NOTICE 'Trigger appointments_set_updated_at ya existe — skip';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- 8. Verificación post-migración
-- ────────────────────────────────────────────────────────────
\echo '== R1 · 002 · Verificación =='

SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'appointments'
     AND column_name IN ('user_id','origin','parent_token_id','created_by',
                         'price_at_booking','currency_at_booking')) AS new_columns_present,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname IN ('appointments_status_check',
                     'appointments_origin_check',
                     'appointments_currency_at_booking_check')) AS new_checks_present,
  (SELECT COUNT(*) FROM pg_indexes
   WHERE tablename = 'appointments'
     AND indexname IN ('idx_appointments_branch_service_time',
                       'idx_appointments_user_status',
                       'idx_appointments_pending_reschedule',
                       'idx_appointments_client_id',
                       'appointments_branch_service_slot_uniq')) AS new_indexes_present,
  (SELECT COUNT(*) FROM pg_trigger
   WHERE tgname = 'appointments_set_updated_at') AS trigger_present;

-- Esperado: new_columns_present=6, new_checks_present=3,
--           new_indexes_present=5, trigger_present=1

COMMIT;

\echo '== R1 · 002 · Migración aplicada con éxito =='
