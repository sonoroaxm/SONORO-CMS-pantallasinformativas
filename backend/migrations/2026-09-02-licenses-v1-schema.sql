-- LICENSES-V1 — Schema aditivo
-- Framework: docs/LICENSES-V1.md (KNOWLEDGE)
-- Fecha: 2026-09-02
-- Rama: feature/licenses-v1
--
-- Estrategia:
--   - Aditivo: no toca users.license_type / license_status / license_start / license_end.
--     Esos campos quedan como legacy hasta migración de datos (script separado).
--   - Idempotente: IF NOT EXISTS en todo.
--   - Sin FKs a licenses desde license_orders en este archivo (circular con order_id en licenses):
--     se resuelve con ALTER TABLE al final.

BEGIN;

-- =========================================================
-- 1.1  users — country_code + currency
-- =========================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS country_code CHAR(2) NOT NULL DEFAULT 'CO',
  ADD COLUMN IF NOT EXISTS currency     CHAR(3) NOT NULL DEFAULT 'COP';

-- =========================================================
-- 1.3  license_orders (se crea antes que licenses porque licenses.order_id la referencia)
-- =========================================================
CREATE TABLE IF NOT EXISTS license_orders (
  id                        SERIAL PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product                   TEXT NOT NULL CHECK (product IN ('smart_tv','windows','player')),
  months                    INTEGER NOT NULL CHECK (months BETWEEN 1 AND 36),
  country_code              CHAR(2) NOT NULL,
  currency                  CHAR(3) NOT NULL,
  amount                    NUMERIC(12,2) NOT NULL,
  unit_price                NUMERIC(12,2) NOT NULL,
  discount_pct              NUMERIC(5,2) DEFAULT 0,
  status                    TEXT NOT NULL DEFAULT 'pending_payment'
                              CHECK (status IN ('pending_payment','proof_uploaded','approved','rejected','cancelled')),
  payment_method            TEXT,
  payment_provider          TEXT DEFAULT 'manual',
  payment_ref               TEXT,
  payment_proof_url         TEXT,
  payment_proof_uploaded_at TIMESTAMPTZ,
  paid_at                   TIMESTAMPTZ,
  approval_token_jti        TEXT UNIQUE,
  approval_token_used_at    TIMESTAMPTZ,
  approved_by               INTEGER REFERENCES users(id),
  approved_at               TIMESTAMPTZ,
  rejected_reason           TEXT,
  license_id                INTEGER,  -- FK agregado al final (circular)
  admin_note                TEXT,
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON license_orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON license_orders(user_id);

-- =========================================================
-- 1.2  licenses  (+ 1.6 trial columns)
-- =========================================================
CREATE TABLE IF NOT EXISTS licenses (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id           TEXT REFERENCES devices(device_id) ON DELETE SET NULL,
  product             TEXT NOT NULL CHECK (product IN ('smart_tv','windows','player')),
  months              INTEGER NOT NULL CHECK (months BETWEEN 1 AND 36),
  start_date          TIMESTAMPTZ NOT NULL,
  end_date            TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','expired','suspended','cancelled','converted')),
  currency            CHAR(3) NOT NULL,
  amount              NUMERIC(12,2) NOT NULL,
  unit_price          NUMERIC(12,2) NOT NULL,
  discount_pct        NUMERIC(5,2) DEFAULT 0,
  is_free_grant       BOOLEAN DEFAULT FALSE,
  order_id            INTEGER REFERENCES license_orders(id),
  is_trial            BOOLEAN NOT NULL DEFAULT FALSE,
  trial_days          INTEGER NULL,
  trial_converted_at  TIMESTAMPTZ NULL,
  created_by          INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  note                TEXT
);

CREATE INDEX IF NOT EXISTS idx_licenses_user     ON licenses(user_id);
CREATE INDEX IF NOT EXISTS idx_licenses_device   ON licenses(device_id);
CREATE INDEX IF NOT EXISTS idx_licenses_end      ON licenses(end_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_licenses_product  ON licenses(product);

-- Anti-abuso trial: 1 trial por (user_id, product) de por vida
CREATE UNIQUE INDEX IF NOT EXISTS licenses_one_trial_per_product
  ON licenses(user_id, product) WHERE is_trial = TRUE;

-- Cerrar el ciclo: FK license_orders.license_id → licenses.id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'license_orders_license_id_fkey'
  ) THEN
    ALTER TABLE license_orders
      ADD CONSTRAINT license_orders_license_id_fkey
      FOREIGN KEY (license_id) REFERENCES licenses(id);
  END IF;
END$$;

-- =========================================================
-- 1.4  license_order_audit (append-only)
-- =========================================================
CREATE TABLE IF NOT EXISTS license_order_audit (
  id           BIGSERIAL PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES license_orders(id),
  action       TEXT NOT NULL,
  actor_email  TEXT,
  method       TEXT,
  ip           INET,
  user_agent   TEXT,
  jti          TEXT,
  metadata     JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_order ON license_order_audit(order_id);
CREATE INDEX IF NOT EXISTS idx_audit_date  ON license_order_audit(created_at DESC);

-- =========================================================
-- 1.5  pricing_catalog + seed
-- =========================================================
CREATE TABLE IF NOT EXISTS pricing_catalog (
  product      TEXT NOT NULL,
  currency     CHAR(3) NOT NULL,
  monthly      NUMERIC(12,2) NOT NULL,
  annual       NUMERIC(12,2) NOT NULL,
  second_plus  NUMERIC(12,2) NOT NULL,
  hw_upfront   NUMERIC(12,2) DEFAULT 0,
  free_months  INTEGER DEFAULT 0,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (product, currency)
);

INSERT INTO pricing_catalog (product, currency, monthly, annual, second_plus, hw_upfront, free_months) VALUES
  ('smart_tv','COP', 25000,  255000, 20000,      0, 0),
  ('windows', 'COP', 85000,  867000, 68000,      0, 0),
  ('player',  'COP', 55000,  561000, 44000, 800000, 12),
  ('smart_tv','USD',    15,     153,    12,      0, 0),
  ('windows', 'USD',    25,     255,    20,      0, 0),
  ('player',  'USD',    20,     204,    16,    350, 12)
ON CONFLICT (product, currency) DO NOTHING;

COMMIT;
