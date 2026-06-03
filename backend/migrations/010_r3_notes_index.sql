-- Índice parcial para acelerar consulta de notas por token
CREATE INDEX IF NOT EXISTS idx_token_events_notes
  ON token_events(token_id)
  WHERE event_type = 'note_added';
