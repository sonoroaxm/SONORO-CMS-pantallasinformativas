-- VULN-003/006: HMAC device auth (log-only rollout, S185h)
-- Aditivo: columna NULL, cero impacto en devices existentes.
-- Devices con device_secret NULL quedan grandfathered (passthrough).
-- Devices con secret asignado firman requests con HMAC-SHA256.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_secret TEXT NULL;

COMMENT ON COLUMN devices.device_secret IS
  'HMAC-SHA256 shared secret per device (hex, 64 chars). NULL = grandfathered legacy device. Set via /api/admin/devices/:id/rotate-secret or installer v5.4+.';

-- Verificación:
--   \d devices
--   SELECT COUNT(*) FROM devices WHERE device_secret IS NOT NULL;  -- esperado: 0

-- Rollback:
--   ALTER TABLE devices DROP COLUMN device_secret;
