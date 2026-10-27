-- S211w — Visibility toggle en directorio público RN
-- Semántica: visible_in_directory=FALSE oculta al delegado del listado /directory/:slug
-- pero NO afecta citas existentes ni es equivalente a opt_out (ARCO).

ALTER TABLE events.rn_delegates
  ADD COLUMN IF NOT EXISTS visible_in_directory BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_rn_delegates_visible
  ON events.rn_delegates(registration_id)
  WHERE visible_in_directory = TRUE;
