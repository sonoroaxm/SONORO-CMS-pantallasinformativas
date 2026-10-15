-- E4 Certificados v1 — schema aditivo
-- Fecha: 2026-10-15
-- Rollback: feature flag users.features.events_v1

SET search_path TO events, public;

-- ─────────────────────────────────────────────────────────────
-- certificate_templates: plantillas de certificado por evento
-- Scope: event (certifica evento global) | session (certifica sesión específica)
-- Canvas: imagen de fondo subida por productor; overlays del sistema fijos.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events.certificate_templates (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                UUID        NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  user_id                 INTEGER     NOT NULL REFERENCES public.users(id),
  name                    VARCHAR(200) NOT NULL,
  scope                   VARCHAR(16) NOT NULL DEFAULT 'event',
  session_id              UUID        REFERENCES events.event_sessions(id) ON DELETE SET NULL,
  page_size               VARCHAR(16) NOT NULL DEFAULT 'letter',
  canvas_path             TEXT,
  body_text               TEXT        NOT NULL DEFAULT 'Certificamos que {{nombre}} asistió al evento {{evento}}, con una duración total de {{horas}} horas, los días {{fechas}}.',
  requires_checkin        BOOLEAN     NOT NULL DEFAULT TRUE,
  min_sessions_attended   INTEGER,
  active                  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT certificate_templates_scope_chk
    CHECK (scope IN ('event','session')),
  CONSTRAINT certificate_templates_page_size_chk
    CHECK (page_size IN ('letter','half_letter')),
  CONSTRAINT certificate_templates_session_scope_chk
    CHECK ((scope = 'session' AND session_id IS NOT NULL) OR (scope = 'event'))
);

CREATE INDEX IF NOT EXISTS idx_certificate_templates_event
  ON events.certificate_templates(event_id);
CREATE INDEX IF NOT EXISTS idx_certificate_templates_user
  ON events.certificate_templates(user_id);

-- ─────────────────────────────────────────────────────────────
-- certificates: certificados emitidos
-- Token UUID permanente para URL pública /cert/:token y /verify/:token
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events.certificates (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     UUID        NOT NULL REFERENCES events.certificate_templates(id) ON DELETE RESTRICT,
  registration_id UUID        NOT NULL REFERENCES events.registrations(id) ON DELETE CASCADE,
  event_id        UUID        NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  session_id      UUID        REFERENCES events.event_sessions(id) ON DELETE SET NULL,
  user_id         INTEGER     NOT NULL REFERENCES public.users(id),
  token           UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  pdf_path        TEXT,
  hours_total     NUMERIC(6,2),
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_by       INTEGER     REFERENCES public.users(id),
  revoked_at      TIMESTAMPTZ,
  revoke_reason   TEXT,
  manual_override BOOLEAN     NOT NULL DEFAULT FALSE,
  email_sent_at   TIMESTAMPTZ,
  verified_count  INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_certificates_event        ON events.certificates(event_id);
CREATE INDEX IF NOT EXISTS idx_certificates_registration ON events.certificates(registration_id);
CREATE INDEX IF NOT EXISTS idx_certificates_template     ON events.certificates(template_id);
CREATE INDEX IF NOT EXISTS idx_certificates_user         ON events.certificates(user_id);
CREATE INDEX IF NOT EXISTS idx_certificates_token        ON events.certificates(token);

-- Único por (plantilla, registro, sesión-nullable): no re-emitir el mismo cert
-- Si se quiere re-emitir, primero revocar.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_certificates_tpl_reg_sess
  ON events.certificates(template_id, registration_id, COALESCE(session_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
