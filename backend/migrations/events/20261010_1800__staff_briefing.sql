-- S208j — Email de briefing al staff del evento (manual trigger)
-- Agrega texto libre personalizado por staff + timestamp del último envío.
-- Forward-only. Reversible por feature flag users.features.events_v1.

ALTER TABLE events.event_staff
  ADD COLUMN IF NOT EXISTS custom_briefing   TEXT,
  ADD COLUMN IF NOT EXISTS briefing_sent_at  TIMESTAMPTZ;

-- Index parcial para "staff sin briefing enviado" (listados del productor)
CREATE INDEX IF NOT EXISTS idx_staff_briefing_pending
  ON events.event_staff (event_id)
  WHERE briefing_sent_at IS NULL;
