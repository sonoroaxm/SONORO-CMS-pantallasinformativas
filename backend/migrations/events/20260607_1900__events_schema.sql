-- ============================================================
-- Events v1 — Schema inicial
-- Migración: 20260607_1900__events_schema.sql
-- Fecha: 2026-06-07
-- ============================================================

CREATE SCHEMA IF NOT EXISTS events;

-- ── EVENTOS ───────────────────────────────────────────────────────────────────
CREATE TABLE events.events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name          VARCHAR(200) NOT NULL,
  slug          VARCHAR(80) UNIQUE NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','published','live','closed','archived')),
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  timezone      VARCHAR(60) NOT NULL DEFAULT 'America/Bogota',
  venue_name    VARCHAR(200),
  venue_address VARCHAR(300),
  cover_image_url VARCHAR(500),
  config        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_events_user_status ON events.events (user_id, status);
CREATE INDEX idx_events_slug ON events.events (slug);

-- ── SESIONES ──────────────────────────────────────────────────────────────────
CREATE TABLE events.event_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES public.users(id),
  name         VARCHAR(200) NOT NULL,
  description  TEXT,
  session_type VARCHAR(30) NOT NULL DEFAULT 'plenary'
               CHECK (session_type IN ('plenary','breakout','workshop','meal','social','other')),
  venue_zone   VARCHAR(100),
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  capacity     INTEGER,
  requires_registration BOOLEAN DEFAULT FALSE,
  status       VARCHAR(20) DEFAULT 'scheduled'
               CHECK (status IN ('scheduled','in_progress','done','cancelled')),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_sessions_event ON events.event_sessions (event_id, starts_at);

-- ── ASISTENTES — CRM persistente por tenant ───────────────────────────────────
CREATE TABLE events.attendees (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       INTEGER NOT NULL REFERENCES public.users(id),
  email         VARCHAR(120) NOT NULL,
  name          VARCHAR(120) NOT NULL,
  phone         VARCHAR(30),
  id_number     VARCHAR(40),
  id_type       VARCHAR(10) DEFAULT 'CC'
                CHECK (id_type IN ('CC','CE','PA','NIT','OTHER')),
  organization  VARCHAR(120),
  job_title     VARCHAR(80),
  dietary_restrictions VARCHAR(200),
  vip           BOOLEAN DEFAULT FALSE,
  blacklisted   BOOLEAN DEFAULT FALSE,
  custom_fields JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, email)
);
CREATE INDEX idx_attendees_user_email    ON events.attendees (user_id, email);
CREATE INDEX idx_attendees_user_idnumber ON events.attendees (user_id, id_number);

-- ── EQUIPO DE PRODUCCIÓN ──────────────────────────────────────────────────────
-- Creado antes de registrations porque registration_checkins y service_redemptions
-- lo referencian via checked_in_by / redeemed_by
CREATE TABLE events.event_staff (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  user_id          INTEGER REFERENCES public.users(id),
  name             VARCHAR(120) NOT NULL,
  email            VARCHAR(120),
  phone            VARCHAR(30),
  role             VARCHAR(30) NOT NULL
                   CHECK (role IN ('producer_general','producer_assistant','coordinator',
                                   'registration_staff','tech','host','security','other')),
  areas            TEXT[],
  pin              CHAR(6),
  pin_attempts     INTEGER DEFAULT 0,
  pin_locked_until TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_staff_event ON events.event_staff (event_id, role);

-- ── REGISTROS ─────────────────────────────────────────────────────────────────
CREATE TABLE events.registrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  attendee_id   UUID NOT NULL REFERENCES events.attendees(id),
  user_id       INTEGER NOT NULL REFERENCES public.users(id),
  ticket_type   VARCHAR(50) DEFAULT 'general',
  status        VARCHAR(20) NOT NULL DEFAULT 'confirmed'
                CHECK (status IN ('pending','confirmed','cancelled','no_show')),
  qr_token      UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  origin        VARCHAR(20) NOT NULL DEFAULT 'web_form'
                CHECK (origin IN ('web_form','kiosk','staff','import','api')),
  custom_fields JSONB DEFAULT '{}',
  registered_by INTEGER REFERENCES public.users(id),
  accepted_terms BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, attendee_id)
);
CREATE INDEX idx_registrations_event    ON events.registrations (event_id, status);
CREATE INDEX idx_registrations_qr       ON events.registrations (qr_token);
CREATE INDEX idx_registrations_attendee ON events.registrations (attendee_id);

-- ── REGISTRO ↔ SESIONES ───────────────────────────────────────────────────────
CREATE TABLE events.registration_sessions (
  registration_id UUID NOT NULL REFERENCES events.registrations(id) ON DELETE CASCADE,
  session_id      UUID NOT NULL REFERENCES events.event_sessions(id) ON DELETE CASCADE,
  status          VARCHAR(20) DEFAULT 'registered'
                  CHECK (status IN ('registered','attended','no_show')),
  checked_in_at   TIMESTAMPTZ,
  PRIMARY KEY (registration_id, session_id)
);

-- ── CHECK-IN MULTI-DÍA (P-1: nunca checked_in_at en registrations) ────────────
CREATE TABLE events.registration_checkins (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID NOT NULL REFERENCES events.registrations(id) ON DELETE CASCADE,
  event_id        UUID NOT NULL REFERENCES events.events(id),
  event_day       DATE NOT NULL,
  checked_in_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_out_at  TIMESTAMPTZ,
  checked_in_by   UUID REFERENCES events.event_staff(id),
  UNIQUE (registration_id, event_day)
);
CREATE INDEX idx_checkins_event_day ON events.registration_checkins (event_id, event_day);

-- ── REDEMPTION DE SERVICIOS ───────────────────────────────────────────────────
CREATE TABLE events.service_redemptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events.events(id),
  registration_id UUID NOT NULL REFERENCES events.registrations(id),
  user_id         INTEGER NOT NULL REFERENCES public.users(id),
  service_type    VARCHAR(60) NOT NULL,
  redeemed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redeemed_by     UUID REFERENCES events.event_staff(id),
  notes           VARCHAR(200)
);
CREATE INDEX idx_redemptions_registration ON events.service_redemptions (registration_id, service_type);
CREATE INDEX idx_redemptions_event_day    ON events.service_redemptions (event_id, redeemed_at);

-- ── LIBRETO / RUNDOWN ─────────────────────────────────────────────────────────
CREATE TABLE events.rundown_cues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES public.users(id),
  cue_number      VARCHAR(20) NOT NULL,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  duration_min    INTEGER,
  title           VARCHAR(200) NOT NULL,
  description     TEXT,
  location        VARCHAR(100),
  responsible_id  UUID REFERENCES events.event_staff(id),
  technical_notes TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_progress','done','skipped','delayed')),
  delay_minutes   INTEGER DEFAULT 0,
  session_id      UUID REFERENCES events.event_sessions(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_cues_event_time ON events.rundown_cues (event_id, scheduled_at);

-- ── PROVEEDORES ───────────────────────────────────────────────────────────────
CREATE TABLE events.suppliers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       INTEGER NOT NULL REFERENCES public.users(id),
  name          VARCHAR(120) NOT NULL,
  category      VARCHAR(60),
  contact_name  VARCHAR(120),
  contact_phone VARCHAR(30),
  contact_email VARCHAR(120),
  notes         TEXT,
  rating        SMALLINT CHECK (rating BETWEEN 1 AND 5),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_suppliers_user ON events.suppliers (user_id);

CREATE TABLE events.event_suppliers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  supplier_id         UUID NOT NULL REFERENCES events.suppliers(id),
  user_id             INTEGER NOT NULL REFERENCES public.users(id),
  service_description TEXT,
  contracted_amount   NUMERIC(12,2),
  currency            CHAR(3) DEFAULT 'COP',
  arrival_at          TIMESTAMPTZ,
  departure_at        TIMESTAMPTZ,
  payment_status      VARCHAR(20) DEFAULT 'pending'
                      CHECK (payment_status IN ('pending','partial','paid','cancelled')),
  notes               TEXT
);

-- ── TOKENS DE ACCIÓN PÚBLICA ─────────────────────────────────────────────────
CREATE TABLE events.registration_action_tokens (
  token           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID NOT NULL REFERENCES events.registrations(id) ON DELETE CASCADE,
  action_allowed  VARCHAR(20) NOT NULL
                  CHECK (action_allowed IN ('modify','cancel','both')),
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_action_tokens_reg ON events.registration_action_tokens (registration_id);
