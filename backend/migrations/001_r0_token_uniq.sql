-- ============================================================
-- SONORO Queue v2 — R0 · Migración forward
-- Archivo: 001_r0_token_uniq.sql
-- Propósito:
--   1) Añadir UNIQUE constraint a queue_tokens para cerrar la
--      race condition pre-existente en POST /api/queue/token.
--   2) Crear tabla idempotency_keys (compartida desde R2).
-- ============================================================
-- Precondición OBLIGATORIA:
--   Ejecutar primero 001_r0_check_duplicates.sql. Si reporta
--   duplicados, NO ejecutar este script. Escalar a Daniel.
-- ============================================================
-- Backup obligatorio (Framework §7.2):
--   pg_dump cms_signage > /opt/backups/pre_001_$(date +%Y%m%d_%H%M).sql
-- ============================================================
-- Uso:
--   sudo -u postgres psql -d cms_signage -f 001_r0_token_uniq.sql
--
-- Rollback:
--   sudo -u postgres psql -d cms_signage -f 001_r0_rollback.sql
-- ============================================================

BEGIN;

\echo '== R0 · Aplicando UNIQUE constraint en queue_tokens =='

-- Idempotente: si ya existe no falla
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'queue_tokens_branch_service_date_token_uniq'
  ) THEN
    ALTER TABLE queue_tokens
      ADD CONSTRAINT queue_tokens_branch_service_date_token_uniq
      UNIQUE (branch_id, service_id, date_key, token_number);
    RAISE NOTICE 'Constraint queue_tokens_branch_service_date_token_uniq creada';
  ELSE
    RAISE NOTICE 'Constraint queue_tokens_branch_service_date_token_uniq ya existe — skip';
  END IF;
END $$;

\echo '== R0 · Creando tabla idempotency_keys =='

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            UUID PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint       VARCHAR(120) NOT NULL,
  request_hash   VARCHAR(64),
  response_body  JSONB NOT NULL,
  response_status INTEGER NOT NULL DEFAULT 200,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
  ON idempotency_keys (expires_at);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_user_endpoint
  ON idempotency_keys (user_id, endpoint);

\echo '== R0 · Verificación =='

SELECT
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname = 'queue_tokens_branch_service_date_token_uniq') AS uniq_constraint_present,
  (SELECT COUNT(*) FROM information_schema.tables
   WHERE table_name = 'idempotency_keys') AS idempotency_table_present;

COMMIT;

\echo '== R0 · Migración aplicada con éxito =='
