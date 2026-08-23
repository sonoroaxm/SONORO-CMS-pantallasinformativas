
const { Pool } = require("pg");
require("dotenv").config();
const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "cms_signage",
  password: process.env.DB_PASSWORD || "postgres123",
  port: parseInt(process.env.DB_PORT) || 5432,
});
const sql = "CREATE TABLE IF NOT EXISTS events.supplier_invite_tokens (id SERIAL PRIMARY KEY, token UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE, user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE, event_id INTEGER REFERENCES events.events(id) ON DELETE SET NULL, supplier_id INTEGER REFERENCES events.suppliers(id) ON DELETE SET NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', event_name_cache TEXT, invited_by_name TEXT, expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())";
pool.query(sql).then(() => { console.log('Migration OK'); pool.end(); }).catch(e => { console.error('Error:', e.message); pool.end(); process.exit(1); });
