-- Sesiones privadas con link compartible (CP1)
-- Añade share_token UUID a event_sessions para habilitar inscripción pública
-- vía URL única cuando la sesión es visibility='invite_only'.

ALTER TABLE events.event_sessions ADD COLUMN IF NOT EXISTS share_token UUID;

CREATE UNIQUE INDEX IF NOT EXISTS event_sessions_share_token_uniq
  ON events.event_sessions(share_token)
  WHERE share_token IS NOT NULL;

-- Backfill: sesiones invite_only existentes reciben un token para que el flujo
-- quede operable sin re-save manual.
UPDATE events.event_sessions
   SET share_token = gen_random_uuid()
 WHERE visibility = 'invite_only' AND share_token IS NULL;
