// Migration: Creative Intelligence module
// Run once: node src/migrate-creative.js
// Safe to re-run (IF NOT EXISTS everywhere)

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS product_assets (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type        VARCHAR(20) NOT NULL CHECK (type IN ('logo','product')),
        original_url    TEXT NOT NULL,
        processed_url   TEXT,
        status      VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','done','error')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS creative_pieces (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        asset_id    INTEGER REFERENCES product_assets(id) ON DELETE SET NULL,
        title       TEXT NOT NULL,
        copy_headline   TEXT,
        copy_body       TEXT,
        cta_type    VARCHAR(30) CHECK (cta_type IN ('none','url','qr_voucher')),
        campaign_id INTEGER,
        resolution  VARCHAR(20) DEFAULT '1920x1080',
        output_url  TEXT,
        status      VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','rendering','ready','error')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS promo_campaigns (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        description     TEXT,
        discount_label  TEXT NOT NULL,
        brand_name      TEXT,
        brand_logo_url  TEXT,
        qr_color        VARCHAR(7) NOT NULL DEFAULT '#000000',
        total_codes     INTEGER NOT NULL DEFAULT 50,
        redeemed_count  INTEGER NOT NULL DEFAULT 0,
        expires_at      TIMESTAMPTZ,
        status          VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','paused','expired')),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE creative_pieces
        ADD CONSTRAINT fk_cp_campaign
        FOREIGN KEY (campaign_id) REFERENCES promo_campaigns(id) ON DELETE SET NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS promo_redemptions (
        id              SERIAL PRIMARY KEY,
        campaign_id     INTEGER NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
        code            VARCHAR(12) NOT NULL UNIQUE,
        status          VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','redeemed')),
        redeemed_at     TIMESTAMPTZ,
        redeemed_by     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_redemptions_code ON promo_redemptions(code)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_redemptions_campaign ON promo_redemptions(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_product_assets_user ON product_assets(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_creative_pieces_user ON creative_pieces(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_promo_campaigns_user ON promo_campaigns(user_id)`);

    await client.query('COMMIT');
    console.log('Migration creative intelligence: OK');
  } catch (err) {
    await client.query('ROLLBACK');
    // FK already exists is fine
    if (err.code === '42710' || err.message.includes('already exists')) {
      console.log('Migration: constraint already exists, skipping.');
    } else {
      console.error('Migration error:', err.message);
      process.exit(1);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run();
