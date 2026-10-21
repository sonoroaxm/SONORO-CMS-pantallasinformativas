-- =====================================================================
-- Rueda de Negocios v1 — DDL schema events.rn_*
-- Framework: docs/EVENTS-RUEDA-NEGOCIOS-FRAMEWORK.md v1.1 (17 decisiones)
-- Fase: E-RN-0
-- Rama: feature/events-rn-v1 (NO MERGE a main hasta G-RN-1 piloto)
-- Forward-only. Rollback via DROP SCHEMA en rama.
-- =====================================================================

SET search_path TO events, public;

-- ---------------------------------------------------------------------
-- 3.1 Zonas (opcional, solo modo Zonificado — D-RN-11/12)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.rn_zones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  slug            VARCHAR(60) NOT NULL,
  name            VARCHAR(100) NOT NULL,
  venue_label     VARCHAR(100),
  color_hex       VARCHAR(7) DEFAULT '#4F46E5',
  display_order   INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_rn_zones_event ON events.rn_zones (event_id, display_order);

-- ---------------------------------------------------------------------
-- 3.2 Mesas
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.rn_tables (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  zone_id         UUID REFERENCES events.rn_zones(id) ON DELETE SET NULL,
  label           VARCHAR(20) NOT NULL,
  display_order   INTEGER DEFAULT 0,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, label)
);
CREATE INDEX IF NOT EXISTS idx_rn_tables_event ON events.rn_tables (event_id, zone_id, display_order);

-- ---------------------------------------------------------------------
-- 3.3 Rondas (1 timer global — D-RN-2)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.rn_rounds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  round_number    INTEGER NOT NULL,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  kind            VARCHAR(20) NOT NULL DEFAULT 'meeting'
                  CHECK (kind IN ('meeting','break')),
  label           VARCHAR(60),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, round_number)
);
CREATE INDEX IF NOT EXISTS idx_rn_rounds_event_time ON events.rn_rounds (event_id, starts_at);

-- ---------------------------------------------------------------------
-- 3.4 Reuniones (D-RN-6 origin jerarquía · D-RN-15 EBV)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.rn_meetings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                  UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  round_id                  UUID NOT NULL REFERENCES events.rn_rounds(id) ON DELETE CASCADE,
  table_id                  UUID NOT NULL REFERENCES events.rn_tables(id),
  company_a_id              UUID NOT NULL REFERENCES events.registrations(id),
  company_b_id              UUID NOT NULL REFERENCES events.registrations(id),
  origin                    VARCHAR(20) NOT NULL
                            CHECK (origin IN ('requested','matched','manual')),
  locked                    BOOLEAN DEFAULT FALSE,
  status                    VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                            CHECK (status IN ('scheduled','active','completed','no_show','cancelled','deferred')),
  started_at                TIMESTAMPTZ,
  ended_at                  TIMESTAMPTZ,
  initiated_by              UUID REFERENCES events.registrations(id),
  tag_overlap_score         INTEGER DEFAULT 0,
  notes_a                   TEXT,
  notes_b                   TEXT,
  -- EBV D-RN-15 (opcional, privado por lado)
  expected_value_a_amount   NUMERIC(14,2),
  expected_value_a_currency VARCHAR(3) DEFAULT 'COP',
  expected_value_a_horizon  VARCHAR(20)
                            CHECK (expected_value_a_horizon IN ('short','long') OR expected_value_a_horizon IS NULL),
  expected_value_a_at       TIMESTAMPTZ,
  expected_value_b_amount   NUMERIC(14,2),
  expected_value_b_currency VARCHAR(3) DEFAULT 'COP',
  expected_value_b_horizon  VARCHAR(20)
                            CHECK (expected_value_b_horizon IN ('short','long') OR expected_value_b_horizon IS NULL),
  expected_value_b_at       TIMESTAMPTZ,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  CHECK (company_a_id <> company_b_id)
);
CREATE INDEX IF NOT EXISTS idx_rn_meetings_event_round ON events.rn_meetings (event_id, round_id);
CREATE INDEX IF NOT EXISTS idx_rn_meetings_company_a  ON events.rn_meetings (company_a_id);
CREATE INDEX IF NOT EXISTS idx_rn_meetings_company_b  ON events.rn_meetings (company_b_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rn_meetings_table_round ON events.rn_meetings (round_id, table_id);

-- ---------------------------------------------------------------------
-- 3.5 Tags (hashtags oferta/demanda, por tenant)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.rn_tags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  slug            VARCHAR(60) NOT NULL,
  label           VARCHAR(100) NOT NULL,
  category        VARCHAR(60),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, slug)
);

CREATE TABLE IF NOT EXISTS events.rn_registration_tags (
  registration_id UUID NOT NULL REFERENCES events.registrations(id) ON DELETE CASCADE,
  tag_id          UUID NOT NULL REFERENCES events.rn_tags(id) ON DELETE CASCADE,
  kind            VARCHAR(10) NOT NULL CHECK (kind IN ('offer','demand')),
  PRIMARY KEY (registration_id, tag_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_rn_reg_tags_tag ON events.rn_registration_tags (tag_id, kind);

-- ---------------------------------------------------------------------
-- 3.6 Anclas (solo modo Zonificado)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.rn_registration_anchors (
  registration_id UUID PRIMARY KEY REFERENCES events.registrations(id) ON DELETE CASCADE,
  table_id        UUID NOT NULL REFERENCES events.rn_tables(id),
  assigned_by     VARCHAR(20) NOT NULL CHECK (assigned_by IN ('auto','manual')),
  assigned_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rn_anchors_table ON events.rn_registration_anchors (table_id);

-- ---------------------------------------------------------------------
-- 3.7 Zonas de interés por empresa (solo modo Zonificado)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.rn_registration_zones (
  registration_id UUID NOT NULL REFERENCES events.registrations(id) ON DELETE CASCADE,
  zone_id         UUID NOT NULL REFERENCES events.rn_zones(id) ON DELETE CASCADE,
  is_primary      BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (registration_id, zone_id)
);
CREATE INDEX IF NOT EXISTS idx_rn_reg_zones_zone ON events.rn_registration_zones (zone_id, is_primary);

-- ---------------------------------------------------------------------
-- 3.8 Requests peer-to-peer
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.rn_meeting_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  from_registration_id    UUID NOT NULL REFERENCES events.registrations(id),
  to_registration_id      UUID NOT NULL REFERENCES events.registrations(id),
  status                  VARCHAR(20) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','accepted','rejected','expired')),
  message                 TEXT,
  responded_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  CHECK (from_registration_id <> to_registration_id),
  UNIQUE (event_id, from_registration_id, to_registration_id)
);
CREATE INDEX IF NOT EXISTS idx_rn_requests_to    ON events.rn_meeting_requests (to_registration_id, status);
CREATE INDEX IF NOT EXISTS idx_rn_requests_event ON events.rn_meeting_requests (event_id, status);

-- ---------------------------------------------------------------------
-- 3.9 Blocklist bidireccional
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.rn_blocklist (
  registration_id         UUID NOT NULL REFERENCES events.registrations(id) ON DELETE CASCADE,
  blocked_registration_id UUID NOT NULL REFERENCES events.registrations(id) ON DELETE CASCADE,
  reason                  VARCHAR(60),
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (registration_id, blocked_registration_id),
  CHECK (registration_id <> blocked_registration_id)
);

-- ---------------------------------------------------------------------
-- 3.10 Delegados (D-RN-10 doble delegado · D-RN-13 multi-delegado)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.rn_delegates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id   UUID NOT NULL REFERENCES events.registrations(id) ON DELETE CASCADE,
  full_name         VARCHAR(200) NOT NULL,
  email             VARCHAR(200) NOT NULL,
  phone             VARCHAR(40),
  role_title        VARCHAR(100),
  agenda_token      UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  is_primary        BOOLEAN DEFAULT FALSE,
  can_manage_team   BOOLEAN DEFAULT FALSE,
  invited_by        UUID REFERENCES events.rn_delegates(id),
  invited_at        TIMESTAMPTZ,
  accepted_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rn_delegates_reg   ON events.rn_delegates (registration_id);
CREATE INDEX IF NOT EXISTS idx_rn_delegates_token ON events.rn_delegates (agenda_token);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rn_delegates_primary
  ON events.rn_delegates (registration_id)
  WHERE is_primary = TRUE;

-- ---------------------------------------------------------------------
-- 3.11 parent_event_id en events.events (D-RN-14 vinculación congreso)
-- ---------------------------------------------------------------------
ALTER TABLE events.events
  ADD COLUMN IF NOT EXISTS parent_event_id UUID
  REFERENCES events.events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_events_parent ON events.events (parent_event_id);

-- Anti-circular: una rueda no puede ser padre de otra rueda. Se valida
-- en el endpoint de creación consultando events.event_type. No se enforcea
-- aquí con un trigger para mantener la migración forward-only y simple.
