-- Events v1 — Batch de invitaciones para talento (E1.5)
-- Sesión S150 — 22/06/2026
-- Aditivo. Reutiliza events.registrations + extiende origin con 'invitation'.

SET search_path TO events, public;

-- ── BATCHES DE INVITACIONES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events.registration_invitation_batches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES public.users(id),
  label             VARCHAR(120) NOT NULL,
  ticket_type       VARCHAR(50) NOT NULL DEFAULT 'talent',
  quota             INTEGER NOT NULL CHECK (quota > 0),
  claimed_count     INTEGER NOT NULL DEFAULT 0,
  claim_code        UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  assigned_to_name  VARCHAR(120),
  assigned_to_email VARCHAR(120),
  assigned_to_phone VARCHAR(30),
  auto_approve      BOOLEAN NOT NULL DEFAULT FALSE,
  notes             TEXT,
  expires_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_claimed_le_quota CHECK (claimed_count <= quota)
);

CREATE INDEX IF NOT EXISTS idx_inv_batches_event
  ON events.registration_invitation_batches (event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_batches_claim_active
  ON events.registration_invitation_batches (claim_code)
  WHERE revoked_at IS NULL;

-- ── TRAZABILIDAD EN REGISTRATIONS ───────────────────────────────────────────
ALTER TABLE events.registrations
  ADD COLUMN IF NOT EXISTS invitation_batch_id UUID
    REFERENCES events.registration_invitation_batches(id);

CREATE INDEX IF NOT EXISTS idx_registrations_batch
  ON events.registrations (invitation_batch_id);

-- ── EXTENDER origin CON 'invitation' ────────────────────────────────────────
ALTER TABLE events.registrations
  DROP CONSTRAINT IF EXISTS registrations_origin_check;

ALTER TABLE events.registrations
  ADD CONSTRAINT registrations_origin_check
    CHECK (origin IN ('web_form','kiosk','staff','import','api','invitation'));

-- ── EXTENSIÓN: modo de captura + alcance de sesiones ────────────────────────
ALTER TABLE events.registration_invitation_batches
  ADD COLUMN IF NOT EXISTS mode VARCHAR(20) NOT NULL DEFAULT 'claim'
    CHECK (mode IN ('claim','roster'));

ALTER TABLE events.registration_invitation_batches
  ADD COLUMN IF NOT EXISTS session_scope VARCHAR(20) NOT NULL DEFAULT 'event_wide'
    CHECK (session_scope IN ('event_wide','specific_sessions'));

ALTER TABLE events.registration_invitation_batches
  ADD COLUMN IF NOT EXISTS session_ids UUID[] DEFAULT '{}';
