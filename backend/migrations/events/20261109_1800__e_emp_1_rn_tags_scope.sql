-- E-EMP-1 · rn_tags.scope — separa catálogo RN vs RE por tag (S220)
-- Aditivo. Default 'negocios' preserva comportamiento RN.
-- Backfill: categorías canónicas RE (tech_sonoro, soft_sonoro) → 'empleo'.

BEGIN;

ALTER TABLE events.rn_tags
  ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'negocios';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_schema='events' AND constraint_name='rn_tags_scope_check'
  ) THEN
    ALTER TABLE events.rn_tags
      ADD CONSTRAINT rn_tags_scope_check
      CHECK (scope IN ('negocios','empleo','both'));
  END IF;
END $$;

UPDATE events.rn_tags
   SET scope = 'empleo'
 WHERE category IN ('tech_sonoro','soft_sonoro')
   AND scope = 'negocios';

CREATE INDEX IF NOT EXISTS idx_rn_tags_user_scope
  ON events.rn_tags (user_id, scope);

DO $$
DECLARE c_neg INT; c_emp INT; c_both INT;
BEGIN
  SELECT COUNT(*) INTO c_neg  FROM events.rn_tags WHERE scope='negocios';
  SELECT COUNT(*) INTO c_emp  FROM events.rn_tags WHERE scope='empleo';
  SELECT COUNT(*) INTO c_both FROM events.rn_tags WHERE scope='both';
  RAISE NOTICE 'rn_tags scope → negocios=%  empleo=%  both=%', c_neg, c_emp, c_both;
END $$;

COMMIT;

-- Rollback manual:
-- BEGIN;
-- DROP INDEX IF EXISTS events.idx_rn_tags_user_scope;
-- ALTER TABLE events.rn_tags DROP CONSTRAINT IF EXISTS rn_tags_scope_check;
-- ALTER TABLE events.rn_tags DROP COLUMN IF EXISTS scope;
-- COMMIT;
