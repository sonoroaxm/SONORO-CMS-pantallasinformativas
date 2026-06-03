-- Migration 008 — R1.5 Reservas Públicas
-- Sesión 77 — 2026-06-03
-- Forward-only. Rollback vía public_booking_mode='disabled' en branches.

-- Identificador de URL para reservas públicas por tenant
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS public_slug VARCHAR(60) UNIQUE;

CREATE INDEX IF NOT EXISTS idx_users_public_slug
  ON users (public_slug)
  WHERE public_slug IS NOT NULL;

-- Modo de reserva pública por sucursal
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS public_booking_mode VARCHAR(10) DEFAULT 'disabled'
    CHECK (public_booking_mode IN ('auto','manual','disabled'));

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS public_booking_captcha BOOLEAN DEFAULT FALSE;

-- Tokens de un solo uso para modificar/cancelar cita pública
CREATE TABLE IF NOT EXISTS public_appointment_tokens (
  token           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  appointment_id  UUID    NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  action_allowed  VARCHAR(20) NOT NULL
    CHECK (action_allowed IN ('reschedule','cancel','both')),
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_public_appt_tokens_appt
  ON public_appointment_tokens (appointment_id);

-- Ampliar CHECK constraint de origin para admitir reservas públicas
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_origin_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_origin_check
  CHECK (origin IN ('admin','follow_up','kiosk_future','public'));

-- Permisos para el usuario de la aplicación
GRANT SELECT, INSERT, UPDATE ON public_appointment_tokens TO sonoro_db;
