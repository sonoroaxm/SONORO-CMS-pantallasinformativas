-- ============================================================
-- SONORO Queue v2 — R1 · Migración 007
-- Archivo: 007_r1_kiosk_token.sql
-- Objetivo: ALTER branches → añadir kiosk_token UUID UNIQUE NOT NULL.
-- Pre-cond: ejecutar después de 002/003/004/005/006.
-- ============================================================
-- Origen de la decisión (sesión 66):
--   El endpoint kiosko §2.6 (POST /api/queue/appointments/confirm-presence
--   con header X-Branch-Token) requiere un secreto por-sucursal para
--   autenticar la tablet/pantalla del kiosko sin exponer credenciales
--   de admin. Decisión D1 firmada: usar UUID nativo (gen_random_uuid()
--   disponible en PG ≥13 sin pgcrypto — verificado SSH 02/06).
--
--   Casos de uso:
--     - Kiosko llama POST /confirm-presence con header X-Branch-Token=<uuid>
--     - Middleware resuelve branch + valida horario apertura
--     - Anti-enumeración: 401 solo si el token NO está en branches.kiosk_token
--     - Rotación vía POST /api/queue/branches/:id/kiosk-token/rotate (admin)
-- ============================================================
-- Estrategia ADD-only:
--   gen_random_uuid() es VOLATIL → en PG ≥11, ADD COLUMN con
--   DEFAULT volátil EJECUTA el default por cada fila existente
--   (cada branch recibe UUID distinto). Comportamiento garantizado.
--   No necesitamos UPDATE manual posterior.
-- ============================================================
-- Idempotencia:
--   - ADD COLUMN IF NOT EXISTS
--   - UNIQUE constraint añadido vía DO $$ con pg_constraint EXISTS
-- ============================================================

BEGIN;

\echo '== R1 · 007 · Verificando disponibilidad de gen_random_uuid() =='

DO $$
BEGIN
  PERFORM gen_random_uuid();
EXCEPTION
  WHEN undefined_function THEN
    RAISE EXCEPTION
      'gen_random_uuid() no disponible — requiere PG ≥13 o extensión pgcrypto. '
      'PG productivo verificado 02/06: 17.10 — esto NO debería fallar.';
END $$;

\echo '== R1 · 007 · Añadiendo columna kiosk_token a branches =='

-- ADD COLUMN con DEFAULT volátil + NOT NULL.
-- PG ejecuta gen_random_uuid() por cada fila existente → UUID único por branch.
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS kiosk_token UUID NOT NULL DEFAULT gen_random_uuid();

\echo '== R1 · 007 · Asegurando UNIQUE constraint (idempotente) =='

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'branches_kiosk_token_uniq'
  ) THEN
    ALTER TABLE branches
      ADD CONSTRAINT branches_kiosk_token_uniq UNIQUE (kiosk_token);
    RAISE NOTICE 'UNIQUE constraint branches_kiosk_token_uniq creado';
  ELSE
    RAISE NOTICE 'UNIQUE constraint branches_kiosk_token_uniq ya existía — skip';
  END IF;
END $$;

\echo '== R1 · 007 · Verificación post-migración =='

SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'branches' AND column_name = 'kiosk_token') AS column_present,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conname = 'branches_kiosk_token_uniq') AS unique_present,
  (SELECT COUNT(*) FROM branches WHERE kiosk_token IS NULL) AS branches_without_token,
  (SELECT COUNT(DISTINCT kiosk_token) FROM branches) AS distinct_tokens,
  (SELECT COUNT(*) FROM branches) AS total_branches;

-- Esperado:
--   column_present=1, unique_present=1, branches_without_token=0,
--   distinct_tokens = total_branches (todos UUID distintos por DEFAULT volátil).

COMMIT;

\echo '== R1 · 007 · Migración completada =='
