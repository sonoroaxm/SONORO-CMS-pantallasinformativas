-- Events v1 — Invitaciones v2 (individual / grupo, prefill, sin email inicial)
-- Sesión S151 — 23/06/2026
-- BREAKING: borra batches existentes (modelo viejo claim/roster, sin uso productivo).
-- Aditivo: agrega columnas kind + prefill.

SET search_path TO events, public;

-- ── 1. CLEANUP — los batches existentes son del modelo viejo. Sin migración. ──
-- (Borra también registrations 'invitation' asociadas — son pruebas previas).
DELETE FROM events.registrations WHERE invitation_batch_id IS NOT NULL;
DELETE FROM events.registration_invitation_batches;

-- ── 2. NUEVAS COLUMNAS ──
-- kind: 'individual' (1 cupo, link al talento) | 'group' (N cupos, link al responsable)
ALTER TABLE events.registration_invitation_batches
  ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'individual'
    CHECK (kind IN ('individual','group'));

-- prefill: { name, email, phone? } del talento (individual) o del responsable (group)
ALTER TABLE events.registration_invitation_batches
  ADD COLUMN IF NOT EXISTS prefill JSONB DEFAULT '{}'::jsonb;

-- ── 3. SIMPLIFICACIONES IMPLÍCITAS ──
-- auto_approve ahora siempre TRUE por convención (el organizador conoce a quién invita).
-- Cambiar el default por claridad; no rompemos columna por compat hacia adelante.
ALTER TABLE events.registration_invitation_batches
  ALTER COLUMN auto_approve SET DEFAULT TRUE;

-- mode ya no se usa en la UI v2 (siempre es link), pero la columna queda.
-- Aceptamos 'claim' como único valor implícito en v2.
