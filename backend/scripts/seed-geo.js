#!/usr/bin/env node
// scripts/seed-geo.js — Seed idempotente geo_countries/states/cities.
// Scope Fase 2: Américas (USA + CA + LATAM incl. Brasil) + PT + ES.
// Fuente: paquete devDep country-state-city (~150k ciudades globales, filtro por ISO code).
// i18n names ES/EN/PT curados a mano. state_label por país.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Country, State, City } = require('country-state-city');
const { Pool } = require('pg');

const pool = new Pool({
  user:     process.env.DB_USER     || 'postgres',
  host:     process.env.DB_HOST     || 'localhost',
  database: process.env.DB_NAME     || 'cms_signage',
  password: process.env.DB_PASSWORD,
  port:     process.env.DB_PORT     || 5432,
});

// -----------------------------------------------------------------------------
// Scope + i18n catálogo curado
// -----------------------------------------------------------------------------
// [code, name_es, name_en, name_pt, state_label_es, state_label_en, state_label_pt, sort_order]
// sort_order: menor = arriba. Colombia primero (país base), luego LATAM alfabético,
// luego USA/CA, luego Iberia.
const COUNTRIES = [
  ['CO', 'Colombia',            'Colombia',           'Colômbia',              'Departamento', 'Department', 'Departamento', 10],
  ['AR', 'Argentina',           'Argentina',          'Argentina',             'Provincia',    'Province',   'Província',    20],
  ['BO', 'Bolivia',              'Bolivia',            'Bolívia',               'Departamento', 'Department', 'Departamento', 20],
  ['BR', 'Brasil',               'Brazil',             'Brasil',                'Estado',       'State',      'Estado',       20],
  ['CL', 'Chile',                'Chile',              'Chile',                 'Región',       'Region',     'Região',       20],
  ['CR', 'Costa Rica',           'Costa Rica',         'Costa Rica',            'Provincia',    'Province',   'Província',    20],
  ['CU', 'Cuba',                 'Cuba',               'Cuba',                  'Provincia',    'Province',   'Província',    20],
  ['DO', 'República Dominicana', 'Dominican Republic', 'República Dominicana',  'Provincia',    'Province',   'Província',    20],
  ['EC', 'Ecuador',              'Ecuador',            'Equador',               'Provincia',    'Province',   'Província',    20],
  ['SV', 'El Salvador',          'El Salvador',        'El Salvador',           'Departamento', 'Department', 'Departamento', 20],
  ['GT', 'Guatemala',            'Guatemala',          'Guatemala',             'Departamento', 'Department', 'Departamento', 20],
  ['HT', 'Haití',                'Haiti',              'Haiti',                 'Departamento', 'Department', 'Departamento', 20],
  ['HN', 'Honduras',             'Honduras',           'Honduras',              'Departamento', 'Department', 'Departamento', 20],
  ['MX', 'México',               'Mexico',             'México',                'Estado',       'State',      'Estado',       20],
  ['NI', 'Nicaragua',            'Nicaragua',          'Nicarágua',             'Departamento', 'Department', 'Departamento', 20],
  ['PA', 'Panamá',               'Panama',             'Panamá',                'Provincia',    'Province',   'Província',    20],
  ['PY', 'Paraguay',             'Paraguay',           'Paraguai',              'Departamento', 'Department', 'Departamento', 20],
  ['PE', 'Perú',                 'Peru',               'Peru',                  'Departamento', 'Department', 'Departamento', 20],
  ['PR', 'Puerto Rico',          'Puerto Rico',        'Porto Rico',            'Municipio',    'Municipality','Município',   20],
  ['UY', 'Uruguay',              'Uruguay',            'Uruguai',               'Departamento', 'Department', 'Departamento', 20],
  ['VE', 'Venezuela',            'Venezuela',          'Venezuela',             'Estado',       'State',      'Estado',       20],
  ['BZ', 'Belice',               'Belize',             'Belize',                'Distrito',     'District',   'Distrito',     30],
  ['BS', 'Bahamas',              'Bahamas',            'Bahamas',               'Distrito',     'District',   'Distrito',     30],
  ['BB', 'Barbados',             'Barbados',           'Barbados',              'Parroquia',    'Parish',     'Paróquia',     30],
  ['JM', 'Jamaica',              'Jamaica',            'Jamaica',               'Parroquia',    'Parish',     'Paróquia',     30],
  ['TT', 'Trinidad y Tobago',    'Trinidad and Tobago','Trinidad e Tobago',     'Región',       'Region',     'Região',       30],
  ['US', 'Estados Unidos',       'United States',      'Estados Unidos',        'Estado',       'State',      'Estado',       40],
  ['CA', 'Canadá',               'Canada',             'Canadá',                'Provincia',    'Province',   'Província',    40],
  ['ES', 'España',               'Spain',              'Espanha',               'Provincia',    'Province',   'Província',    50],
  ['PT', 'Portugal',              'Portugal',            'Portugal',               'Distrito',     'District',   'Distrito',     50],
];

async function seedCountries(client) {
  let inserted = 0;
  for (const [code, name_es, name_en, name_pt, l_es, l_en, l_pt, sort] of COUNTRIES) {
    const r = await client.query(
      `INSERT INTO geo_countries (code, name_es, name_en, name_pt, state_label_es, state_label_en, state_label_pt, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (code) DO UPDATE SET
         name_es=EXCLUDED.name_es, name_en=EXCLUDED.name_en, name_pt=EXCLUDED.name_pt,
         state_label_es=EXCLUDED.state_label_es, state_label_en=EXCLUDED.state_label_en, state_label_pt=EXCLUDED.state_label_pt,
         sort_order=EXCLUDED.sort_order
       RETURNING (xmax = 0) AS inserted`,
      [code, name_es, name_en, name_pt, l_es, l_en, l_pt, sort]
    );
    if (r.rows[0].inserted) inserted++;
  }
  return inserted;
}

async function seedStatesAndCities(client) {
  let statesIns = 0, citiesIns = 0;
  for (const [code] of COUNTRIES) {
    const states = State.getStatesOfCountry(code);
    for (const st of states) {
      const rs = await client.query(
        `INSERT INTO geo_states (country_code, name) VALUES ($1, $2)
         ON CONFLICT (country_code, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, (xmax = 0) AS inserted`,
        [code, st.name]
      );
      const stateId = rs.rows[0].id;
      if (rs.rows[0].inserted) statesIns++;

      const cities = City.getCitiesOfState(code, st.isoCode);
      if (!cities || cities.length === 0) continue;

      // Dedupe por nombre dentro del mismo estado (dataset a veces trae duplicados)
      const seen = new Set();
      const batch = [];
      for (const c of cities) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        batch.push(c.name);
      }
      // Bulk insert por chunk (500 filas)
      const CHUNK = 500;
      for (let i = 0; i < batch.length; i += CHUNK) {
        const slice = batch.slice(i, i + CHUNK);
        const values = slice.map((_, idx) => `($1, $${idx + 2})`).join(', ');
        const params = [stateId, ...slice];
        const rc = await client.query(
          `INSERT INTO geo_cities (state_id, name) VALUES ${values}
           ON CONFLICT (state_id, name) DO NOTHING`,
          params
        );
        citiesIns += rc.rowCount;
      }
    }
    console.log(`  ${code}: ${states.length} states — cities acumuladas ${citiesIns}`);
  }
  return { statesIns, citiesIns };
}

async function main() {
  const client = await pool.connect();
  try {
    console.log('== Seed geo Fase 2 (Américas + PT + ES) ==');
    await client.query('BEGIN');
    const ci = await seedCountries(client);
    console.log(`Países: ${ci} nuevos (upsert total ${COUNTRIES.length}).`);
    const { statesIns, citiesIns } = await seedStatesAndCities(client);
    console.log(`Estados: ${statesIns} nuevos.`);
    console.log(`Ciudades: ${citiesIns} nuevas.`);
    await client.query('COMMIT');
    console.log('OK · commit');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ERROR — rollback:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
