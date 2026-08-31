-- Smart TV Browser Player — Fase 1 schema (framework v1.2, S186c-ext)
-- Aditivo puro: cero cambios a columnas/tablas existentes.
-- Ejecutar en cms_signage antes de desplegar endpoint PUT /api/admin/users/:id/smarttv-enabled.

BEGIN;

-- D1: flag add-on multi por usuario
ALTER TABLE users ADD COLUMN IF NOT EXISTS smarttv_enabled BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS smarttv_enabled_at TIMESTAMP;

-- Q13/Q17: token opaco + first-claim lock por device (device.model='smarttv' identifica tipo)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS browser_token VARCHAR(64) UNIQUE;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS browser_instance VARCHAR(36);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS browser_claimed_at TIMESTAMP;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS buffer_offline BOOLEAN DEFAULT false;

-- Q18: variantes H.264 1080p aspect-preserved para smart TV (espejo columnas hevc_*)
ALTER TABLE content ADD COLUMN IF NOT EXISTS smarttv_status VARCHAR(20);
ALTER TABLE content ADD COLUMN IF NOT EXISTS smarttv_file_path TEXT;
ALTER TABLE content ADD COLUMN IF NOT EXISTS smarttv_size_bytes BIGINT;
ALTER TABLE content ADD COLUMN IF NOT EXISTS smarttv_generated_at TIMESTAMP;

-- D2: códigos de pareo 6-8 chars, TTL corto, one-shot
CREATE TABLE IF NOT EXISTS smarttv_pair_codes (
  code VARCHAR(8) PRIMARY KEY,
  device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  redeemed_at TIMESTAMP,
  revoked_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pair_codes_device_active
  ON smarttv_pair_codes(device_id)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;

COMMIT;
