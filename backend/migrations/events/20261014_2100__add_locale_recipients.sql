-- ─────────────────────────────────────────────────────────────
-- Events v1 · i18n emails · columna locale por destinatario
-- Opción B: cada destinatario tiene su propio idioma.
-- Default 'es' (Colombia). Valores: es | en | pt-BR.
-- Aditivo. Forward-only. Rollback vía feature flag events_v1.
-- ─────────────────────────────────────────────────────────────

SET search_path TO events, public;

ALTER TABLE events.attendees
  ADD COLUMN IF NOT EXISTS locale VARCHAR(10) NOT NULL DEFAULT 'es';

ALTER TABLE events.attendees
  DROP CONSTRAINT IF EXISTS attendees_locale_check;
ALTER TABLE events.attendees
  ADD CONSTRAINT attendees_locale_check CHECK (locale IN ('es','en','pt-BR'));

ALTER TABLE events.event_staff
  ADD COLUMN IF NOT EXISTS locale VARCHAR(10) NOT NULL DEFAULT 'es';

ALTER TABLE events.event_staff
  DROP CONSTRAINT IF EXISTS event_staff_locale_check;
ALTER TABLE events.event_staff
  ADD CONSTRAINT event_staff_locale_check CHECK (locale IN ('es','en','pt-BR'));

ALTER TABLE events.suppliers
  ADD COLUMN IF NOT EXISTS locale VARCHAR(10) NOT NULL DEFAULT 'es';

ALTER TABLE events.suppliers
  DROP CONSTRAINT IF EXISTS suppliers_locale_check;
ALTER TABLE events.suppliers
  ADD CONSTRAINT suppliers_locale_check CHECK (locale IN ('es','en','pt-BR'));
