-- S209 — Integración Calendario Google/Outlook (nivel staff_catalog)
-- Patrón: cada staff del catálogo tenant tiene su propia agenda personal.
-- El productor del evento es un staff_catalog row con default_role='coordinator'
-- y is_owner=TRUE (autoprovisionado en el primer evento).
--
-- Decisión D1=A (1 bloque por evento).
-- Decisión D2=1 (tabla paralela bajo events.*, aislamiento del Queue).
-- Decisión D3=solo productor en S209 — staff/proveedores (attendees) van en S210,
--   pero el schema ya es N:M (event × staff) para evitar migración posterior.
--
-- Forward-only. Aditivo. Reversible por feature flag users.features.events_v1.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 0) Marcar al productor dentro de staff_catalog
ALTER TABLE events.staff_catalog
  ADD COLUMN IF NOT EXISTS is_owner BOOLEAN DEFAULT FALSE;

-- Un solo "owner" por tenant (el productor principal). Autoprovisionado al crear
-- primer evento. Partial unique index: solo exige unicidad donde is_owner=TRUE.
CREATE UNIQUE INDEX IF NOT EXISTS staff_catalog_owner_uniq
  ON events.staff_catalog (user_id)
  WHERE is_owner = TRUE;

-- 1) Integración por staff_catalog + provider (tokens cifrados pgcrypto)
--    user_id denormalizado para multi-tenancy strict (regla framework §3.2)
CREATE TABLE IF NOT EXISTS events.calendar_integrations (
  id                SERIAL PRIMARY KEY,
  staff_catalog_id  INTEGER NOT NULL REFERENCES events.staff_catalog(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider          VARCHAR(20) NOT NULL CHECK (provider IN ('google','outlook')),
  calendar_id       VARCHAR(255),
  connected_email   VARCHAR(255),
  access_token      BYTEA NOT NULL,
  refresh_token     BYTEA,
  token_expiry      TIMESTAMPTZ,
  scope             TEXT,
  connected_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (staff_catalog_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_ev_cal_integrations_user
  ON events.calendar_integrations (user_id);
CREATE INDEX IF NOT EXISTS idx_ev_cal_integrations_staff
  ON events.calendar_integrations (staff_catalog_id);

-- 2) Magic-link tokens (TTL 24h, one-shot)
--    Enviado por email al staff del catálogo. No requiere cuenta CMS.
CREATE TABLE IF NOT EXISTS events.calendar_connect_tokens (
  token             VARCHAR(100) PRIMARY KEY,
  staff_catalog_id  INTEGER NOT NULL REFERENCES events.staff_catalog(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider          VARCHAR(20) NOT NULL CHECK (provider IN ('google','outlook')),
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ev_cal_connect_expires
  ON events.calendar_connect_tokens (expires_at)
  WHERE used_at IS NULL;

-- 3) Webhooks: push notifications (Google) / change notifications (Outlook)
CREATE TABLE IF NOT EXISTS events.calendar_watch_channels (
  id                SERIAL PRIMARY KEY,
  staff_catalog_id  INTEGER NOT NULL REFERENCES events.staff_catalog(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider          VARCHAR(20) NOT NULL CHECK (provider IN ('google','outlook')),
  channel_id        VARCHAR(255) NOT NULL,
  resource_id       VARCHAR(255),
  channel_token     VARCHAR(100) NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  calendar_id       VARCHAR(255),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (staff_catalog_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_ev_cal_watch_user
  ON events.calendar_watch_channels (user_id);
CREATE INDEX IF NOT EXISTS idx_ev_cal_watch_expires
  ON events.calendar_watch_channels (expires_at);

-- 4) Sync N:M — 1 evento puede publicarse en N calendarios (productor + staff + proveedores)
--    En S209 solo escribimos filas para el staff is_owner=TRUE del tenant.
--    En S210 se agregan filas por cada staff asignado con publish=TRUE.
CREATE TABLE IF NOT EXISTS events.event_calendar_sync (
  id                 SERIAL PRIMARY KEY,
  event_id           UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  staff_catalog_id   INTEGER NOT NULL REFERENCES events.staff_catalog(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider           VARCHAR(20) NOT NULL CHECK (provider IN ('google','outlook')),
  external_event_id  VARCHAR(255) NOT NULL,
  last_synced_at     TIMESTAMPTZ DEFAULT NOW(),
  sync_error         TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, staff_catalog_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_ev_cal_sync_event
  ON events.event_calendar_sync (event_id);
CREATE INDEX IF NOT EXISTS idx_ev_cal_sync_staff
  ON events.event_calendar_sync (staff_catalog_id);
CREATE INDEX IF NOT EXISTS idx_ev_cal_sync_user
  ON events.event_calendar_sync (user_id);

-- 5) Toggle opt-in a nivel evento (default FALSE)
--    En S209 publica solo al owner. En S210, se amplía con tabla separada
--    events.event_staff_publish (event_id, staff_catalog_id, enabled).
ALTER TABLE events.events
  ADD COLUMN IF NOT EXISTS publish_to_external_calendar BOOLEAN DEFAULT FALSE;
