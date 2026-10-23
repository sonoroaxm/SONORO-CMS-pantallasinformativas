-- =====================================================================
-- B.0 Taxonomía — pg_trgm + hint column + GIN index
-- Framework: docs/ADR-RN-001-taxonomia-matching.md §5.2
-- Fase: E-RN B.0 (catálogo curado por tenant)
-- Rama: feature/events-rn-v1
-- Forward-only. pg_trgm es extensión core de Postgres.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

SET search_path TO events, public;

-- Índice GIN trigram para fuzzy matching ("¿Quisiste decir ...?").
-- Scoped por user_id en queries vía WHERE user_id = $1 AND similarity(label,$2) > 0.3
CREATE INDEX IF NOT EXISTS idx_rn_tags_label_trgm
  ON events.rn_tags
  USING gin (label gin_trgm_ops);

-- Índice compuesto para búsquedas por tenant + categoría (listados UI).
CREATE INDEX IF NOT EXISTS idx_rn_tags_user_category
  ON events.rn_tags (user_id, category, label);

-- =====================================================================
-- Fin migración 20261023_1900__pg_trgm_rn_tags
-- =====================================================================
