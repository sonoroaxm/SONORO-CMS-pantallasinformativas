-- S189b · LICENSES-V1 Fase 4 fix
-- Bug: users.country_code/currency tenían NOT NULL + default 'CO'/'COP',
-- por lo que el guard frontend `if (!currentUser.country_code)` nunca
-- disparaba el modal blocking de país. Todos los usuarios quedaban
-- marcados como CO por default (segmentación por país rota).
--
-- Fix: quitar default + NOT NULL, resetear a NULL a todos los usuarios
-- existentes. En próximo login, cada usuario cliente verá el modal
-- blocking una vez (admin queda exento vía guard en dashboard.html).

BEGIN;

ALTER TABLE users
  ALTER COLUMN country_code DROP DEFAULT,
  ALTER COLUMN country_code DROP NOT NULL,
  ALTER COLUMN currency     DROP DEFAULT,
  ALTER COLUMN currency     DROP NOT NULL;

UPDATE users SET country_code = NULL, currency = NULL;

COMMIT;
