#!/usr/bin/env node
/* ============================================================
 * SONORO Queue v2 — R0 · Test de concurrencia
 * Archivo: backend/test/r0_token_concurrency.js
 *
 * Propósito:
 *   Disparar N peticiones simultáneas a POST /api/queue/token y
 *   verificar que el módulo R0 (withTransaction + advisory lock +
 *   UNIQUE backstop + retry) elimina la race condition: cero
 *   token_number duplicados entre las respuestas exitosas.
 *
 * Uso:
 *   node backend/test/r0_token_concurrency.js \
 *     --url https://cms.sonoro.com.co \
 *     --branch <branch_id_uuid> \
 *     --service <service_id_uuid> \
 *     --concurrency 50 \
 *     --total 200
 *
 * Variables de entorno aceptadas (alternativa a flags):
 *   CMS_URL, BRANCH_ID, SERVICE_ID, CONCURRENCY, TOTAL
 *
 * Salida:
 *   - Histograma de status codes (200/404/429/503/...)
 *   - Lista de token_numbers exitosos
 *   - Duplicados detectados (si los hay) — exit 1
 *   - Exit 0 si no hay duplicados
 *
 * NOTA sobre rate limiting:
 *   playerLimiter aplica 60 req/min por IP. Para una ráfaga
 *   intencional, los 429 son esperables y NO se cuentan como
 *   fallo del test (solo invalidan ese intento). El test sigue
 *   siendo significativo: las respuestas 200 deben ser únicas.
 *
 * NOTA sobre permisos:
 *   POST /api/queue/token es público (sin authenticateToken).
 *   No requiere JWT.
 * ============================================================ */

'use strict';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      opts[key] = val;
    }
  }
  return opts;
}

const opts = parseArgs();
const CMS_URL      = opts.url         || process.env.CMS_URL     || 'http://localhost:3000';
const BRANCH_ID    = opts.branch      || process.env.BRANCH_ID;
const SERVICE_ID   = opts.service     || process.env.SERVICE_ID;
const CONCURRENCY  = parseInt(opts.concurrency || process.env.CONCURRENCY || '50', 10);
const TOTAL        = parseInt(opts.total       || process.env.TOTAL       || '200', 10);
const CHANNEL      = opts.channel     || 'concurrency-test';

if (!BRANCH_ID || !SERVICE_ID) {
  console.error('❌ Faltan --branch <uuid> y --service <uuid> (o BRANCH_ID/SERVICE_ID env)');
  console.error('   Ejemplo: node r0_token_concurrency.js --url https://cms.sonoro.com.co \\');
  console.error('              --branch <uuid> --service <uuid> --concurrency 50 --total 200');
  process.exit(2);
}

const endpoint = `${CMS_URL.replace(/\/+$/, '')}/api/queue/token`;

console.log('== SONORO Queue v2 — R0 · Test de concurrencia ==');
console.log(`  URL:         ${endpoint}`);
console.log(`  branch_id:   ${BRANCH_ID}`);
console.log(`  service_id:  ${SERVICE_ID}`);
console.log(`  concurrency: ${CONCURRENCY}`);
console.log(`  total:       ${TOTAL}`);
console.log(`  channel:     ${CHANNEL}`);
console.log('');

const statusHistogram = new Map();
const successTokens = []; // { token_number, token_id, attempt_index, latency_ms }
const errors = [];        // { attempt_index, status, body }

function recordStatus(status) {
  statusHistogram.set(status, (statusHistogram.get(status) || 0) + 1);
}

async function postOne(index) {
  const t0 = Date.now();
  let status = 0;
  let body = null;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch_id:   BRANCH_ID,
        service_id:  SERVICE_ID,
        is_priority: false,
        channel:     CHANNEL,
        client_name: `test_${index}`,
      }),
    });
    status = res.status;
    try { body = await res.json(); } catch { body = null; }
  } catch (err) {
    status = 0;
    body = { error: 'network', message: String(err && err.message || err) };
  }
  const latency = Date.now() - t0;
  recordStatus(status);
  if (status === 200 && body && body.token_number) {
    successTokens.push({
      token_number: body.token_number,
      token_id:     body.token_id,
      index,
      latency_ms:   latency,
    });
  } else {
    errors.push({ index, status, body, latency_ms: latency });
  }
}

async function runBatch(startIndex, size) {
  const batch = [];
  for (let i = 0; i < size && (startIndex + i) < TOTAL; i++) {
    batch.push(postOne(startIndex + i));
  }
  await Promise.all(batch);
}

(async () => {
  const t0 = Date.now();
  let pending = TOTAL;
  let next = 0;
  while (pending > 0) {
    const batchSize = Math.min(CONCURRENCY, pending);
    await runBatch(next, batchSize);
    next += batchSize;
    pending -= batchSize;
  }
  const elapsedMs = Date.now() - t0;

  // ── Análisis ───────────────────────────────────────────────
  const numbers = successTokens.map(t => t.token_number);
  const seen = new Map();
  const dupes = [];
  for (const n of numbers) {
    seen.set(n, (seen.get(n) || 0) + 1);
  }
  for (const [n, count] of seen.entries()) {
    if (count > 1) dupes.push({ token_number: n, occurrences: count });
  }

  console.log('== Resultados ==');
  console.log(`  Total ejecutados: ${TOTAL}`);
  console.log(`  Tiempo total:     ${elapsedMs} ms`);
  console.log(`  Throughput:       ${(TOTAL / (elapsedMs / 1000)).toFixed(2)} req/s`);
  console.log('');
  console.log('  Histograma status:');
  for (const [code, count] of [...statusHistogram.entries()].sort()) {
    console.log(`    ${code}: ${count}`);
  }
  console.log('');
  console.log(`  Exitos 200:       ${successTokens.length}`);
  console.log(`  No-exitos:        ${errors.length}`);

  if (successTokens.length > 0) {
    const latencies = successTokens.map(t => t.latency_ms).sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || latencies[latencies.length - 1];
    const p99 = latencies[Math.floor(latencies.length * 0.99)] || latencies[latencies.length - 1];
    console.log(`  Latencia ms (p50/p95/p99): ${p50}/${p95}/${p99}`);
  }
  console.log('');

  // Conteo de retries observados — el servidor loggea "retry N" en console pero
  // a nivel cliente no es observable. La señal indirecta es que NO haya 503.
  const exhausted = statusHistogram.get(503) || 0;
  if (exhausted > 0) {
    console.warn(`  ⚠️  ${exhausted} respuestas 503 (retries agotados). Revisar concurrencia o backoff.`);
  }

  if (dupes.length > 0) {
    console.error('❌ FALLO: token_number duplicados detectados:');
    for (const d of dupes) {
      console.error(`   ${d.token_number} → ${d.occurrences} ocurrencias`);
    }
    console.error('');
    console.error('  Race condition NO está mitigada. R0 falla criterios de salida.');
    process.exit(1);
  }

  // Verificación cruzada opcional via DB (no se ejecuta desde aquí — sugerimos):
  console.log('== Verificación recomendada a nivel BD (ejecutar manualmente) ==');
  console.log(`  SELECT branch_id, service_id, date_key, token_number, COUNT(*)`);
  console.log(`  FROM queue_tokens`);
  console.log(`  WHERE branch_id = '${BRANCH_ID}'`);
  console.log(`    AND service_id = '${SERVICE_ID}'`);
  console.log(`    AND date_key = CURRENT_DATE`);
  console.log(`  GROUP BY 1, 2, 3, 4`);
  console.log(`  HAVING COUNT(*) > 1;`);
  console.log('  → debe devolver 0 filas');
  console.log('');
  console.log('✅ OK: cero duplicados a nivel API. R0 cumple criterio principal.');
  process.exit(0);
})().catch(err => {
  console.error('❌ Error inesperado en el harness:', err);
  process.exit(2);
});
