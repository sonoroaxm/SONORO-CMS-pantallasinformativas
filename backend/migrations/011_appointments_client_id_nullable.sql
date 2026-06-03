-- client_id_number puede ser NULL para citas de agente (follow_up) donde no se conoce la cédula
ALTER TABLE appointments ALTER COLUMN client_id_number DROP NOT NULL;

-- Recrear índice como parcial (solo filas con cédula real) para no indexar NULLs
DROP INDEX IF EXISTS idx_appointments_client_id;
CREATE INDEX IF NOT EXISTS idx_appointments_client_id
  ON appointments(user_id, client_id_number)
  WHERE client_id_number IS NOT NULL;
