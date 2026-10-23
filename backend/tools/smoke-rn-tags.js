// Smoke B.0 taxonomía — helpers matchmaking-tags.js + migración pg_trgm.
// No invoca HTTP ni levanta server; prueba el pipeline directo contra Postgres.
'use strict';

process.env.JWT_SECRET = 'smoke-rn-tags';
process.env.SMTP_HOST  = '';

const { Pool } = require('pg');
const tagsSvc = require('../src/services/matchmaking-tags');

const pool = new Pool({
  host: 'localhost', port: 5433, database: 'cms_signage_rntest',
  user: 'postgres', password: 'smarttv_dev', max: 5,
});
global.pool = pool;

const USER_ID = 1;

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else      { fail++; console.log(`  ❌ ${label}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function cleanTags(client) {
  await client.query(`DELETE FROM events.rn_registration_tags WHERE tag_id IN (SELECT id FROM events.rn_tags WHERE user_id = $1)`, [USER_ID]);
  await client.query(`DELETE FROM events.rn_tags WHERE user_id = $1`, [USER_ID]);
}

async function main() {
  const client = await pool.connect();
  try {
    console.log('▶ Setup: limpia catálogo del user_id', USER_ID);
    await cleanTags(client);

    console.log('\n▶ Test 1: normalizeTagSlug es idempotente y seguro');
    ok('acentos → ascii', tagsSvc.normalizeTagSlug('Logística Refrigerada') === 'logistica-refrigerada');
    ok('espacios múltiples', tagsSvc.normalizeTagSlug('  Café  Premium  ') === 'cafe-premium');
    ok('simbolos', tagsSvc.normalizeTagSlug('C/C++ & Rust!') === 'c-c-rust');
    ok('vacío → vacío', tagsSvc.normalizeTagSlug('') === '');
    ok('idempotente', tagsSvc.normalizeTagSlug(tagsSvc.normalizeTagSlug('Software a la medida')) === 'software-a-la-medida');
    ok('clip 60', tagsSvc.normalizeTagSlug('a'.repeat(200)).length === 60);

    console.log('\n▶ Test 2: seed inicial 3 tags vía persistBulkRows');
    const seed = [
      { label: 'Logística Refrigerada', category: 'Logística',   action: 'create' },
      { label: 'Software a la medida',  category: 'Tecnología',  action: 'create' },
      { label: 'Distribuidor en Perú',  category: 'Comercial',   action: 'create' },
    ];
    const r1 = await tagsSvc.persistBulkRows(client, USER_ID, seed);
    ok('3 creados', r1.created === 3, r1);

    console.log('\n▶ Test 4: buildBulkPreview detecta duplicates + similar + new + invalid');
    const parsed = [
      { rowNumber: 2, rawLabel: 'Logística refrigerada', rawCategory: 'X', rawHint: 'both' },  // dup
      { rowNumber: 3, rawLabel: 'software a la medida',   rawCategory: '',  rawHint: 'offer' }, // dup normalizado
      { rowNumber: 4, rawLabel: 'Software hecho a medida', rawCategory: 'Tech', rawHint: 'offer' }, // similar
      { rowNumber: 5, rawLabel: 'Café orgánico premium',  rawCategory: 'Agro', rawHint: 'both' },  // new
      { rowNumber: 6, rawLabel: '',                       rawCategory: '',  rawHint: '' },  // invalid
      { rowNumber: 7, rawLabel: '   ',                    rawCategory: '',  rawHint: '' },  // invalid
    ];
    const preview = await tagsSvc.buildBulkPreview(client, USER_ID, parsed);
    ok('detected = 6', preview.detected === 6, preview);
    ok('≥2 duplicates (dup + dup normalizado)', preview.duplicates.length >= 2, preview.duplicates);
    ok('≥1 similar (fuzzy)', preview.similar.length >= 1, preview.similar);
    ok('new >= 1 (café)', preview.new >= 1, preview);
    ok('invalid >= 2 (vacíos)', preview.invalid.length >= 2, preview.invalid);

    console.log('\n▶ Test 5: confirm persiste sólo acciones "create"');
    const confirmRows = [
      { label: 'Café orgánico premium', category: 'Agro', action: 'create' },
      { label: 'software a la medida',  action: 'merge', merge_into_slug: 'software-a-la-medida' },
      { label: '',                      action: 'skip' },
    ];
    const r2 = await tagsSvc.persistBulkRows(client, USER_ID, confirmRows);
    ok('1 create', r2.created === 1, r2);
    ok('1 merge', r2.merged === 1, r2);
    ok('1 skip', r2.skipped === 1, r2);

    const count = await client.query(`SELECT COUNT(*)::int AS n FROM events.rn_tags WHERE user_id = $1`, [USER_ID]);
    ok('catálogo = 4 (3 seed + 1 nuevo)', count.rows[0].n === 4, count.rows[0]);

    console.log('\n▶ Test 6: fuzzy pg_trgm similarity funciona');
    const sim = await client.query(
      `SELECT slug, similarity(label, $2) AS score
         FROM events.rn_tags
        WHERE user_id = $1 AND similarity(label, $2) >= 0.3
        ORDER BY score DESC LIMIT 3`,
      [USER_ID, 'logistica refrigerad']
    );
    ok('fuzzy match encontró logistica-refrigerada', sim.rows.some(r => r.slug === 'logistica-refrigerada'), sim.rows);

    console.log('\n▶ Test 7: parseBulkBuffer lee template + import roundtrip');
    const tmpl = tagsSvc.buildTemplateBuffer();
    const parsedTmpl = tagsSvc.parseBulkBuffer(tmpl);
    ok('template parsea 3 filas', parsedTmpl.length === 3, parsedTmpl.length);
    ok('template fila 1 label', String(parsedTmpl[0].rawLabel).includes('Logística'), parsedTmpl[0]);

    const exportBuf = tagsSvc.buildExportBuffer([
      { label: 'Logística Refrigerada', category: 'Logística' },
      { label: 'Café orgánico premium',  category: 'Agro'      },
    ]);
    const parsedExport = tagsSvc.parseBulkBuffer(exportBuf);
    ok('export parsea 2 filas', parsedExport.length === 2, parsedExport.length);

    console.log('\n▶ Test 8: re-import mismo xlsx → 0 nuevos, N duplicados');
    const parsed2 = tagsSvc.parseBulkBuffer(exportBuf);
    const prev2 = await tagsSvc.buildBulkPreview(client, USER_ID, parsed2);
    ok('new = 0 en re-import', prev2.new === 0, prev2);
    ok('duplicates = 2 en re-import', prev2.duplicates.length === 2, prev2.duplicates);

    console.log('\n▶ Cleanup');
    await cleanTags(client);

    console.log(`\n========================================`);
    console.log(`SMOKE B.0 taxonomía: ${pass} OK · ${fail} FAIL`);
    console.log(`========================================`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (err) {
    console.error('💥', err);
    process.exit(2);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
