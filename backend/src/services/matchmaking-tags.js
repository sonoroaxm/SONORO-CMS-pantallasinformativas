// Rueda de Negocios v1 — Helpers para catálogo de tags (B.0 taxonomía)
// Framework: docs/ADR-RN-001-taxonomia-matching.md §2.3-§2.4
// Scope: normalización de slug + parsing xlsx/csv bulk + diffing contra catálogo existente

'use strict';

const XLSX = require('xlsx');

const SIMILARITY_THRESHOLD = 0.5;  // ADR §2.3 Fuzzy warning (empírico pg_trgm español)
const MAX_LABEL_LEN = 100;
const MAX_SLUG_LEN  = 60;

function normalizeTagSlug(label) {
  return String(label || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN);
}

function cleanLabel(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LEN);
}

function parseBulkBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.find(n => /tags|catalogo|catálogo/i.test(n)) || wb.SheetNames[0];
  if (!sheetName) throw new Error('Archivo sin hojas');
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (rows.length === 0) return [];

  const header = rows[0].map(h => String(h || '').trim().toLowerCase());
  const colLabel    = header.findIndex(h => h === 'label' || h === 'nombre' || h === 'tag');
  const colCategory = header.findIndex(h => h === 'category' || h === 'categoria' || h === 'categoría');

  if (colLabel < 0) throw new Error('Columna "label" obligatoria no encontrada');

  return rows.slice(1).map((r, i) => ({
    rowNumber: i + 2,  // +1 header, +1 1-indexed
    rawLabel:  r[colLabel],
    rawCategory: colCategory >= 0 ? r[colCategory] : '',
  }));
}

async function buildBulkPreview(client, userId, parsedRows) {
  const preview = {
    detected:   parsedRows.length,
    new:        0,
    duplicates: [],
    similar:    [],
    invalid:    [],
    rows:       [],  // echo back cleaned rows for confirm step
  };

  const seenSlugs = new Set();

  for (const r of parsedRows) {
    const label = cleanLabel(r.rawLabel);
    if (!label) {
      preview.invalid.push({ row: r.rowNumber, reason: 'label vacío' });
      continue;
    }
    const slug = normalizeTagSlug(label);
    if (!slug) {
      preview.invalid.push({ row: r.rowNumber, reason: 'slug vacío tras normalización' });
      continue;
    }
    if (seenSlugs.has(slug)) {
      preview.invalid.push({ row: r.rowNumber, reason: 'duplicado dentro del archivo' });
      continue;
    }
    seenSlugs.add(slug);

    const category = cleanLabel(r.rawCategory) || null;

    const dup = await client.query(
      `SELECT slug, label FROM events.rn_tags WHERE user_id = $1 AND slug = $2 LIMIT 1`,
      [userId, slug]
    );
    if (dup.rowCount > 0) {
      preview.duplicates.push({ row: r.rowNumber, label, existing_slug: dup.rows[0].slug });
      preview.rows.push({ row: r.rowNumber, label, slug, category, status: 'duplicate', existing_slug: dup.rows[0].slug });
      continue;
    }

    const sim = await client.query(
      `SELECT slug, label, similarity(label, $2) AS score
         FROM events.rn_tags
        WHERE user_id = $1 AND similarity(label, $2) >= $3
        ORDER BY score DESC
        LIMIT 3`,
      [userId, label, SIMILARITY_THRESHOLD]
    );
    if (sim.rowCount > 0) {
      preview.similar.push({
        row: r.rowNumber,
        label,
        candidates: sim.rows.map(c => ({ slug: c.slug, label: c.label, score: Number(c.score.toFixed(2)) })),
      });
      preview.rows.push({ row: r.rowNumber, label, slug, category, status: 'similar', candidates: sim.rows.map(c => c.slug) });
      continue;
    }

    preview.new += 1;
    preview.rows.push({ row: r.rowNumber, label, slug, category, status: 'new' });
  }

  return preview;
}

/**
 * Persist bulk tags inside a transaction.
 * body.rows: [{ label, category, hint, action: 'create'|'merge'|'skip', merge_into_slug? }]
 */
async function persistBulkRows(client, userId, rows) {
  let created = 0, merged = 0, skipped = 0;
  for (const row of (rows || [])) {
    const action = String(row.action || '').toLowerCase();
    if (action === 'skip') { skipped += 1; continue; }
    if (action === 'merge') { merged += 1; continue; }
    if (action !== 'create') { skipped += 1; continue; }

    const label = cleanLabel(row.label);
    if (!label) { skipped += 1; continue; }
    const slug = normalizeTagSlug(label);
    if (!slug) { skipped += 1; continue; }
    const category = cleanLabel(row.category) || null;

    try {
      await client.query(
        `INSERT INTO events.rn_tags (user_id, slug, label, category)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, slug) DO NOTHING`,
        [userId, slug, label, category]
      );
      created += 1;
    } catch (e) {
      if (e.code === '23505') { skipped += 1; continue; }
      throw e;
    }
  }
  return { created, merged, skipped };
}

function buildExportBuffer(tagRows) {
  const data = [['label', 'category']];
  for (const t of tagRows) data.push([t.label, t.category || '']);
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'tags');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function buildTemplateBuffer() {
  const data = [
    ['label', 'category'],
    ['Logística refrigerada', 'Logística'],
    ['Software a la medida',  'Tecnología'],
    ['Distribuidor en Perú',  'Comercial'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'tags');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  normalizeTagSlug,
  cleanLabel,
  parseBulkBuffer,
  buildBulkPreview,
  persistBulkRows,
  buildExportBuffer,
  buildTemplateBuffer,
  SIMILARITY_THRESHOLD,
};
