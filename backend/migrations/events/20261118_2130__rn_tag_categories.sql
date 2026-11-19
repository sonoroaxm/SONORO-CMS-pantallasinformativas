-- Migration: rn_tag_categories (Deuda S217j #5b)
-- Fecha: 2026-11-18
-- Scope: catálogo trilingüe de categorías para i18n de pills en TagPickerV2.
-- Hoy events.rn_tags.category es texto libre inconsistente (ej. "Turismo" "MICE"
-- proper case vs "financiero" "rrhh" lowercase legacy). Esta tabla normaliza.
-- Forward-only. Rollback: DROP TABLE events.rn_tag_categories;

SET search_path TO events, public;

CREATE TABLE IF NOT EXISTS events.rn_tag_categories (
  slug         VARCHAR(60) PRIMARY KEY,
  label_es     VARCHAR(100) NOT NULL,
  label_en     VARCHAR(100),
  label_pt     VARCHAR(100),
  rueda_type   VARCHAR(20) CHECK (rueda_type IN ('negocios','empleo','both'))
               NOT NULL DEFAULT 'both',
  display_order INTEGER DEFAULT 100,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Seed con categorías del catálogo v1.3 (S217i) + legacy normalizadas.
-- Scope 'both' por defecto; tras feedback humano §3 ajustar manualmente.
INSERT INTO events.rn_tag_categories (slug, label_es, label_en, label_pt, rueda_type, display_order) VALUES
  ('turismo',       'Turismo',                 'Tourism',               'Turismo',                'negocios', 10),
  ('mice',          'MICE',                    'MICE',                  'MICE',                   'negocios', 20),
  ('bodas',         'Bodas',                   'Weddings',              'Casamentos',             'negocios', 30),
  ('cultural',      'Industrias Culturales',   'Cultural Industries',   'Indústrias Culturais',   'negocios', 40),
  ('comex',         'Comex',                   'Foreign Trade',         'Comércio Exterior',      'negocios', 50),
  ('transversal',   'Transversales',           'Cross-cutting',         'Transversais',           'both',     60),
  ('empleo',        'Rueda de Empleo',         'Employment Round',      'Rodada de Emprego',      'empleo',   70),
  -- Legacy slugs (74 tags S217i) — normalizar case
  ('financiero',    'Financiero',              'Finance',               'Financeiro',             'both',     200),
  ('legal',         'Legal',                   'Legal',                 'Jurídico',               'both',     210),
  ('rrhh',          'Recursos Humanos',        'Human Resources',       'Recursos Humanos',       'both',     220),
  ('servicios',     'Servicios',               'Services',              'Serviços',               'both',     230),
  ('tecnologia',    'Tecnología',              'Technology',            'Tecnologia',             'both',     240),
  ('marketing',     'Marketing',               'Marketing',             'Marketing',              'both',     250)
ON CONFLICT (slug) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_rn_tag_categories_rueda_type
  ON events.rn_tag_categories (rueda_type, display_order);

COMMENT ON TABLE events.rn_tag_categories IS
  'Deuda S217j #5b — catálogo trilingüe de categorías para i18n de pills TagPickerV2. Backend wiring en events-rn-public.js GET /:slug/tags (Phase 2 S217k+).';
