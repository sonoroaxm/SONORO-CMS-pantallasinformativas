-- R2: tabla de movimientos de citas (bulk + bloqueos reactivos + cambios admin manuales)
-- NOTA: appointments.id es UUID en producción (el doc de requerimientos decía SERIAL,
--       pero la migración real usó UUID DEFAULT gen_random_uuid()). FK tipada correctamente.
CREATE TABLE IF NOT EXISTS appointment_movements (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  appointment_id     UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  moved_by           INTEGER REFERENCES users(id),
  prev_scheduled_at  TIMESTAMPTZ,
  new_scheduled_at   TIMESTAMPTZ,
  prev_agent_id      UUID,
  new_agent_id       UUID,
  reason             VARCHAR(300),
  bulk_batch_id      UUID,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointment_movements_appointment
  ON appointment_movements (appointment_id);

CREATE INDEX IF NOT EXISTS idx_appointment_movements_batch
  ON appointment_movements (bulk_batch_id)
  WHERE bulk_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appointment_movements_user
  ON appointment_movements (user_id, created_at DESC);
