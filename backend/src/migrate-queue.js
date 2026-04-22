/**
 * ============================================================
 * SONORO QUEUE — Migración completa de BD
 * Archivo: migrate-queue.js
 * Uso: node migrate-queue.js
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
    console.log('🔄 Iniciando migración SONORO Queue...\n');
    await client.query('BEGIN');

    // ── 1. EXTENSIONES ──────────────────────────────────────
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    console.log('✅ Extensión uuid-ossp habilitada');

    // ── 2. BRANCHES (Sucursales) ─────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name                  VARCHAR(255) NOT NULL,
        address               VARCHAR(500),
        city                  VARCHAR(100),
        phone                 VARCHAR(50),
        timezone              VARCHAR(50) DEFAULT 'America/Bogota',
        queue_enabled         BOOLEAN DEFAULT true,
        appointments_enabled  BOOLEAN DEFAULT false,
        open_time             TIME DEFAULT '08:00:00',
        close_time            TIME DEFAULT '18:00:00',
        token_reset_hour      TIME DEFAULT '00:00:00',
        max_daily_tokens      INTEGER DEFAULT 9999,
        display_playlist_id   INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
        welcome_message       VARCHAR(500) DEFAULT 'Bienvenido, por favor tome un turno',
        active                BOOLEAN DEFAULT true,
        created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabla branches creada');

    // ── 3. SERVICES (Servicios/Tipos de turno) ───────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS services (
        id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        branch_id         UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        name              VARCHAR(255) NOT NULL,
        description       VARCHAR(500),
        prefix            VARCHAR(5) NOT NULL,
        color             VARCHAR(7) DEFAULT '#FF1B8D',
        icon              VARCHAR(50) DEFAULT 'ticket',
        priority_level    INTEGER DEFAULT 0,
        avg_attention_min INTEGER DEFAULT 10,
        max_queue_size    INTEGER DEFAULT 999,
        active            BOOLEAN DEFAULT true,
        created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(branch_id, prefix)
      )
    `);
    console.log('✅ Tabla services creada');

    // ── 4. COUNTERS (Ventanillas/Módulos) ────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS counters (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        branch_id     UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        name          VARCHAR(100) NOT NULL,
        display_name  VARCHAR(100),
        description   VARCHAR(255),
        active        BOOLEAN DEFAULT true,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabla counters creada');

    // ── 5. COUNTER_SERVICES (Qué servicios atiende cada ventanilla) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS counter_services (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        counter_id  UUID NOT NULL REFERENCES counters(id) ON DELETE CASCADE,
        service_id  UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(counter_id, service_id)
      )
    `);
    console.log('✅ Tabla counter_services creada');

    // ── 6. AGENTS (Agentes de atención) ──────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        branch_id   UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        name        VARCHAR(255) NOT NULL,
        pin         VARCHAR(72),
        avatar_color VARCHAR(7) DEFAULT '#00f5d4',
        active      BOOLEAN DEFAULT true,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabla agents creada');

    // ── 7. AGENT_SESSIONS (Sesiones de trabajo) ──────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        counter_id       UUID NOT NULL REFERENCES counters(id) ON DELETE CASCADE,
        branch_id        UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        started_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at         TIMESTAMP,
        tokens_attended  INTEGER DEFAULT 0,
        tokens_no_show   INTEGER DEFAULT 0,
        tokens_transferred INTEGER DEFAULT 0,
        avg_attention_min NUMERIC(5,2),
        avg_rating        NUMERIC(3,2),
        active            BOOLEAN DEFAULT true
      )
    `);
    console.log('✅ Tabla agent_sessions creada');

    // ── 8. AGENT_BREAKS (Pausas del agente) ──────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_breaks (
        id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        agent_session_id  UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        started_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at          TIMESTAMP,
        reason            VARCHAR(50) DEFAULT 'otro',
        duration_minutes  INTEGER
      )
    `);
    console.log('✅ Tabla agent_breaks creada');

    // ── 9. APPOINTMENTS (Citas previas) ──────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        branch_id       UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        service_id      UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        client_name     VARCHAR(255) NOT NULL,
        client_phone    VARCHAR(50),
        client_email    VARCHAR(255),
        client_id_number VARCHAR(50),
        scheduled_at    TIMESTAMP NOT NULL,
        status          VARCHAR(20) DEFAULT 'pending',
        qr_code         VARCHAR(100) UNIQUE,
        token_id        UUID,
        notes           VARCHAR(500),
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabla appointments creada');

    // ── 10. QUEUE_TOKENS (Turnos) ─────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS queue_tokens (
        id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        branch_id         UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        service_id        UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        counter_id        UUID REFERENCES counters(id) ON DELETE SET NULL,
        agent_id          UUID REFERENCES agents(id) ON DELETE SET NULL,
        agent_session_id  UUID REFERENCES agent_sessions(id) ON DELETE SET NULL,
        appointment_id    UUID REFERENCES appointments(id) ON DELETE SET NULL,
        token_number      VARCHAR(20) NOT NULL,
        display_number    VARCHAR(20) NOT NULL,
        status            VARCHAR(20) DEFAULT 'waiting',
        is_priority       BOOLEAN DEFAULT false,
        is_appointment    BOOLEAN DEFAULT false,
        channel           VARCHAR(20) DEFAULT 'kiosk',
        client_name       VARCHAR(255),
        client_phone      VARCHAR(50),
        created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        called_at         TIMESTAMP,
        attended_at       TIMESTAMP,
        finished_at       TIMESTAMP,
        wait_minutes      INTEGER,
        attention_minutes INTEGER,
        date_key          DATE DEFAULT CURRENT_DATE
      )
    `);
    console.log('✅ Tabla queue_tokens creada');

    // Agregar FK de appointments.token_id
    await client.query(`
      ALTER TABLE appointments
      ADD CONSTRAINT fk_appointment_token
      FOREIGN KEY (token_id) REFERENCES queue_tokens(id) ON DELETE SET NULL
    `);

    // ── 11. TOKEN_EVENTS (Historial de eventos por turno) ─────
    await client.query(`
      CREATE TABLE IF NOT EXISTS token_events (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        token_id         UUID NOT NULL REFERENCES queue_tokens(id) ON DELETE CASCADE,
        event_type       VARCHAR(30) NOT NULL,
        agent_id         UUID REFERENCES agents(id) ON DELETE SET NULL,
        from_counter_id  UUID REFERENCES counters(id) ON DELETE SET NULL,
        to_counter_id    UUID REFERENCES counters(id) ON DELETE SET NULL,
        note             VARCHAR(500),
        metadata         JSONB,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabla token_events creada');

    // ── 12. RATINGS (Calificaciones) ─────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ratings (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        token_id    UUID NOT NULL REFERENCES queue_tokens(id) ON DELETE CASCADE,
        branch_id   UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        service_id  UUID REFERENCES services(id) ON DELETE SET NULL,
        agent_id    UUID REFERENCES agents(id) ON DELETE SET NULL,
        score       INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
        channel     VARCHAR(20) DEFAULT 'kiosk',
        comment     VARCHAR(500),
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabla ratings creada');

    // ── ÍNDICES ───────────────────────────────────────────────
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_branches_user       ON branches(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_services_branch     ON services(branch_id)`,
      `CREATE INDEX IF NOT EXISTS idx_counters_branch     ON counters(branch_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agents_branch       ON agents(branch_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agents_user         ON agents(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_agent      ON agent_sessions(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_counter    ON agent_sessions(counter_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_active     ON agent_sessions(active)`,
      `CREATE INDEX IF NOT EXISTS idx_breaks_session      ON agent_breaks(agent_session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_branch       ON queue_tokens(branch_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_service      ON queue_tokens(service_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_status       ON queue_tokens(status)`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_date         ON queue_tokens(date_key)`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_agent        ON queue_tokens(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_counter      ON queue_tokens(counter_id)`,
      `CREATE INDEX IF NOT EXISTS idx_token_events_token  ON token_events(token_id)`,
      `CREATE INDEX IF NOT EXISTS idx_token_events_type   ON token_events(event_type)`,
      `CREATE INDEX IF NOT EXISTS idx_ratings_token       ON ratings(token_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ratings_agent       ON ratings(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ratings_branch      ON ratings(branch_id)`,
      `CREATE INDEX IF NOT EXISTS idx_appointments_branch ON appointments(branch_id)`,
      `CREATE INDEX IF NOT EXISTS idx_appointments_date   ON appointments(scheduled_at)`,
      `CREATE INDEX IF NOT EXISTS idx_appointments_qr     ON appointments(qr_code)`,
    ];

    for (const idx of indexes) {
      await client.query(idx);
    }
    console.log('✅ Índices creados');

    // ── AGREGAR COLUMNA queue_module A users ──────────────────
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS queue_enabled BOOLEAN DEFAULT false
    `);
    console.log('✅ Campo queue_enabled agregado a users');

    await client.query('COMMIT');
    console.log('\n✅ Migración SONORO Queue completada exitosamente');
    console.log('\nTablas creadas:');
    console.log('  branches, services, counters, counter_services');
    console.log('  agents, agent_sessions, agent_breaks');
    console.log('  appointments, queue_tokens, token_events, ratings');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Error en migración:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => { console.error(err); process.exit(1); });
