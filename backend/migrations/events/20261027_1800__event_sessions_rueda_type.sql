-- S212 — E-RN-11 · event_sessions soporta tipo 'rueda' vinculado a Rueda hija
-- Semántica: una sesión del evento padre con session_type='rueda' apunta vía
-- linked_rueda_id a un events.events(id) hijo (parent_event_id = padre). La vista
-- producción detecta este tipo y renderiza el bloque KPI mini. Libreto intacto.

-- 1) Ampliar enum session_type
ALTER TABLE events.event_sessions
  DROP CONSTRAINT IF EXISTS event_sessions_session_type_check;

ALTER TABLE events.event_sessions
  ADD CONSTRAINT event_sessions_session_type_check
  CHECK (session_type IN ('plenary','breakout','workshop','meal','social','other','rueda'));

-- 2) Vínculo a evento hijo tipo Rueda
ALTER TABLE events.event_sessions
  ADD COLUMN IF NOT EXISTS linked_rueda_id UUID NULL
    REFERENCES events.events(id) ON DELETE SET NULL;

-- 3) Índice parcial para lookup rápido desde producción
CREATE INDEX IF NOT EXISTS idx_event_sessions_rueda
  ON events.event_sessions (event_id, linked_rueda_id)
  WHERE session_type = 'rueda';

-- 4) Guard rail — si tipo=rueda entonces linked_rueda_id debe estar presente
ALTER TABLE events.event_sessions
  DROP CONSTRAINT IF EXISTS event_sessions_rueda_requires_link;

ALTER TABLE events.event_sessions
  ADD CONSTRAINT event_sessions_rueda_requires_link
  CHECK (session_type <> 'rueda' OR linked_rueda_id IS NOT NULL);
