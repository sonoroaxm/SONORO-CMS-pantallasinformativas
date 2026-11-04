-- E-EMP-1 · Expandir next_step_check con 6 valores RE
-- Unión RN (8) + RE (6, 'none' deduplicado) = 13 valores
-- Aditivo: todos los next_step RN existentes siguen válidos.

ALTER TABLE events.rn_meeting_outcomes
  DROP CONSTRAINT IF EXISTS rn_meeting_outcomes_next_step_check;

ALTER TABLE events.rn_meeting_outcomes
  ADD CONSTRAINT rn_meeting_outcomes_next_step_check
  CHECK (next_step IN (
    -- RN originales
    'quote','sample','catalog','tech_spec','intro','second_meeting','pilot','none',
    -- RE nuevos
    'continuar_negocio','entrevista_siguiente_fase','contratacion_directa',
    'info_adicional','banco_talento'
  ));

DO $$
DECLARE
  n_values INT;
BEGIN
  SELECT COUNT(*) INTO n_values
    FROM pg_constraint
   WHERE conname = 'rn_meeting_outcomes_next_step_check';
  IF n_values = 0 THEN
    RAISE EXCEPTION 'CHECK next_step no se recreó';
  END IF;
  RAISE NOTICE 'E-EMP-1 next_step_check expandido · 13 valores (8 RN + 5 RE nuevos, "none" compartido)';
END $$;
