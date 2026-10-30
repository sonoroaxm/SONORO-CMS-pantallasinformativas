-- E-RN-10 · Expediente post-cita + comunicaciones post-cita
-- Fecha: 2026-10-29 · Rama: main (aditivo puro)
-- Rector: docs/EVENTS-FRAMEWORK.md v1.2 + docs/PLAN-E-RN-10-expediente-post-cita.md
--
-- Crea 4 tablas aditivas en schema events:
--   1. rn_meeting_outcomes    — ficha post-cita bilateral por lado (UNIQUE meeting+side).
--   2. rn_meeting_feedback    — feedback privado del supplier por 6 dimensiones.
--   3. rn_meeting_followups   — checkpoints 7/30/60/90 días con state pipeline.
--   4. rn_comms_log           — bitácora idempotente de EOD digest + 4 nudges opcionales.
-- Y agrega opt-out dedicado para comunicaciones post-cita en rn_delegates
-- (diferente de opt_out matchmaking que ya existe).
--
-- Principios EVENTS-FRAMEWORK aplicados:
--   P1 Multi-día nativo        → outcomes refieren a rn_meetings (ya multi-día).
--   P2 Multi-tenancy estricta  → user_id denormalizado en las 4 tablas.
--   P3 Transaccionalidad       → consumido vía withTransaction en endpoints.
--   P5 Timezone del evento     → due_at / scheduled_for TIMESTAMPTZ (sin TZ hardcoded).

SET search_path TO events, public;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. OUTCOMES — ficha post-cita por lado
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events.rn_meeting_outcomes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      UUID NOT NULL REFERENCES events.rn_meetings(id) ON DELETE CASCADE,
  side            VARCHAR(1) NOT NULL CHECK (side IN ('A','B')),
  user_id         INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  delegate_id     UUID NOT NULL REFERENCES events.rn_delegates(id) ON DELETE CASCADE,
  result          VARCHAR(30) NOT NULL
                  CHECK (result IN ('match','conditional','needs_info','no_match','no_show')),
  next_step       VARCHAR(30) NOT NULL
                  CHECK (next_step IN ('quote','sample','catalog','tech_spec','intro','second_meeting','pilot','none')),
  owner_side      VARCHAR(4) CHECK (owner_side IN ('A','B','both')),
  due_at          TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  share_with_counterpart BOOLEAN NOT NULL DEFAULT FALSE,
  share_with_producer    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(meeting_id, side)
);

CREATE INDEX IF NOT EXISTS idx_rn_outcomes_meeting   ON events.rn_meeting_outcomes(meeting_id);
CREATE INDEX IF NOT EXISTS idx_rn_outcomes_delegate  ON events.rn_meeting_outcomes(delegate_id);
CREATE INDEX IF NOT EXISTS idx_rn_outcomes_user      ON events.rn_meeting_outcomes(user_id);
CREATE INDEX IF NOT EXISTS idx_rn_outcomes_due       ON events.rn_meeting_outcomes(due_at)
  WHERE due_at IS NOT NULL AND completed_at IS NULL;

COMMENT ON TABLE events.rn_meeting_outcomes IS
  'Ficha post-cita bilateral. Cada lado llena su ficha. UNIQUE(meeting_id,side) garantiza una por lado.';
COMMENT ON COLUMN events.rn_meeting_outcomes.result IS
  'Resultado reportado por este lado. no_match/no_show cierran ficha sin next_step.';
COMMENT ON COLUMN events.rn_meeting_outcomes.owner_side IS
  'Responsable del próximo paso. both = ambos ejecutan algo.';
COMMENT ON COLUMN events.rn_meeting_outcomes.share_with_counterpart IS
  'Si TRUE, la contraparte puede ver este outcome en su ficha.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FEEDBACK — supplier privado por dimensiones
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events.rn_meeting_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      UUID NOT NULL REFERENCES events.rn_meetings(id) ON DELETE CASCADE,
  from_side       VARCHAR(1) NOT NULL CHECK (from_side IN ('A','B')),
  user_id         INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  delegate_id     UUID NOT NULL REFERENCES events.rn_delegates(id) ON DELETE CASCADE,
  dim_fit         VARCHAR(10) CHECK (dim_fit      IN ('good','partial','poor','na')),
  dim_docs        VARCHAR(10) CHECK (dim_docs     IN ('good','partial','poor','na')),
  dim_price       VARCHAR(10) CHECK (dim_price    IN ('good','partial','poor','na')),
  dim_capacity    VARCHAR(10) CHECK (dim_capacity IN ('good','partial','poor','na')),
  dim_timing      VARCHAR(10) CHECK (dim_timing   IN ('good','partial','poor','na')),
  dim_clarity     VARCHAR(10) CHECK (dim_clarity  IN ('good','partial','poor','na')),
  note            TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  visibility      VARCHAR(15) NOT NULL DEFAULT 'producer_only'
                  CHECK (visibility IN ('counterpart','producer_only','both')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(meeting_id, from_side)
);

CREATE INDEX IF NOT EXISTS idx_rn_feedback_meeting  ON events.rn_meeting_feedback(meeting_id);
CREATE INDEX IF NOT EXISTS idx_rn_feedback_user     ON events.rn_meeting_feedback(user_id);

COMMENT ON TABLE events.rn_meeting_feedback IS
  'Feedback por dimensiones. Default visibility=producer_only (no se filtra a contraparte).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FOLLOWUPS — checkpoints 7/30/60/90 días
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events.rn_meeting_followups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      UUID NOT NULL REFERENCES events.rn_meetings(id) ON DELETE CASCADE,
  side            VARCHAR(1) NOT NULL CHECK (side IN ('A','B')),
  user_id         INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  delegate_id     UUID NOT NULL REFERENCES events.rn_delegates(id) ON DELETE CASCADE,
  state           VARCHAR(20) NOT NULL
                  CHECK (state IN ('initiated','pending_info','evaluation','quoted','negotiation','pilot','won','paused','no_fit')),
  checkpoint_day  SMALLINT NOT NULL CHECK (checkpoint_day IN (7,30,60,90)),
  note            TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  reported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(meeting_id, side, checkpoint_day)
);

CREATE INDEX IF NOT EXISTS idx_rn_followups_meeting   ON events.rn_meeting_followups(meeting_id);
CREATE INDEX IF NOT EXISTS idx_rn_followups_user      ON events.rn_meeting_followups(user_id);
CREATE INDEX IF NOT EXISTS idx_rn_followups_delegate  ON events.rn_meeting_followups(delegate_id);

COMMENT ON TABLE events.rn_meeting_followups IS
  'Snapshot temporal del estado del compromiso en checkpoints fijos. Un row por (meeting,side,checkpoint).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. COMMS LOG — bitácora EOD digest + 4 nudges opcionales
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events.rn_comms_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  delegate_id     UUID NOT NULL REFERENCES events.rn_delegates(id) ON DELETE CASCADE,
  meeting_id      UUID REFERENCES events.rn_meetings(id) ON DELETE CASCADE,
  outcome_id      UUID REFERENCES events.rn_meeting_outcomes(id) ON DELETE SET NULL,
  nudge_type      VARCHAR(25) NOT NULL
                  CHECK (nudge_type IN ('eod_digest','nudge_48h','nudge_7d','due_pre_24h','due_overdue_24h')),
  digest_day      DATE,
  scheduled_for   TIMESTAMPTZ NOT NULL,
  sent_at         TIMESTAMPTZ,
  skipped_reason  VARCHAR(60),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotencia por nudge_type (ver §5 PLAN-E-RN-10):
--   eod_digest        → por delegado y día
--   nudge_48h/_7d     → por meeting+delegado+tipo
--   due_pre/overdue   → por outcome+tipo
CREATE UNIQUE INDEX IF NOT EXISTS uq_rn_comms_eod
  ON events.rn_comms_log (delegate_id, digest_day)
  WHERE nudge_type = 'eod_digest';
CREATE UNIQUE INDEX IF NOT EXISTS uq_rn_comms_meeting_nudge
  ON events.rn_comms_log (meeting_id, delegate_id, nudge_type)
  WHERE nudge_type IN ('nudge_48h','nudge_7d');
CREATE UNIQUE INDEX IF NOT EXISTS uq_rn_comms_outcome_due
  ON events.rn_comms_log (outcome_id, nudge_type)
  WHERE nudge_type IN ('due_pre_24h','due_overdue_24h');

CREATE INDEX IF NOT EXISTS idx_rn_comms_event      ON events.rn_comms_log(event_id);
CREATE INDEX IF NOT EXISTS idx_rn_comms_due        ON events.rn_comms_log(scheduled_for) WHERE sent_at IS NULL;

COMMENT ON TABLE events.rn_comms_log IS
  'Bitácora de comunicaciones post-cita. UNIQUEs parciales garantizan idempotencia por tipo.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ALTER rn_delegates — opt-out dedicado para comms post-cita
-- ─────────────────────────────────────────────────────────────────────────────
-- Semánticamente separado de opt_out (matchmaking/ARCO). comms_opt_out
-- deja de recibir EOD + nudges pero no bloquea el matcher ni cancela citas.
ALTER TABLE events.rn_delegates
  ADD COLUMN IF NOT EXISTS comms_opt_out    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS comms_opt_out_at TIMESTAMPTZ;

COMMENT ON COLUMN events.rn_delegates.comms_opt_out IS
  'Opt-out de comunicaciones post-cita (EOD digest + nudges). Separado de opt_out ARCO.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. events.events.config.rn_comms — JSONB documentado, sin schema enforcement
-- ─────────────────────────────────────────────────────────────────────────────
-- Estructura esperada bajo events.config.rn_comms:
--   {
--     "paused": false,
--     "eod_digest": { "enabled": true },        -- siempre true, no desactivable UI
--     "nudges": {
--       "nudge_48h":        { "enabled": false },
--       "nudge_7d":         { "enabled": false },
--       "due_pre_24h":      { "enabled": false },
--       "due_overdue_24h":  { "enabled": false }
--     }
--   }
-- PATCH /api/events/:id valida esta forma a nivel aplicación.

-- ─────────────────────────────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM information_schema.tables
    WHERE table_schema = 'events'
      AND table_name IN ('rn_meeting_outcomes','rn_meeting_feedback','rn_meeting_followups','rn_comms_log');
  IF n <> 4 THEN
    RAISE EXCEPTION 'E-RN-10 migración: se esperaban 4 tablas nuevas, se encontraron %', n;
  END IF;
  RAISE NOTICE 'E-RN-10 schema OK · 4 tablas creadas · rn_delegates.comms_opt_out agregado.';
END $$;
