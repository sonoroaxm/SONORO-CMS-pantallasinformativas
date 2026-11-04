-- =====================================================================
-- E-EMP-0 · Rueda de Empleo — Schema delta aditivo
-- Fecha: 2026-11-04 · Sesión: S218 · Rama: feature/empleo-v1
-- Framework rector: docs/EMPLEO-FRAMEWORK-v1.md v1.0 §6
-- Gate: G-EMP-0 FIRMADO (Daniel, 2026-11-03) habilita sólo schema delta.
-- E-EMP-1 (wizard setup + seed on-demand) permanece BLOQUEADO hasta G-EMP-1.
--
-- Scope: 9 cambios aditivos a schema `events`. CERO INSERTs (seed diferido).
-- CERO modificación a RN producción. Cada cambio protegido por default safe
-- o IF NOT EXISTS.
--
-- Decisiones S218 (correcciones al framework §6 contra schema real):
--   1. `rueda_type` va en events.events, NO en rn_sessions (tabla inexistente).
--      Semánticamente: cada Rueda = un events.events hijo vía
--      event_sessions.linked_rueda_id (patrón S212 E-RN-11). RN y RE son
--      herramientas dentro de un evento corporativo mayor, no scopes propios.
--   2. rn_meeting_outcomes.result CHECK se AMPLIA a unión RN+RE (11 valores),
--      NO se reemplaza. Preserva code RN productivo.
--   3. Seed 17 habilidades blandas DIFERIDO a E-EMP-1 (rn_tags schema real
--      exige user_id NOT NULL; mecanismo = seed on-demand por tenant al
--      activar rueda_type='empleo' en wizard setup).
--
-- Principios EVENTS-FRAMEWORK aplicados:
--   P1 Multi-día nativo     → ninguna columna asume evento de 1 día.
--   P2 Multi-tenancy        → rn_match_weights denormaliza user_id.
--   P3 Transaccionalidad    → migración idempotente (IF NOT EXISTS + CHECK).
--   P5 Timezone del evento  → retention_until TIMESTAMPTZ (sin TZ hardcoded).
--
-- Rollback: forward-only. Revert vía DROP COLUMN / DROP TABLE individuales
-- (comandos documentados al final). Feature flag efectiva: ausencia de
-- UI E-EMP-1 (ningún endpoint E-EMP-* existe hasta merge próximo).
-- =====================================================================

SET search_path TO events, public;

-- ---------------------------------------------------------------------
-- 0. Extensión pgcrypto (requerida por columna BYTEA encriptada #5.b)
-- ---------------------------------------------------------------------
-- Idempotente. Si ya está, no-op.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- 1. events.events.rueda_type — distingue tipo de rueda
-- ---------------------------------------------------------------------
-- Corrige framework §6 línea 176 que mencionaba rn_sessions (inexistente).
-- Default 'negocios' marca todos los eventos existentes (incluidos los
-- que no son ruedas); el filtro operativo real es config.rn_enabled=true
-- AND rueda_type='empleo'. Cero impacto a RN producción.
ALTER TABLE events.events
  ADD COLUMN IF NOT EXISTS rueda_type VARCHAR(20) NOT NULL DEFAULT 'negocios';

ALTER TABLE events.events
  DROP CONSTRAINT IF EXISTS events_rueda_type_check;

ALTER TABLE events.events
  ADD CONSTRAINT events_rueda_type_check
  CHECK (rueda_type IN ('negocios','empleo'));

COMMENT ON COLUMN events.events.rueda_type IS
  'Tipo de rueda cuando config.rn_enabled=true. Default negocios protege eventos RN existentes. Introducido S218/E-EMP-0.';

-- ---------------------------------------------------------------------
-- 2. events.rn_tags.dimension — hard (técnica) vs soft (blanda)
-- ---------------------------------------------------------------------
-- Default 'hard' cubre tags técnicas RN existentes sin backfill. Las tags
-- blandas se crearán on-demand por tenant en E-EMP-1 con dimension='soft'.
ALTER TABLE events.rn_tags
  ADD COLUMN IF NOT EXISTS dimension VARCHAR(10) NOT NULL DEFAULT 'hard';

ALTER TABLE events.rn_tags
  DROP CONSTRAINT IF EXISTS rn_tags_dimension_check;

ALTER TABLE events.rn_tags
  ADD CONSTRAINT rn_tags_dimension_check
  CHECK (dimension IN ('hard','soft'));

CREATE INDEX IF NOT EXISTS idx_rn_tags_user_dimension
  ON events.rn_tags (user_id, dimension);

COMMENT ON COLUMN events.rn_tags.dimension IS
  'Dimensión de matching. hard=habilidad técnica (RN+RE), soft=habilidad blanda (RE). Default hard por retrocompat RN.';

-- ---------------------------------------------------------------------
-- 3. events.rn_match_weights — pesos y umbrales de matching por evento
-- ---------------------------------------------------------------------
-- Una fila por evento RE. Sin fila = defaults framework (60/40, 0.70/0.40).
-- user_id denormalizado para P2 multi-tenancy strict.
CREATE TABLE IF NOT EXISTS events.rn_match_weights (
  event_id             UUID PRIMARY KEY REFERENCES events.events(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  w_hard               SMALLINT NOT NULL DEFAULT 60 CHECK (w_hard BETWEEN 0 AND 100),
  w_soft               SMALLINT NOT NULL DEFAULT 40 CHECK (w_soft BETWEEN 0 AND 100),
  threshold_strong     NUMERIC(3,2) NOT NULL DEFAULT 0.70 CHECK (threshold_strong BETWEEN 0 AND 1),
  threshold_tentative  NUMERIC(3,2) NOT NULL DEFAULT 0.40 CHECK (threshold_tentative BETWEEN 0 AND 1),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rn_match_weights_sum_100  CHECK (w_hard + w_soft = 100),
  CONSTRAINT rn_match_weights_order    CHECK (threshold_tentative <= threshold_strong)
);

CREATE INDEX IF NOT EXISTS idx_rn_match_weights_user
  ON events.rn_match_weights (user_id);

COMMENT ON TABLE events.rn_match_weights IS
  'Pesos w_hard/w_soft y umbrales de matching por evento RE. Sin fila = usar defaults framework §2.';
COMMENT ON COLUMN events.rn_match_weights.threshold_strong IS
  'Score >= este umbral → match_strong (visual verde en preview productor).';
COMMENT ON COLUMN events.rn_match_weights.threshold_tentative IS
  'Score >= este umbral (pero < strong) → match_tentative (visual ámbar).';

-- ---------------------------------------------------------------------
-- 4. events.registrations.party_type — lado de la rueda (empresa/ofertante)
-- ---------------------------------------------------------------------
-- NULL = Rueda de Negocios clásica (compat 100% RN). Set a 'empresa' o
-- 'ofertante' sólo en registros de eventos con rueda_type='empleo'.
ALTER TABLE events.registrations
  ADD COLUMN IF NOT EXISTS party_type VARCHAR(20);

ALTER TABLE events.registrations
  DROP CONSTRAINT IF EXISTS registrations_party_type_check;

ALTER TABLE events.registrations
  ADD CONSTRAINT registrations_party_type_check
  CHECK (party_type IS NULL OR party_type IN ('empresa','ofertante'));

CREATE INDEX IF NOT EXISTS idx_registrations_party_type
  ON events.registrations (event_id, party_type)
  WHERE party_type IS NOT NULL;

COMMENT ON COLUMN events.registrations.party_type IS
  'Lado de la Rueda de Empleo. NULL = registro RN clásico. Introducido S218/E-EMP-0.';

-- ---------------------------------------------------------------------
-- 5. events.registrations — columnas sensibles ofertante (Habeas Data)
-- ---------------------------------------------------------------------
-- Scaffolding de las columnas. El endurecimiento Habeas Data (consent
-- separado, encriptación efectiva, cron de borrado 6m) se implementa en
-- E-EMP-3 (bloqueante G-EMP-1 según framework §9).
ALTER TABLE events.registrations
  ADD COLUMN IF NOT EXISTS cv_pdf_url                    TEXT,
  ADD COLUMN IF NOT EXISTS salary_expectation_encrypted  BYTEA,
  ADD COLUMN IF NOT EXISTS banco_talento_opt_in          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS retention_until               TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_registrations_retention
  ON events.registrations (retention_until)
  WHERE retention_until IS NOT NULL;

COMMENT ON COLUMN events.registrations.cv_pdf_url IS
  'URL storage del CV del ofertante (AES at-rest en storage). Framework §9.';
COMMENT ON COLUMN events.registrations.salary_expectation_encrypted IS
  'Pretensión salarial encriptada via pgcrypto (pgp_sym_encrypt). Framework §9.';
COMMENT ON COLUMN events.registrations.banco_talento_opt_in IS
  'Consentimiento explícito separado para banco de talento 6m. Framework §8.7+9.';
COMMENT ON COLUMN events.registrations.retention_until IS
  'Fecha límite retención datos ofertante (típico NOW()+6m). Cron borrado automático en E-EMP-7.';

-- ---------------------------------------------------------------------
-- 6. events.rn_meeting_outcomes.result — AMPLIAR a unión RN+RE (11 valores)
-- ---------------------------------------------------------------------
-- DECISIÓN S218 crítica: ampliar el CHECK a unión, NO reemplazarlo.
-- Estado previo (S213 E-RN-10): VARCHAR(30) con 5 valores RN.
-- Estado posterior: VARCHAR(40) con 11 valores (5 RN + 6 RE nuevos;
-- 'no_match' y 'no_show' aparecen en ambos lados, no se duplican).
-- RN seguirá insertando 'match'/'conditional'/'needs_info' sin error.
-- Filtrado por módulo lo hace el code via events.rueda_type.
ALTER TABLE events.rn_meeting_outcomes
  ALTER COLUMN result TYPE VARCHAR(40);

ALTER TABLE events.rn_meeting_outcomes
  DROP CONSTRAINT IF EXISTS rn_meeting_outcomes_result_check;

ALTER TABLE events.rn_meeting_outcomes
  ADD CONSTRAINT rn_meeting_outcomes_result_check
  CHECK (result IN (
    -- RN (S213, intocables)
    'match', 'conditional', 'needs_info', 'no_match', 'no_show',
    -- RE (E-EMP-0 nuevos; no_match y no_show ya están arriba)
    'continuar_negocio', 'info_adicional', 'no_interes',
    'contratacion_directa', 'entrevista_siguiente_fase', 'banco_talento'
  ));

COMMENT ON COLUMN events.rn_meeting_outcomes.result IS
  'Outcome de la cita. Enum code-level por módulo: RN usa match/conditional/needs_info/no_match/no_show; RE usa continuar_negocio/info_adicional/no_interes/contratacion_directa/entrevista_siguiente_fase/banco_talento/no_match/no_show. Filtrado por events.rueda_type.';

-- ---------------------------------------------------------------------
-- 7. events.rn_rounds.is_open_round — rondas abiertas al final (RE D4)
-- ---------------------------------------------------------------------
-- Rondas finales donde ofertantes no matcheados exploran libremente.
-- Default FALSE preserva comportamiento RN actual.
ALTER TABLE events.rn_rounds
  ADD COLUMN IF NOT EXISTS is_open_round BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN events.rn_rounds.is_open_round IS
  'Ronda abierta al final (RE D4) — libre exploración para ofertantes sin match. Default FALSE preserva RN.';

-- =====================================================================
-- Verificación — levanta excepción si el schema no quedó como se espera
-- =====================================================================
DO $$
DECLARE
  n_cols         INT;
  n_tables_new   INT;
  n_check_result INT;
BEGIN
  -- 1. events.rueda_type + 2. rn_tags.dimension + 7. rn_rounds.is_open_round
  SELECT COUNT(*) INTO n_cols
  FROM information_schema.columns
  WHERE (table_schema, table_name, column_name) IN (
    ('events', 'events',    'rueda_type'),
    ('events', 'rn_tags',   'dimension'),
    ('events', 'rn_rounds', 'is_open_round')
  );
  IF n_cols <> 3 THEN
    RAISE EXCEPTION 'E-EMP-0: se esperaban 3 columnas base (rueda_type/dimension/is_open_round), encontradas %', n_cols;
  END IF;

  -- 3. rn_match_weights tabla nueva
  SELECT COUNT(*) INTO n_tables_new
  FROM information_schema.tables
  WHERE table_schema = 'events' AND table_name = 'rn_match_weights';
  IF n_tables_new <> 1 THEN
    RAISE EXCEPTION 'E-EMP-0: tabla rn_match_weights no creada';
  END IF;

  -- 4+5. registrations columnas nuevas (5 columnas: party_type + 4 habeas data)
  SELECT COUNT(*) INTO n_cols
  FROM information_schema.columns
  WHERE table_schema = 'events' AND table_name = 'registrations'
    AND column_name IN (
      'party_type', 'cv_pdf_url', 'salary_expectation_encrypted',
      'banco_talento_opt_in', 'retention_until'
    );
  IF n_cols <> 5 THEN
    RAISE EXCEPTION 'E-EMP-0: se esperaban 5 columnas nuevas en registrations, encontradas %', n_cols;
  END IF;

  -- 6. result ampliado a VARCHAR(40) + CHECK con 11 literales
  SELECT character_maximum_length INTO n_cols
  FROM information_schema.columns
  WHERE table_schema = 'events' AND table_name = 'rn_meeting_outcomes'
    AND column_name = 'result';
  IF n_cols <> 40 THEN
    RAISE EXCEPTION 'E-EMP-0: result debería ser VARCHAR(40), es VARCHAR(%)', n_cols;
  END IF;

  SELECT COUNT(*) INTO n_check_result
  FROM pg_constraint
  WHERE conname = 'rn_meeting_outcomes_result_check';
  IF n_check_result <> 1 THEN
    RAISE EXCEPTION 'E-EMP-0: CHECK rn_meeting_outcomes_result_check no encontrado';
  END IF;

  -- pgcrypto disponible
  PERFORM 1 FROM pg_extension WHERE extname = 'pgcrypto';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'E-EMP-0: extension pgcrypto no instalada';
  END IF;

  RAISE NOTICE 'E-EMP-0 schema OK · 9 cambios aditivos aplicados · seed diferido a E-EMP-1.';
END $$;

-- =====================================================================
-- Rollback manual (forward-only, pero documentado por si se requiere):
--
--   BEGIN;
--   ALTER TABLE events.rn_rounds             DROP COLUMN IF EXISTS is_open_round;
--   ALTER TABLE events.rn_meeting_outcomes   DROP CONSTRAINT IF EXISTS rn_meeting_outcomes_result_check;
--   ALTER TABLE events.rn_meeting_outcomes   ADD  CONSTRAINT rn_meeting_outcomes_result_check
--     CHECK (result IN ('match','conditional','needs_info','no_match','no_show'));
--   ALTER TABLE events.rn_meeting_outcomes   ALTER COLUMN result TYPE VARCHAR(30);
--   ALTER TABLE events.registrations         DROP COLUMN IF EXISTS retention_until,
--                                            DROP COLUMN IF EXISTS banco_talento_opt_in,
--                                            DROP COLUMN IF EXISTS salary_expectation_encrypted,
--                                            DROP COLUMN IF EXISTS cv_pdf_url,
--                                            DROP COLUMN IF EXISTS party_type;
--   DROP TABLE  IF EXISTS events.rn_match_weights;
--   ALTER TABLE events.rn_tags               DROP COLUMN IF EXISTS dimension;
--   ALTER TABLE events.events                DROP COLUMN IF EXISTS rueda_type;
--   -- pgcrypto se deja instalada (otras migraciones pueden requerirla).
--   COMMIT;
-- =====================================================================
