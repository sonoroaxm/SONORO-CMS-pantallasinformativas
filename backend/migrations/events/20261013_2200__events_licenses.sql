-- S210-exec #2 — Events v1 licensing table (aislada de public.licenses)
--
-- CONTEXTO DE AISLAMIENTO (lectura obligatoria antes de tocar esto):
--   SONORO Signage (smart_tv, player, windows) vive en public.licenses con
--   tiers basic/pro y status flow comprar/renovar/cancelar.
--   SONORO Events vive aquí (events.licenses) con tiers trial/lite/pro/masivo
--   y status flow suscripción SaaS (grace/readonly/archive).
--   Los dos productos NO comparten tabla, columna, ni enum. Un cliente que
--   compra uno NO toca la tabla del otro. El combo Signage+Events se calcula
--   en código al cobrar, no en schema.
--   Doc canónico: docs/EVENTS-FRAMEWORK.md §Aislamiento + docs/CLAUDE.md
--   §Impact Matrix. Decisión Daniel 13-oct-2026.
--
-- Alineación: Framework Events §4.5 (migraciones forward-only bajo schema events.*).
-- Rollback: feature flag users.features.events_v1.

BEGIN;

CREATE TABLE IF NOT EXISTS events.licenses (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- Tier Pricing-v1 locked (§3 PRICING-EVENTS-v1.md)
  tier            VARCHAR(16) NOT NULL
    CHECK (tier IN ('trial','lite','pro','masivo')),

  -- Status flow SaaS (§6 PRICING-EVENTS-v1.md)
  --   active   = pago al día o trial vigente
  --   grace    = 1-15 días post-vencimiento, acceso completo (D-A 13-oct)
  --   readonly = 16-30 días, solo GET, mutaciones → 423 Locked (D-B)
  --   archive  = 31-60 días, data cold-storage, UI block
  --   cancelled= baja voluntaria
  --   converted= trial → tier pago
  status          VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','grace','readonly','archive','cancelled','converted')),

  -- Country-lock al signup (§7 PRICING-EVENTS-v1.md). CHECK duro: no se cambia.
  currency        CHAR(3) NOT NULL CHECK (currency IN ('COP','USD')),

  -- Periodicidad facturación
  billing_period  VARCHAR(16) NOT NULL
    CHECK (billing_period IN ('trial','monthly','annual')),

  -- Fechas de vigencia
  start_date      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_date        TIMESTAMPTZ NOT NULL,
  trial_days      INTEGER,                 -- NULL si no es trial
  converted_at    TIMESTAMPTZ,             -- trial → pago
  cancelled_at    TIMESTAMPTZ,

  -- Metadata extensible: overage counters, custom caps, promo codes,
  -- processor refs (PayPal subscription id, PayU reference), etc.
  -- Nunca schemas que deban ser columnas de primera clase (status, tier).
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_by      INTEGER REFERENCES public.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: middleware requireEventsAccess (S210-exec #3)
CREATE INDEX IF NOT EXISTS idx_events_licenses_user_status
  ON events.licenses (user_id, status);

-- Cron grace/readonly/archive (§6 flow, tarea S210-exec #7)
CREATE INDEX IF NOT EXISTS idx_events_licenses_end_active
  ON events.licenses (end_date)
  WHERE status IN ('active','grace','readonly');

-- Queries sobre metadata (overage, usage, promo codes)
CREATE INDEX IF NOT EXISTS idx_events_licenses_metadata_gin
  ON events.licenses USING GIN (metadata);

-- Un solo trial por usuario (consistente con public.licenses pattern)
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_licenses_one_trial_per_user
  ON events.licenses (user_id) WHERE tier = 'trial';

-- Trigger updated_at
CREATE OR REPLACE FUNCTION events._touch_licenses_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_licenses_touch ON events.licenses;
CREATE TRIGGER trg_events_licenses_touch
  BEFORE UPDATE ON events.licenses
  FOR EACH ROW EXECUTE FUNCTION events._touch_licenses_updated_at();

COMMIT;
