require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');
const pool = new Pool({
  user: process.env.DB_USER, host: process.env.DB_HOST,
  database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT
});
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500)`);
    console.log('✅ Campo logo_url agregado a users');
    await client.query('COMMIT');
    console.log('✅ Migración completada');
  } catch(err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
