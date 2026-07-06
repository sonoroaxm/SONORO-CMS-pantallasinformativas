-- Suppliers & Budget — E4 partial (pre-pilot planning)
-- P-2: user_id en toda tabla | Schema: events.*
SET search_path TO events, public;

CREATE TABLE IF NOT EXISTS events.suppliers (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name          VARCHAR(200) NOT NULL,
  category      VARCHAR(100),
  contact_name  VARCHAR(200),
  contact_email VARCHAR(200),
  contact_phone VARCHAR(50),
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS suppliers_user_id_idx ON events.suppliers(user_id);

CREATE TABLE IF NOT EXISTS events.event_suppliers (
  id                 SERIAL PRIMARY KEY,
  event_id           INTEGER NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  supplier_id        INTEGER REFERENCES events.suppliers(id) ON DELETE SET NULL,
  supplier_name      VARCHAR(200) NOT NULL,
  role_description   TEXT,
  contracted_amount  NUMERIC(12,2) DEFAULT 0,
  status             VARCHAR(50) DEFAULT 'pending',
  notes              TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS event_suppliers_event_idx ON events.event_suppliers(event_id);
CREATE INDEX IF NOT EXISTS event_suppliers_user_idx  ON events.event_suppliers(user_id);
