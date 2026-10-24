-- E-RN-9 — i18n emails Rueda de Negocios (ES/EN/PT)
-- Opción C: delegate.locale (preferencia individual) → event.default_locale → 'es' fallback
ALTER TABLE events.rn_delegates
  ADD COLUMN IF NOT EXISTS locale VARCHAR(2);
ALTER TABLE events.rn_delegates
  ADD CONSTRAINT rn_delegates_locale_chk CHECK (locale IS NULL OR locale IN ('es','en','pt'));

ALTER TABLE events.events
  ADD COLUMN IF NOT EXISTS default_locale VARCHAR(2) NOT NULL DEFAULT 'es';
ALTER TABLE events.events
  ADD CONSTRAINT events_default_locale_chk CHECK (default_locale IN ('es','en','pt'));
