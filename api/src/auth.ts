import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';

const derive = promisify(scrypt);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [, salt, key] = hash.split(':');
  const candidate = await derive(password, salt, 64) as Buffer;
  const expected = Buffer.from(key, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
// Iguala el trabajo criptográfico cuando la cuenta no existe o todavía no tiene contraseña.
export const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
const cookieName = 'whatsapo_session';
export function tokenHash(request: IncomingMessage) {
  const token = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? createHash('sha256').update(token).digest('hex') : null;
}
function cookie(value: string, maxAge: number) {
  return `${cookieName}=${value}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
export async function createSession(pool: Pool, response: ServerResponse, username: string) {
  const token = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, now() + interval '30 days')`,
    [createHash('sha256').update(token).digest('hex'), username]);
  response.setHeader('Set-Cookie', cookie(token, 30 * 24 * 60 * 60));
}
export async function authenticatedUsername(pool: Pool, request: IncomingMessage): Promise<string | null> {
  const hash = tokenHash(request);
  if (!hash) return null;
  const result = await pool.query('SELECT username FROM sessions WHERE token_hash = $1 AND expires_at > now()', [hash]);
  return result.rows[0]?.username ?? null;
}
export async function logoutSession(pool: Pool, request: IncomingMessage, response: ServerResponse) {
  const hash = tokenHash(request);
  if (hash) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash]);
  response.setHeader('Set-Cookie', cookie('', 0));
}
