-- Smart TV Browser Player — Fase 1 schema (framework v1.2, S186c-ext + S186d shipped names)
-- Aditivo puro: cero cambios a columnas/tablas existentes.
-- Nombres alineados con el runtime ya shipeado en el servicio smarttvsignage
-- (routes/pair.js + routes/player.js + scripts/smarttv-variant-worker.js).
-- Ejecutar en cms_signage antes de desplegar endpoint PUT /api/admin/users/:id/smarttv-enabled.

BEGIN;

-- D1: flag add-on multi por usuario
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS smarttv_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS smarttv_enabled_at TIMESTAMPTZ;

-- Q13/Q17: token opaco (hasheado en BD) + first-claim lock por device
-- browser_token_hash guarda SHA-256(token). El token en claro nunca se persiste.
-- devices.model='smarttv' identifica tipo (columna existente).
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS browser_instance     TEXT,
  ADD COLUMN IF NOT EXISTS browser_token_hash   TEXT,
  ADD COLUMN IF NOT EXISTS browser_paired_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS buffer_offline       BOOLEAN NOT NULL DEFAULT FALSE;

-- HB4 storage-level backstop: 1 device claim activo a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_browser_instance
  ON devices(browser_instance) WHERE browser_instance IS NOT NULL;

-- Q18: variantes H.264 1080p aspect-preserving para smart TV (espejo columnas hevc_*)
-- smarttv_url = path relativo dentro de UPLOADS_DIR (formato mismo que hevc_file_path)
-- smarttv_size_bytes = tamaño de la variante (para futura observabilidad de storage)
ALTER TABLE content
  ADD COLUMN IF NOT EXISTS smarttv_url         TEXT,
  ADD COLUMN IF NOT EXISTS smarttv_status      TEXT,
  ADD COLUMN IF NOT EXISTS smarttv_size_bytes  BIGINT,
  ADD COLUMN IF NOT EXISTS smarttv_variant_at  TIMESTAMPTZ;

-- D2: códigos de pareo 6-8 chars, TTL vía expires_at, revocables sin borrar la fila.
CREATE TABLE IF NOT EXISTS smarttv_pair_codes (
  id           BIGSERIAL PRIMARY KEY,
  code         VARCHAR(8)   NOT NULL UNIQUE,
  device_id    INTEGER      NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ  NOT NULL,
  redeemed_at  TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_smarttv_pair_codes_device
  ON smarttv_pair_codes(device_id);

-- Índice parcial: solo códigos "activos" (no redimidos ni revocados) para lookup rápido
-- de códigos vigentes por device (usado por /api/pair/generate para revocar previos).
CREATE INDEX IF NOT EXISTS idx_smarttv_pair_codes_active
  ON smarttv_pair_codes(device_id)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_smarttv_pair_codes_expires
  ON smarttv_pair_codes(expires_at)
  WHERE redeemed_at IS NULL;

COMMIT;
