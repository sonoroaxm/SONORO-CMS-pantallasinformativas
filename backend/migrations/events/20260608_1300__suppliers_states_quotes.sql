-- Estados cotizado/abono/pagado + abono_amount + tabla supplier_quotes
SET search_path TO events, public;

-- 1. Cambiar valores del check constraint payment_status
ALTER TABLE events.event_suppliers DROP CONSTRAINT IF EXISTS event_suppliers_payment_status_check;
UPDATE events.event_suppliers SET payment_status = 'cotizado' WHERE payment_status IN ('pending','cancelled');
UPDATE events.event_suppliers SET payment_status = 'abono'    WHERE payment_status = 'partial';
UPDATE events.event_suppliers SET payment_status = 'pagado'   WHERE payment_status = 'paid';
ALTER TABLE events.event_suppliers ALTER COLUMN payment_status SET DEFAULT 'cotizado';
ALTER TABLE events.event_suppliers ADD CONSTRAINT event_suppliers_payment_status_check
  CHECK (payment_status IN ('cotizado','abono','pagado'));

-- 2. Monto del abono (solo aplica cuando payment_status='abono')
ALTER TABLE events.event_suppliers ADD COLUMN IF NOT EXISTS abono_amount NUMERIC(12,2) DEFAULT 0;

-- 3. Tabla de cotizaciones enviadas a proveedores
CREATE TABLE IF NOT EXISTS events.supplier_quotes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  event_supplier_id UUID NOT NULL REFERENCES events.event_suppliers(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  token             VARCHAR(64) UNIQUE NOT NULL,
  sent_to_email     VARCHAR(200),
  submitted_at      TIMESTAMPTZ,
  data              JSONB,
  pdf_path          VARCHAR(300),
  status            VARCHAR(20) DEFAULT 'enviada'
                    CHECK (status IN ('enviada','recibida','aceptada','rechazada')),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS supplier_quotes_token_idx    ON events.supplier_quotes(token);
CREATE INDEX IF NOT EXISTS supplier_quotes_sup_idx      ON events.supplier_quotes(event_supplier_id);
