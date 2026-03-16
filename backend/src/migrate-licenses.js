/**
 * ============================================================
 * SONORO AV — Migración: Sistema de Licencias
 * Archivo: migrate-licenses.js
 * Uso: node migrate-licenses.js
 * ============================================================
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
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
    console.log('🔄 Iniciando migración de licencias...\n');
    await client.query('BEGIN');

    // 1. Agregar campos a users
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'client',
      ADD COLUMN IF NOT EXISTS license_type VARCHAR(20) DEFAULT 'rpi',
      ADD COLUMN IF NOT EXISTS license_status VARCHAR(20) DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS license_start TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS license_end TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 year')
    `);
    console.log('✅ Campos de licencia agregados a users');

    // 2. Crear tabla license_history
    await client.query(`
      CREATE TABLE IF NOT EXISTS license_history (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action      VARCHAR(50) NOT NULL,
        months      INTEGER,
        license_type VARCHAR(20),
        old_end     TIMESTAMP,
        new_end     TIMESTAMP,
        note        TEXT,
        created_by  INTEGER REFERENCES users(id),
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabla license_history creada');

    // 3. Índices
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_license_status ON users(license_status);
      CREATE INDEX IF NOT EXISTS idx_users_license_end    ON users(license_end);
      CREATE INDEX IF NOT EXISTS idx_license_history_user ON license_history(user_id);
    `);
    console.log('✅ Índices creados');

    // 4. Marcar usuarios existentes como admin o client
    // El primer usuario (id más bajo) será admin
    await client.query(`
      UPDATE users SET role = 'admin'
      WHERE id = (SELECT MIN(id) FROM users)
    `);
    console.log('✅ Primer usuario marcado como admin');

    await client.query('COMMIT');
    console.log('\n✅ Migración de licencias completada');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => { console.error(err); process.exit(1); });
