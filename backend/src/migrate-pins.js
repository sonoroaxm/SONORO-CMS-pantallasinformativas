/**
 * Migración one-time: hashea PINs de agentes que están en plaintext.
 * Uso: node migrate-pins.js
 *
 * Detecta plaintext vs bcrypt: los hashes bcrypt empiezan con "$2a$" o "$2b$".
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  user:     process.env.DB_USER     || 'postgres',
  host:     process.env.DB_HOST     || 'localhost',
  database: process.env.DB_NAME     || 'cms_signage',
  password: process.env.DB_PASSWORD || 'postgres123',
  port:     process.env.DB_PORT     || 5432,
});

async function migratePins() {
  const { rows: agents } = await pool.query(
    `SELECT id, name, pin FROM agents WHERE pin IS NOT NULL`
  );

  let migrated = 0;
  let skipped = 0;

  for (const agent of agents) {
    if (agent.pin.startsWith('$2a$') || agent.pin.startsWith('$2b$')) {
      skipped++;
      continue;
    }

    const hashed = await bcrypt.hash(agent.pin, 10);
    await pool.query('UPDATE agents SET pin = $1 WHERE id = $2', [hashed, agent.id]);
    console.log(`  ✅ ${agent.name} — PIN migrado`);
    migrated++;
  }

  console.log(`\n📊 Resultado: ${migrated} migrados, ${skipped} ya hasheados, ${agents.length} total`);
  await pool.end();
}

migratePins().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
