-- Migración: events.rn_tags → trilingüe ES/EN/PT
-- Fecha: 2026-11-11 · Sesión S217i
-- Aplicada a prod: 2026-11-11 16:14 UTC (ya ejecutada en VPS cms_signage).
-- Decisión D-A(1): agregar label_en + label_pt para catálogo semilla v1.3 (311 tags trilingües).
-- Nullable por retrocompatibilidad con los 74 tags legacy (solo ES).
-- Seed asociado: SONORO-CMS-KNOWLEDGE/tmp/seed-rn-catalog-v1.3.sql (311 INSERTs user_id=3).
-- Catálogo fuente: SONORO-CMS-KNOWLEDGE/docs/RN-RE-CATALOG-TURISMO-MICE-v1.md v1.3.
-- Snapshot pre-migración: VPS:/tmp/rn_tags_pre_v1.3_20261111_1114.sql (199 líneas).
-- Forward-only. Idempotente (IF NOT EXISTS). Rollback: DROP COLUMN label_en, label_pt;

SET search_path TO events, public;

BEGIN;

ALTER TABLE events.rn_tags
  ADD COLUMN IF NOT EXISTS label_en VARCHAR(100),
  ADD COLUMN IF NOT EXISTS label_pt VARCHAR(100);

-- Verificación
-- \d events.rn_tags
-- SELECT column_name, data_type, character_maximum_length FROM information_schema.columns
--   WHERE table_schema='events' AND table_name='rn_tags' AND column_name IN ('label','label_en','label_pt');

COMMIT;
