-- Add opened_at to rn_rounds so Live callboard can detect the active round.
-- Forward-only, nullable, no backfill needed (rounds not opened = NULL).

SET search_path TO events, public;

ALTER TABLE events.rn_rounds
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

COMMENT ON COLUMN events.rn_rounds.opened_at IS 'Timestamp when the producer opens the round (Live callboard)';
COMMENT ON COLUMN events.rn_rounds.closed_at IS 'Timestamp when the producer closes the round';
