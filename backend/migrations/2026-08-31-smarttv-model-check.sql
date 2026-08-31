-- S186g — extender devices.model_check para aceptar 'smarttv'
-- Gap detectado post-S186e al intentar INSERT primer device smarttv (id=324).
-- Aditivo: agrega 'smarttv' al enum existente (rpi4|rpi5|windows) sin remover valores.
-- Idempotente: DROP IF EXISTS + ADD garantiza que re-correr no falle.

BEGIN;

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_model_check;
ALTER TABLE devices ADD CONSTRAINT devices_model_check
  CHECK (model IN ('rpi4','rpi5','windows','smarttv'));

COMMIT;
