-- LICENSES-V1 — Data migration desde legacy (users.license_*)
-- Framework: docs/LICENSES-V1.md (KNOWLEDGE)
-- Requiere: 2026-09-02-licenses-v1-schema.sql aplicado
-- Fecha: 2026-09-02
--
-- Estrategia CONSERVADORA:
--   - Migra solo usuarios con licencia legacy activa y no expirada.
--   - Mapeo legacy license_type → product nuevo:
--       'rpi'                        → 'player'
--       'windows'                    → 'windows'
--       'cms','cms_queue','queue'    → 'player'  (legacy CMS = usuario RPi por defecto)
--       otros                        → SKIP (revisión manual admin)
--   - Marca como is_free_grant=true, amount=0, note='migrated_from_legacy'.
--   - Preserva start/end originales. months = round(diff en meses).
--   - No borra ni modifica users.license_type/license_status/license_start/license_end.
--     Legacy queda como fallback de auditoría.
--   - Idempotente: usa NOT EXISTS para no duplicar filas si se reejecuta.
--   - Super admin (role='admin') NO se migra (tiene bypass total, no necesita licencia).

BEGIN;

-- Backfill defensivo: users sin country_code/currency (por si defaults del schema fallaron)
UPDATE users
   SET country_code = COALESCE(country_code, 'CO'),
       currency     = COALESCE(currency, 'COP');

-- Migrar licencias legacy → nueva tabla licenses
INSERT INTO licenses (
  user_id, device_id, product, months, start_date, end_date, status,
  currency, amount, unit_price, discount_pct, is_free_grant,
  is_trial, trial_days, created_by, note
)
SELECT
  u.id,
  NULL,  -- device_id: se asigna manualmente después (legacy no vincula user↔device 1:1)
  CASE u.license_type
    WHEN 'rpi'       THEN 'player'
    WHEN 'windows'   THEN 'windows'
    WHEN 'cms'       THEN 'player'
    WHEN 'cms_queue' THEN 'player'
    WHEN 'queue'     THEN 'player'
  END AS product,
  GREATEST(
    1,
    LEAST(
      36,
      CEIL(EXTRACT(EPOCH FROM (u.license_end - u.license_start)) / (30.0 * 86400))::INT
    )
  ) AS months,
  u.license_start,
  u.license_end,
  'active',
  COALESCE(u.currency, 'COP'),
  0,       -- amount: grandfathered, sin cobro
  0,       -- unit_price
  0,       -- discount_pct
  TRUE,    -- is_free_grant
  FALSE,   -- is_trial
  NULL,    -- trial_days
  NULL,    -- created_by (migración sistema)
  'migrated_from_legacy license_type=' || u.license_type
FROM users u
WHERE u.role = 'client'
  AND u.license_status = 'active'
  AND u.license_end IS NOT NULL
  AND u.license_end > NOW()
  AND u.license_type IN ('rpi','windows','cms','cms_queue','queue')
  AND NOT EXISTS (
    -- Idempotencia: no duplicar si ya se migró este user
    SELECT 1 FROM licenses l
    WHERE l.user_id = u.id
      AND l.note LIKE 'migrated_from_legacy%'
  );

-- Reporte inline (visible en psql / logs pm2 al correr)
DO $$
DECLARE
  migrated INT;
  skipped_admin INT;
  skipped_expired INT;
  skipped_unknown_type INT;
BEGIN
  SELECT COUNT(*) INTO migrated
    FROM licenses WHERE note LIKE 'migrated_from_legacy%';

  SELECT COUNT(*) INTO skipped_admin
    FROM users WHERE role = 'admin';

  SELECT COUNT(*) INTO skipped_expired
    FROM users
    WHERE role = 'client'
      AND (license_status != 'active' OR license_end <= NOW() OR license_end IS NULL);

  SELECT COUNT(*) INTO skipped_unknown_type
    FROM users
    WHERE role = 'client'
      AND license_status = 'active'
      AND license_end > NOW()
      AND license_type NOT IN ('rpi','windows','cms','cms_queue','queue');

  RAISE NOTICE '─────────────────────────────────────────';
  RAISE NOTICE 'LICENSES-V1 data migration report:';
  RAISE NOTICE '  Migrated (grandfathered):     %', migrated;
  RAISE NOTICE '  Skipped admin (bypass):       %', skipped_admin;
  RAISE NOTICE '  Skipped expired/inactive:     %', skipped_expired;
  RAISE NOTICE '  Skipped unknown license_type: % (revisar manual)', skipped_unknown_type;
  RAISE NOTICE '─────────────────────────────────────────';
END$$;

COMMIT;
