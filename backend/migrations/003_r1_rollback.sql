-- ============================================================
-- SONORO Queue v2 — R1 · Rollback
-- Archivo: 003_r1_rollback.sql
-- Revierte: 003_r1_time_blocks.sql
-- ============================================================
-- ⚠️  ATENCIÓN:
--   Solo ejecutar si la migración 003 produjo inconsistencia
--   detectada en < 24h (Framework §9.2).
--   Si han pasado > 24h, no hacer rollback: aplicar rollforward.
-- ============================================================
-- Pre-condición ABORT:
--   Si time_blocks tiene filas, rollback es destructivo. El
--   script aborta. Forzar `DROP TABLE` con datos vivos sería
--   pérdida de configuración operativa de sucursales.
-- ============================================================
-- Backup obligatorio antes del rollback:
--   pg_dump cms_signage > /opt/backups/pre_003_rollback_$(date +%Y%m%d_%H%M).sql
-- ============================================================
-- btree_gist: NO se desinstala si hay otras dependencias en el
--   catálogo (otra extensión/tabla/índice futuro lo podría usar).
--   El bloque DO chequea pg_depend y solo DROP EXTENSION si el
--   único dependiente era time_blocks.
-- ============================================================

BEGIN;

\echo '== R1 · 003 · Rollback: verificando que time_blocks siga vacía =='

DO $$
DECLARE
  row_count INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='time_blocks') THEN
    SELECT COUNT(*) INTO row_count FROM time_blocks;
    IF row_count > 0 THEN
      RAISE EXCEPTION
        'time_blocks tiene % filas — rollback destructivo, abortar. Aplicar rollforward.',
        row_count;
    END IF;
  END IF;
END $$;

\echo '== R1 · 003 · Rollback: removiendo EXCLUDE constraint =='

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'time_blocks_no_overlap_same_scope') THEN
    ALTER TABLE time_blocks DROP CONSTRAINT time_blocks_no_overlap_same_scope;
    RAISE NOTICE 'EXCLUDE constraint time_blocks_no_overlap_same_scope eliminado';
  END IF;
END $$;

\echo '== R1 · 003 · Rollback: removiendo índice =='

DROP INDEX IF EXISTS idx_time_blocks_branch_service_range;

\echo '== R1 · 003 · Rollback: removiendo tabla time_blocks =='

DROP TABLE IF EXISTS time_blocks;

\echo '== R1 · 003 · Rollback: evaluando DROP EXTENSION btree_gist =='

-- Solo desinstalar la extensión si NO hay otras dependencias.
-- pg_depend.refobjid resuelve a la fila de pg_extension; buscamos
-- objetos del catálogo que dependan de ella (deptype != 'p' pin).
-- En R1, el único dependiente esperable era time_blocks; tras
-- DROP TABLE, debería quedar sin dependientes funcionales.
DO $$
DECLARE
  dep_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dep_count
    FROM pg_depend d
    JOIN pg_extension e ON d.refobjid = e.oid
   WHERE e.extname = 'btree_gist'
     AND d.deptype = 'n';  -- 'n' = normal dependency (no pin)

  IF dep_count = 0 THEN
    DROP EXTENSION IF EXISTS btree_gist;
    RAISE NOTICE 'Extensión btree_gist desinstalada (sin dependencias activas)';
  ELSE
    RAISE NOTICE 'Extensión btree_gist preservada — % dependencia(s) activa(s)', dep_count;
  END IF;
END $$;

\echo '== R1 · 003 · Rollback: verificación post-rollback =='

SELECT
  (SELECT COUNT(*) FROM information_schema.tables
   WHERE table_name = 'time_blocks') AS table_remaining,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname IN ('time_blocks_range_valid',
                     'time_blocks_no_overlap_same_scope')) AS constraints_remaining,
  (SELECT COUNT(*) FROM pg_indexes
   WHERE indexname = 'idx_time_blocks_branch_service_range') AS index_remaining;

-- Esperado: todos los conteos = 0
-- btree_gist puede estar en 0 (desinstalado) o 1 (preservado por
-- dependencia futura) — ambos son válidos.

COMMIT;

\echo '== R1 · 003 · Rollback completado =='
