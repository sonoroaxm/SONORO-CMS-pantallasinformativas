-- E1: Actualizar roles de staff al listado final acordado
-- Roles anteriores: producer_general, producer_assistant, coordinator, registration_staff, tech, host, security, other
-- Roles nuevos:     coordinator, registration, tech, host, security, catering, artistic_entertainment, other

ALTER TABLE events.event_staff DROP CONSTRAINT IF EXISTS event_staff_role_check;

ALTER TABLE events.event_staff
  ADD CONSTRAINT event_staff_role_check
  CHECK (role IN ('coordinator','registration','tech','host','security','catering','artistic_entertainment','other'));
