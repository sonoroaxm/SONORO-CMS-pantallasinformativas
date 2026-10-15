-- E3.5 — Sessions visibility + Event registration mode
-- Aditiva. Defaults preservan comportamiento actual (public + per_session).
-- Rollback: feature flag users.features.events_v1 cubre todo el módulo;
--           además las columnas son safe-drop si urge revertir.

SET search_path TO events, public;

ALTER TABLE events.event_sessions
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'public';

ALTER TABLE events.event_sessions
  DROP CONSTRAINT IF EXISTS event_sessions_visibility_chk;

ALTER TABLE events.event_sessions
  ADD CONSTRAINT event_sessions_visibility_chk
    CHECK (visibility IN ('public','private','invite_only'));

CREATE INDEX IF NOT EXISTS idx_event_sessions_visibility
  ON events.event_sessions(event_id, visibility);

ALTER TABLE events.events
  ADD COLUMN IF NOT EXISTS registration_mode VARCHAR(16) NOT NULL DEFAULT 'per_session';

ALTER TABLE events.events
  DROP CONSTRAINT IF EXISTS events_registration_mode_chk;

ALTER TABLE events.events
  ADD CONSTRAINT events_registration_mode_chk
    CHECK (registration_mode IN ('full_event','per_session'));

COMMENT ON COLUMN events.event_sessions.visibility IS
  'public = visible a todos; private = solo asigna el productor; invite_only = requiere token de invitación válido';

COMMENT ON COLUMN events.events.registration_mode IS
  'full_event = al inscribirse se registra a TODAS las sesiones visibles; per_session = el asistente elige';
