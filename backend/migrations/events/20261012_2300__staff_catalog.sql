-- S208n — Catálogo tenant de staff (reciclable entre eventos)
-- Patrón: espejo de events.suppliers vs events.event_suppliers.
-- Forward-only. Aditivo. Reversible por feature flag users.features.events_v1.

-- Tabla catálogo tenant
CREATE TABLE IF NOT EXISTS events.staff_catalog (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(120),
  phone         VARCHAR(30),
  default_role  VARCHAR(30)
                CHECK (default_role IN (
                  'coordinator','registration','tech','host',
                  'security','catering','artistic_entertainment','other'
                )),
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Email único por tenant (opcional pero útil para evitar duplicados)
CREATE UNIQUE INDEX IF NOT EXISTS staff_catalog_user_email_uniq
  ON events.staff_catalog (user_id, LOWER(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_catalog_user
  ON events.staff_catalog (user_id);

-- Vínculo opcional: staff asignado a un evento puede referenciar al catálogo
ALTER TABLE events.event_staff
  ADD COLUMN IF NOT EXISTS catalog_id INTEGER REFERENCES events.staff_catalog(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_event_staff_catalog
  ON events.event_staff (catalog_id)
  WHERE catalog_id IS NOT NULL;
