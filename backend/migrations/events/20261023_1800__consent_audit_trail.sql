-- =====================================================================
-- Consent audit trail — Ley 1581/2012 Colombia (Habeas Data)
-- Framework: docs/legal/POLITICA-EVENTS-v1.md §7.3
-- Fase: E-RN (B.0 taxonomía) — gobernanza legal del módulo Events v1
-- Rama: feature/events-rn-v1 (NO MERGE a main hasta G-RN-1 piloto)
-- Forward-only. Rollback via columnas opcionales + feature flag.
-- =====================================================================
--
-- Añade:
--   1) events.events: datos legales del organizador (Responsable del Tratamiento)
--      razón social, NIT, OPD, URL política de privacidad, versión, plantilla
--   2) events.registrations: audit trail del consentimiento del asistente
--      consent_* (6 columnas) para probar consentimiento previo, expreso e informado
--   3) events.rn_delegates: opt_out explícito del matchmaking (derecho de oposición ARCO)
--
-- Principio: todas las columnas aditivas NULLABLE para no romper filas existentes.
-- Los endpoints de registro público (B.1+) harán enforce de NOT NULL vía app layer.
-- =====================================================================

SET search_path TO events, public;

-- ---------------------------------------------------------------------
-- 1. Datos legales del organizador en events.events
-- ---------------------------------------------------------------------
-- El organizador es el Responsable del Tratamiento (Ley 1581 §3.e).
-- SONORO AV SAS es Encargado. El consent del asistente se dirige al organizador.
-- Estos campos se capturan en el wizard "Datos legales" (step 3) del setup.
--
ALTER TABLE events.events
  ADD COLUMN IF NOT EXISTS organizer_legal_name   VARCHAR(200),
  ADD COLUMN IF NOT EXISTS organizer_tax_id       VARCHAR(40),
  ADD COLUMN IF NOT EXISTS organizer_country      VARCHAR(2) DEFAULT 'CO',
  ADD COLUMN IF NOT EXISTS organizer_address      VARCHAR(300),
  ADD COLUMN IF NOT EXISTS organizer_dpo_name     VARCHAR(150),
  ADD COLUMN IF NOT EXISTS organizer_dpo_email    VARCHAR(200),
  ADD COLUMN IF NOT EXISTS organizer_dpo_phone    VARCHAR(40),
  ADD COLUMN IF NOT EXISTS privacy_policy_source  VARCHAR(20)
    CHECK (privacy_policy_source IN ('organizer','sonoro_template',NULL)),
  ADD COLUMN IF NOT EXISTS privacy_policy_url     VARCHAR(500),
  ADD COLUMN IF NOT EXISTS privacy_policy_version VARCHAR(20),
  ADD COLUMN IF NOT EXISTS privacy_policy_effective_date DATE;

COMMENT ON COLUMN events.events.organizer_legal_name   IS 'Razón social del Responsable del Tratamiento (Ley 1581 §3.e)';
COMMENT ON COLUMN events.events.organizer_tax_id       IS 'NIT o identificador fiscal del Responsable';
COMMENT ON COLUMN events.events.organizer_dpo_email    IS 'Correo del Oficial de Protección de Datos para solicitudes ARCO';
COMMENT ON COLUMN events.events.privacy_policy_source  IS 'organizer=política propia · sonoro_template=plantilla generada por SONORO';

-- ---------------------------------------------------------------------
-- 2. Audit trail del consentimiento en events.registrations
-- ---------------------------------------------------------------------
-- Cada registro público captura:
--   - consent_accepted           : TRUE si el checkbox fue marcado
--   - consent_accepted_at        : timestamp exacto de la aceptación
--   - consent_ip                 : IP origen (prueba de contexto)
--   - consent_user_agent         : UA del navegador
--   - consent_text_hash          : SHA-256 del texto literal renderizado
--                                  (prueba de QUÉ aceptó el titular)
--   - consent_policy_version     : versión de esta política vigente al momento
--
-- La columna legacy accepted_terms ya existe en el schema base (DEFAULT FALSE);
-- se mantiene como boolean operativo, consent_* lo complementa con audit trail.
--
ALTER TABLE events.registrations
  ADD COLUMN IF NOT EXISTS consent_accepted        BOOLEAN,
  ADD COLUMN IF NOT EXISTS consent_accepted_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consent_ip              INET,
  ADD COLUMN IF NOT EXISTS consent_user_agent      TEXT,
  ADD COLUMN IF NOT EXISTS consent_text_hash       VARCHAR(64),
  ADD COLUMN IF NOT EXISTS consent_policy_version  VARCHAR(20);

COMMENT ON COLUMN events.registrations.consent_text_hash
  IS 'SHA-256 (hex, 64 chars) del texto exacto de autorización mostrado al titular';
COMMENT ON COLUMN events.registrations.consent_policy_version
  IS 'Versión semántica de POLITICA-EVENTS-v{N} vigente al momento de la aceptación';

CREATE INDEX IF NOT EXISTS idx_registrations_consent_at
  ON events.registrations (consent_accepted_at)
  WHERE consent_accepted = TRUE;

-- ---------------------------------------------------------------------
-- 3. Opt-out de matchmaking en events.rn_delegates
-- ---------------------------------------------------------------------
-- Derecho de oposición (ARCO - O). Al marcarse TRUE:
--   - el solver no asigna reuniones nuevas a este delegado
--   - las reuniones ya agendadas se cancelan sin notificar PII del titular
-- No es "revocación del consentimiento" (eso borra el registro completo);
-- es oposición al tratamiento específico de matchmaking.
--
ALTER TABLE events.rn_delegates
  ADD COLUMN IF NOT EXISTS opt_out            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS opt_out_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opt_out_reason     VARCHAR(200);

COMMENT ON COLUMN events.rn_delegates.opt_out
  IS 'TRUE si el delegado ejerció derecho de oposición al matchmaking (ARCO-O)';

CREATE INDEX IF NOT EXISTS idx_rn_delegates_optout
  ON events.rn_delegates (registration_id)
  WHERE opt_out = TRUE;

-- =====================================================================
-- Fin migración 20261023_1800__consent_audit_trail
-- =====================================================================
