import { Pool } from 'pg';

export function createPool(connectionString = process.env.DATABASE_URL) {
  return new Pool({
    connectionString: connectionString ?? 'postgresql://whatsapo:whatsapo_local@127.0.0.1:5432/whatsapo',
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
}

export async function initializeDatabase(pool: Pool) {
  await pool.query(`
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
  `);
}
