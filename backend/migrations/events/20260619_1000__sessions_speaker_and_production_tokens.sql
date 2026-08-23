-- S145 — Refactor Libreto → Producción
-- 1) speaker_name en event_sessions
-- 2) production_tokens para URLs públicas (dashboard productor + teleprompter por sesión)

SET search_path TO events, public;

ALTER TABLE events.event_sessions
  ADD COLUMN IF NOT EXISTS speaker_name VARCHAR(120);

CREATE TABLE IF NOT EXISTS events.production_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  session_id UUID NULL REFERENCES events.event_sessions(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('produccion','teleprompter')),
  token UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ NULL,
  CONSTRAINT production_tokens_teleprompter_needs_session
    CHECK (kind = 'produccion' OR session_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_production_tokens_token
  ON events.production_tokens(token) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_production_tokens_event
  ON events.production_tokens(event_id, kind);
CREATE INDEX IF NOT EXISTS idx_production_tokens_session
  ON events.production_tokens(session_id) WHERE session_id IS NOT NULL;
