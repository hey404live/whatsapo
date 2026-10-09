import { Pool } from 'pg';

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString?.trim() && process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL es obligatoria en producción. Configura la URL de PostgreSQL del servicio; la conexión local solo sirve para desarrollo.');
  }
  return new Pool({
    connectionString: connectionString?.trim() || 'postgresql://whatsapo:whatsapo_local@127.0.0.1:5432/whatsapo',
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
}

export async function initializeDatabase(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY CHECK (username ~ '^[a-z0-9_]{1,50}$'),
      password_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiration_idx ON sessions (expires_at);
    CREATE TABLE IF NOT EXISTS files (
      id UUID PRIMARY KEY,
      owner_username TEXT NOT NULL REFERENCES users(username),
      object_key TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      sender_username TEXT NOT NULL CHECK (char_length(sender_username) BETWEEN 1 AND 50),
      recipient_username TEXT NOT NULL CHECK (char_length(recipient_username) BETWEEN 1 AND 50),
      text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (sender_username <> recipient_username)
    );
    CREATE INDEX IF NOT EXISTS messages_participants_idx
      ON messages (sender_username, recipient_username, created_at, id);
    ALTER TABLE files ADD COLUMN IF NOT EXISTS preview_type TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_id UUID REFERENCES files(id);
    ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_text_check;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'messages'::regclass AND conname = 'messages_content_check') THEN
        ALTER TABLE messages ADD CONSTRAINT messages_content_check
          CHECK (char_length(text) <= 4000 AND (char_length(trim(text)) > 0 OR attachment_id IS NOT NULL));
      END IF;
    END $$;
    -- Reserva los nombres antiguos; nunca asigna sus mensajes a un nuevo registro.
    INSERT INTO users (username)
      SELECT sender_username FROM messages UNION SELECT recipient_username FROM messages
      ON CONFLICT (username) DO NOTHING;
  `);
}
