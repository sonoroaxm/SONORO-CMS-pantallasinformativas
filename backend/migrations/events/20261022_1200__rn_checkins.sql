-- =====================================================================
-- Rueda de Negocios v1 — tabla rn_checkins (E-RN-5)
-- Framework §4.3 — presencia por delegado por evento
-- Aditivo. Reemplaza proxy custom_fields.rn_absent del stub E-RN-3.
-- =====================================================================

SET search_path TO events, public;

CREATE TABLE IF NOT EXISTS events.rn_checkins (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  delegate_id     UUID NOT NULL REFERENCES events.rn_delegates(id) ON DELETE CASCADE,
  checked_in_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method          VARCHAR(20) NOT NULL DEFAULT 'self'
                  CHECK (method IN ('self','staff','qr','admin')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, delegate_id)
);
CREATE INDEX IF NOT EXISTS idx_rn_checkins_event ON events.rn_checkins (event_id, checked_in_at);
