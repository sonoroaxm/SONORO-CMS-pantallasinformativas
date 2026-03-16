/**
 * ============================================================
 * SONORO AV — Migración: Activation Codes + Device Ownership
 * Archivo: migrate-activation.js
 * Uso: node migrate-activation.js
 * ============================================================
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  user:     process.env.DB_USER     || 'postgres',
  host:     process.env.DB_HOST     || 'localhost',
  database: process.env.DB_NAME     || 'cms_signage',
  password: process.env.DB_PASSWORD || 'postgres123',
  port:     process.env.DB_PORT     || 5432,
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Iniciando migración...\n');
    await client.query('BEGIN');

    // 1. Agregar user_id a devices (si no existe) — tipo INTEGER igual que users.id
    await client.query(`
      ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);
    console.log('✅ Campo user_id agregado a devices');

    // 2. Crear tabla activation_codes
    await client.query(`
      CREATE TABLE IF NOT EXISTS activation_codes (
        id          SERIAL PRIMARY KEY,
        code        VARCHAR(20) UNIQUE NOT NULL,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_name VARCHAR(255),
        used        BOOLEAN DEFAULT false,
        device_id   VARCHAR(255),
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at  TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
        used_at     TIMESTAMP
      )
    `);
    console.log('✅ Tabla activation_codes creada');

    // 3. Índices
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_activation_codes_code    ON activation_codes(code);
      CREATE INDEX IF NOT EXISTS idx_activation_codes_user    ON activation_codes(user_id);
      CREATE INDEX IF NOT EXISTS idx_devices_user             ON devices(user_id);
    `);
    console.log('✅ Índices creados');

    await client.query('COMMIT');
    console.log('\n✅ Migración completada exitosamente');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error en migración:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => { console.error(err); process.exit(1); });
