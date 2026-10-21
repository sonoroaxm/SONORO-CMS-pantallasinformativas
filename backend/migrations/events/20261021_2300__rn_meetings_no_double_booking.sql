-- =====================================================================
-- Rueda de Negocios — Anti double-booking de empresa en misma ronda
-- Framework: docs/EVENTS-RUEDA-NEGOCIOS-FRAMEWORK.md v1.1
-- Gap 1 identificado en validación E-RN-0.
-- Forward-only.
-- =====================================================================

-- Garantiza que una misma registration no pueda estar en dos mesas
-- de la misma ronda, sea como company_a o como company_b.
-- UNIQUE no cubre el caso porque la empresa puede aparecer en cualquiera
-- de las dos columnas → se implementa via trigger con EXISTS check.

CREATE OR REPLACE FUNCTION events.rn_meetings_prevent_double_booking()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM events.rn_meetings m
    WHERE m.round_id = NEW.round_id
      AND m.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND (
        m.company_a_id = NEW.company_a_id OR
        m.company_b_id = NEW.company_a_id OR
        m.company_a_id = NEW.company_b_id OR
        m.company_b_id = NEW.company_b_id
      )
  ) THEN
    RAISE EXCEPTION 'rn_meetings double-booking: empresa ya tiene reunión en ronda %', NEW.round_id
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rn_meetings_no_double_booking ON events.rn_meetings;
CREATE TRIGGER trg_rn_meetings_no_double_booking
  BEFORE INSERT OR UPDATE OF round_id, company_a_id, company_b_id
  ON events.rn_meetings
  FOR EACH ROW
  EXECUTE FUNCTION events.rn_meetings_prevent_double_booking();
