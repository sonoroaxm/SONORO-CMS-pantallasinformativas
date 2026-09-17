-- Migration 018 — Geo normalizado para Multi-sede (Fase 2)
-- Fecha: 2026-09-17 · Sesión: S207
-- Scope: aditivo puro. locations.city/country legacy conservados.
-- La nueva fuente de verdad para signage sedes es locations.city_id.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS geo_countries (
  code CHAR(2) PRIMARY KEY,               -- ISO 3166-1 alpha-2 (CO, MX, US, BR...)
  name_es TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_pt TEXT NOT NULL,
  state_label_es TEXT NOT NULL,           -- 'Departamento' / 'Estado' / 'Provincia'
  state_label_en TEXT NOT NULL,
  state_label_pt TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS geo_states (
  id SERIAL PRIMARY KEY,
  country_code CHAR(2) NOT NULL REFERENCES geo_countries(code) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  UNIQUE(country_code, name)
);
CREATE INDEX IF NOT EXISTS idx_geo_states_country ON geo_states(country_code);

CREATE TABLE IF NOT EXISTS geo_cities (
  id SERIAL PRIMARY KEY,
  state_id INTEGER NOT NULL REFERENCES geo_states(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  UNIQUE(state_id, name)
);
CREATE INDEX IF NOT EXISTS idx_geo_cities_state ON geo_cities(state_id);
CREATE INDEX IF NOT EXISTS idx_geo_cities_name_trgm ON geo_cities USING gin (name gin_trgm_ops);

-- locations.city_id: FK a la nueva fuente de verdad (nullable — legacy sigue vivo).
ALTER TABLE locations ADD COLUMN IF NOT EXISTS city_id INTEGER REFERENCES geo_cities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_locations_city_id ON locations(city_id);

COMMIT;
