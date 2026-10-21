-- =====================================================================
-- Rueda de Negocios — Consistencia event_id entre rn_meetings y rn_rounds
-- Gap 4 identificado en validación E-RN-0.
-- Forward-only.
-- =====================================================================

-- rn_meetings.event_id está denormalizado para queries multi-tenancy
-- rápidas. Este trigger garantiza que coincida con el event_id de la
-- ronda referenciada. Previene datos huérfanos silenciosos si el
-- código inserta mal.

CREATE OR REPLACE FUNCTION events.rn_meetings_check_event_consistency()
RETURNS TRIGGER AS $$
DECLARE
  round_event_id UUID;
BEGIN
  SELECT event_id INTO round_event_id
    FROM events.rn_rounds
    WHERE id = NEW.round_id;

  IF round_event_id IS NULL THEN
    RAISE EXCEPTION 'rn_meetings: round_id % no existe', NEW.round_id;
  END IF;

  IF round_event_id <> NEW.event_id THEN
    RAISE EXCEPTION 'rn_meetings: event_id % no coincide con event_id % de la ronda %',
      NEW.event_id, round_event_id, NEW.round_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rn_meetings_event_consistency ON events.rn_meetings;
CREATE TRIGGER trg_rn_meetings_event_consistency
  BEFORE INSERT OR UPDATE OF event_id, round_id
  ON events.rn_meetings
  FOR EACH ROW
  EXECUTE FUNCTION events.rn_meetings_check_event_consistency();
