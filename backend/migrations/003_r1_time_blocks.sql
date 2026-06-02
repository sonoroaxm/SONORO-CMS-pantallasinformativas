-- ============================================================
-- SONORO Queue v2 — R1 · Migración 003
-- Archivo: 003_r1_time_blocks.sql
-- Objetivo: CREATE TABLE time_blocks (preventivo) + enforcement
--           no-overlap vía btree_gist + EXCLUDE USING gist.
-- Pre-cond:  ejecutar después de 002 (no hay dependencia FK
--            directa, pero el orden lógico R1 lo exige).
-- Reactivos (preview/apply) llegan en R2 — fuera de scope.
-- ============================================================
-- Decisión sesión 60 (firmada por Daniel): opción B + 5.1.
--   B   = CREATE EXTENSION btree_gist + EXCLUDE USING gist en BD
--   5.1 = bloque "todos los servicios" (service_id NULL) prohíbe
--         específicos solapados vía validación cross-NULL en
--         endpoint POST /api/queue/time-blocks (§2.8 del R1-PLAN).
--
-- El EXCLUDE cubre 3 de los 4 casos:
--   · mismo service_id no-null no puede solapar
--   · ambos NULL no pueden solapar
--   · un NULL vs específico → endpoint (no expresable en EXCLUDE
--     con WITH = porque NULL no es igual a NULL en SQL).
--
-- Pre-req: PostgreSQL ≥ 9.5 (EXCLUDE USING gist sobre rangos +
--   COALESCE de cast). VPS producción es PG 17.10. ✓
--
-- btree_gist 1.7 verificado disponible (no instalado) en VPS
-- 01/06/2026. El CREATE EXTENSION IF NOT EXISTS de abajo lo
-- instala automáticamente; requiere superuser (rol `postgres`).
-- ============================================================
-- Idempotencia: tabla con IF NOT EXISTS, constraints e índices
-- con DO $$ + catalog checks. Re-ejecutar la migración es safe.
-- ============================================================

BEGIN;

\echo '== R1 · 003 · Instalando extensión btree_gist (idempotente) =='

CREATE EXTENSION IF NOT EXISTS btree_gist;

\echo '== R1 · 003 · Creando tabla time_blocks =='

CREATE TABLE IF NOT EXISTS time_blocks (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id       UUID        NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  service_id      UUID        REFERENCES services(id) ON DELETE CASCADE,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  reason          VARCHAR(200),
  recurrence      TEXT,
  block_batch_id  UUID        DEFAULT gen_random_uuid(),
  created_by      INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT time_blocks_range_valid CHECK (ends_at > starts_at)
);

\echo '== R1 · 003 · Índice de búsqueda por rango =='

CREATE INDEX IF NOT EXISTS idx_time_blocks_branch_service_range
  ON time_blocks (branch_id, service_id, starts_at, ends_at);

\echo '== R1 · 003 · EXCLUDE USING gist anti-overlap (decisión B+5.1) =='

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'time_blocks_no_overlap_same_scope'
  ) THEN
    ALTER TABLE time_blocks
      ADD CONSTRAINT time_blocks_no_overlap_same_scope
      EXCLUDE USING gist (
        branch_id                                  WITH =,
        (COALESCE(service_id::text, '__ALL__'))    WITH =,
        tstzrange(starts_at, ends_at, '[)')        WITH &&
      );
    RAISE NOTICE 'EXCLUDE constraint time_blocks_no_overlap_same_scope creado';
  ELSE
    RAISE NOTICE 'EXCLUDE constraint time_blocks_no_overlap_same_scope ya existía — skip';
  END IF;
END $$;

\echo '== R1 · 003 · Verificación post-migración =='

SELECT
  (SELECT COUNT(*) FROM information_schema.tables
   WHERE table_name = 'time_blocks') AS table_present,
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'time_blocks'
     AND column_name IN ('id','user_id','branch_id','service_id',
                         'starts_at','ends_at','reason','recurrence',
                         'block_batch_id','created_by','created_at')) AS columns_present,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname IN ('time_blocks_range_valid',
                     'time_blocks_no_overlap_same_scope')) AS constraints_present,
  (SELECT COUNT(*) FROM pg_indexes
   WHERE tablename = 'time_blocks'
     AND indexname = 'idx_time_blocks_branch_service_range') AS index_present,
  (SELECT COUNT(*) FROM pg_extension WHERE extname = 'btree_gist') AS btree_gist_installed;

-- Esperado: table_present=1, columns_present=11, constraints_present=2,
--           index_present=1, btree_gist_installed=1

COMMIT;

\echo '== R1 · 003 · Migración completada =='
