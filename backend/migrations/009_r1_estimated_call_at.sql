-- ============================================================
-- SONORO Queue v2 — R1 · Migración 009
-- Archivo: 009_r1_estimated_call_at.sql
-- Objetivo: Añadir estimated_call_at a queue_tokens para
--   sincronizar walk-ins con el cronograma de citas del día.
--   El valor se calcula en POST /api/queue/token buscando el
--   primer slot libre >= NOW() sin colisión con citas o
--   walk-ins previos (slotMs = slot_duration_minutes || avg_attention_min || 30 min).
-- Sesión 79 — 2026-06-03
-- ============================================================

ALTER TABLE queue_tokens
  ADD COLUMN IF NOT EXISTS estimated_call_at TIMESTAMPTZ;
