-- S191c — Smart TV v1.2.1 pair TV-initiated + dual-confirm.
-- Aditivo puro. Crea tabla smarttv_pair_sessions. NO dropea smarttv_pair_codes
-- (v1.2 legacy sigue vivo hasta estabilizar v1.2.1 en prod; drop va en migración
-- posterior aparte).
--
-- Divergencia respecto a smarttvsignage/migrations/004:
--   El servicio smarttvsignage en prod conecta como `sonoro_db` (no `smarttv_svc`
--   como dice framework D4). Por eso omitimos GRANT a smarttv_svc — el owner
--   sonoro_db ya tiene privilegios plenos.
--
-- Ciclo de vida (para auditoría):
--   1. TV entra /pair → POST /api/pair/create-session inserta con device_id=NULL,
--      token_hash=NULL, bound_at=NULL, short_code random, expires_at=NOW()+10min.
--   2. TV abre SSE en GET /api/pair/wait/:uuid.
--   3. Cliente confirma (phone scan QR → /c/<uuid>, o laptop tipea short_code)
--      → POST /api/pair/bind autenticado. Handler valida owner+enabled+device
--      unclaimed, emite token opaco, SETS device_id + token_hash + bound_at +
--      bound_by_user_id en una transacción con el UPDATE devices (HB4).
--   4. SSE listener del TV recibe el token, lo guarda en localStorage, redirect
--      a /player. La fila queda bound_at NOT NULL — auditoría.

BEGIN;

CREATE TABLE IF NOT EXISTS smarttv_pair_sessions (
  uuid              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code        VARCHAR(6)    NOT NULL UNIQUE,
  device_id         INTEGER       REFERENCES devices(id) ON DELETE CASCADE,
  token_hash        TEXT,
  bound_by_user_id  INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ   NOT NULL,
  bound_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_smarttv_pair_sessions_short_code_active
  ON smarttv_pair_sessions(short_code)
  WHERE bound_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_smarttv_pair_sessions_expires_pending
  ON smarttv_pair_sessions(expires_at)
  WHERE bound_at IS NULL;

ALTER TABLE smarttv_pair_sessions OWNER TO sonoro_db;

COMMIT;
