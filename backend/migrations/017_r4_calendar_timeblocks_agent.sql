-- Migration 017 — R4: agent_id + calendar source cols en time_blocks
-- Ejecutar en cms_signage como superuser
-- Toda la operación en transacción: si el EXCLUDE falla, rollback automático

BEGIN;

-- 1. Nuevas columnas (ADD-only, nullable → backward compatible)
ALTER TABLE time_blocks
  ADD COLUMN IF NOT EXISTS agent_id          UUID REFERENCES agents(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS calendar_event_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS calendar_provider VARCHAR(20);

-- 2. Índices de soporte
CREATE INDEX IF NOT EXISTS idx_time_blocks_agent
  ON time_blocks (agent_id)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_time_blocks_cal_event
  ON time_blocks (calendar_event_id, calendar_provider)
  WHERE calendar_event_id IS NOT NULL;

-- 3. Recrear EXCLUDE incluyendo agent_id
--    COALESCE(agent_id::text, '__ALL__') permite que dos agentes distintos
--    tengan bloques solapados (cada uno con su propio scope).
--    Bloques manuales (agent_id IS NULL) → '__ALL__': siguen sin solaparse entre sí.
ALTER TABLE time_blocks
  DROP CONSTRAINT IF EXISTS time_blocks_no_overlap_same_scope;

ALTER TABLE time_blocks
  ADD CONSTRAINT time_blocks_no_overlap_same_scope
  EXCLUDE USING gist (
    branch_id                                WITH =,
    COALESCE(service_id::text, '__ALL__')    WITH =,
    COALESCE(agent_id::text,   '__ALL__')    WITH =,
    tstzrange(starts_at, ends_at, '[)')      WITH &&
  );

COMMIT;
