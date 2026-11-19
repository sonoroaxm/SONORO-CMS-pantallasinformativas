-- Migration: rn_tags.category_slug (Wiring Deuda S217j #5b — paso 2)
-- Fecha: 2026-11-19
-- Scope: columna aditiva + backfill para JOIN limpio contra events.rn_tag_categories.
-- Preserva events.rn_tags.category (texto legado) como fallback ES.
-- Forward-only. Rollback: ALTER TABLE events.rn_tags DROP COLUMN category_slug;

SET search_path TO events, public;

ALTER TABLE events.rn_tags
  ADD COLUMN IF NOT EXISTS category_slug VARCHAR(60);

-- Backfill: mapea los valores actuales de category (proper case S217i + legacy lowercase)
-- a los slugs normalizados de rn_tag_categories. Idempotente.
UPDATE events.rn_tags
   SET category_slug = CASE lower(trim(category))
     WHEN 'turismo'                 THEN 'turismo'
     WHEN 'mice'                    THEN 'mice'
     WHEN 'bodas'                   THEN 'bodas'
     WHEN 'industrias culturales'   THEN 'cultural'
     WHEN 'comex'                   THEN 'comex'
     WHEN 'transversales'           THEN 'transversal'
     WHEN 'rueda de empleo'         THEN 'empleo'
     WHEN 'financiero'              THEN 'financiero'
     WHEN 'legal'                   THEN 'legal'
     WHEN 'rrhh'                    THEN 'rrhh'
     WHEN 'servicios'               THEN 'servicios'
     WHEN 'tecnologia'              THEN 'tecnologia'
     WHEN 'tecnología'              THEN 'tecnologia'
     WHEN 'marketing'               THEN 'marketing'
     ELSE NULL
   END
 WHERE category IS NOT NULL
   AND (category_slug IS NULL OR category_slug <> CASE lower(trim(category))
     WHEN 'turismo'                 THEN 'turismo'
     WHEN 'mice'                    THEN 'mice'
     WHEN 'bodas'                   THEN 'bodas'
     WHEN 'industrias culturales'   THEN 'cultural'
     WHEN 'comex'                   THEN 'comex'
     WHEN 'transversales'           THEN 'transversal'
     WHEN 'rueda de empleo'         THEN 'empleo'
     WHEN 'financiero'              THEN 'financiero'
     WHEN 'legal'                   THEN 'legal'
     WHEN 'rrhh'                    THEN 'rrhh'
     WHEN 'servicios'               THEN 'servicios'
     WHEN 'tecnologia'              THEN 'tecnologia'
     WHEN 'tecnología'              THEN 'tecnologia'
     WHEN 'marketing'               THEN 'marketing'
     ELSE NULL
   END);

CREATE INDEX IF NOT EXISTS idx_rn_tags_user_category_slug
  ON events.rn_tags (user_id, category_slug);

COMMENT ON COLUMN events.rn_tags.category_slug IS
  'FK lógica a events.rn_tag_categories.slug. Aditivo S217j wiring 2026-11-19. category (texto) queda como fallback ES.';
