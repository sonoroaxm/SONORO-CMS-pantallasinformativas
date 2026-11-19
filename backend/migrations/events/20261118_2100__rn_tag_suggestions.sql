-- Migration: rn_tag_suggestions (Deuda S217j #5a)
-- Fecha: 2026-11-18
-- Scope: tabla aditiva para que delegados sugieran tags faltantes al catálogo.
-- Decisión: delegados reportan desde el picker; admin revisa y promueve a rn_tags.
-- Forward-only. Rollback: DROP TABLE events.rn_tag_suggestions;

SET search_path TO events, public;

CREATE TABLE IF NOT EXISTS events.rn_tag_suggestions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID REFERENCES events.events(id) ON DELETE SET NULL,
  user_id         INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  delegate_id     UUID REFERENCES events.rn_delegates(id) ON DELETE SET NULL,
  suggested_label VARCHAR(140) NOT NULL,
  suggested_category VARCHAR(60),
  suggested_dimension VARCHAR(10) CHECK (suggested_dimension IN ('hard','soft')),
  rueda_type      VARCHAR(20) CHECK (rueda_type IN ('negocios','empleo')),
  lang            VARCHAR(5) DEFAULT 'es',
  note            TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','duplicate')),
  reviewed_by     INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  promoted_tag_id UUID REFERENCES events.rn_tags(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rn_tag_suggestions_user_status
  ON events.rn_tag_suggestions (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rn_tag_suggestions_event
  ON events.rn_tag_suggestions (event_id);
CREATE INDEX IF NOT EXISTS idx_rn_tag_suggestions_pending_dup
  ON events.rn_tag_suggestions (user_id, lower(suggested_label))
  WHERE status = 'pending';

COMMENT ON TABLE events.rn_tag_suggestions IS
  'Deuda S217j #5a — sugerencias de tags enviadas por delegados desde picker. Admin revisa y promueve a rn_tags.';
