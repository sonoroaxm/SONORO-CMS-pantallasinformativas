require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'cms_signage',
  password: process.env.DB_PASSWORD || 'postgres123',
  port: process.env.DB_PORT || 5432,
});
async function check() {
  const r = await pool.query(`
    SELECT table_name, column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name IN ('users','devices') AND column_name = 'id'
    ORDER BY table_name
  `);
  console.log(r.rows);
  await pool.end();
}
check().catch(console.error);
