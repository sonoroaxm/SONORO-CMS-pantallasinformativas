-- LICENSES-V1 Fase 4 — trial gate stricter: 1 trial por USUARIO (no por producto)
-- Además el trial solo aplica a smart_tv (validado en route). Migración aditiva.

BEGIN;

-- Drop old index (1 trial por user+product)
DROP INDEX IF EXISTS licenses_one_trial_per_product;

-- New: 1 trial por user total
CREATE UNIQUE INDEX IF NOT EXISTS licenses_one_trial_per_user
  ON licenses(user_id) WHERE is_trial = TRUE;

COMMIT;
