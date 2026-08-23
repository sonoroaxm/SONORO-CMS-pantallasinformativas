-- R4: Outlook event ID en citas + tabla watch channels para webhooks + cron
-- Sesión 94 — 05/06/2026

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS outlook_event_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_appointments_outlook_event
  ON appointments (outlook_event_id)
  WHERE outlook_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS calendar_watch_channels (
  id            SERIAL PRIMARY KEY,
  agent_id      UUID          NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider      VARCHAR(20)   NOT NULL CHECK (provider IN ('google','outlook')),
  channel_id    VARCHAR(255)  NOT NULL,
  resource_id   VARCHAR(255),
  channel_token VARCHAR(100)  NOT NULL,
  expires_at    TIMESTAMPTZ   NOT NULL,
  calendar_id   VARCHAR(255),
  created_at    TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (agent_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_cal_watch_channels_agent
  ON calendar_watch_channels (agent_id);
CREATE INDEX IF NOT EXISTS idx_cal_watch_channels_expires
  ON calendar_watch_channels (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_watch_channels TO sonoro_db;
GRANT USAGE, SELECT ON SEQUENCE calendar_watch_channels_id_seq TO sonoro_db;
