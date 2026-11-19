-- Migration: rn_tags.category_slug fix (Wiring Deuda S217j #5b — paso 2b)
-- Fecha: 2026-11-19
-- Scope: patch de backfill. La migración 20261119_1500 asumió nombres del markdown
-- del catálogo v1.3 pero el SQL seed usó versiones cortas distintas:
--   'Industrias Culturales' → en BD vive como 'Cultural'
--   'Transversales'         → 'Transversal'
--   'Rueda de Empleo'       → 'Empleo'
-- Esta migración cubre los 140 tags del catálogo + añade legacy no mapeados.
-- Forward-only. Idempotente.

SET search_path TO events, public;

UPDATE events.rn_tags
   SET category_slug = CASE lower(trim(category))
     WHEN 'cultural'      THEN 'cultural'
     WHEN 'transversal'   THEN 'transversal'
     WHEN 'empleo'        THEN 'empleo'
     ELSE category_slug
   END
 WHERE category_slug IS NULL
   AND lower(trim(category)) IN ('cultural','transversal','empleo');
