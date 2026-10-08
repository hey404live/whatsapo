import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { createR2Storage, fileRoute, type FileStorage } from './storage.js';
import { hashPassword, verifyPassword, dummyHash, createSession, authenticatedUsername, logoutSession } from './auth.js';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function username(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'El username debe ser un texto');
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_]{1,50}$/.test(normalized)) {
    throw new HttpError(400, 'El username debe tener entre 1 y 50 letras, números o guiones bajos (a-z, 0-9, _)');
  }
  return normalized;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    request.resume();
    throw new HttpError(415, 'Usa Content-Type: application/json');
  }
  // Consume el cuerpo sin acumular más de 64 KiB en memoria.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size <= 65536) chunks.push(Buffer.from(chunk));
  }
  if (size > 65536) throw new HttpError(413, 'El cuerpo de la petición es demasiado grande');
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'El cuerpo debe ser un objeto JSON válido');
  }
}

const messageColumns = `id, sender_username AS sender, recipient_username AS recipient,
  text, created_at AS "createdAt",
  (SELECT json_build_object('id', f.id, 'filename', f.filename, 'size', f.size_bytes,
    'contentType', f.content_type, 'url', '/api/files/' || f.id,
    'previewUrl', CASE WHEN f.preview_type IS NOT NULL THEN '/api/files/' || f.id || '/preview' END)
   FROM files f WHERE f.id = messages.attachment_id) AS attachment`;

export function createApp(pool: Pool, storage: FileStorage | undefined = createR2Storage()) {
  const attempts = new Map<string, { count: number; until: number }>();
  return createServer((request, response) => {
    const origin = request.headers.origin;
    const allowedOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173',
      'http://localhost:4173', 'http://127.0.0.1:4173', ...(process.env.CLIENT_ORIGIN ? [process.env.CLIENT_ORIGIN] : [])]);
    if (origin && !allowedOrigins.has(origin)) {
      json(response, 403, { error: 'Origen no permitido' });
      return;
    }
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers',
      request.headers['access-control-request-headers'] ?? 'Content-Type, Authorization');
    response.setHeader('Vary', 'Origin, Access-Control-Request-Headers');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'POST' && /^\/api\/auth\/(login|register)$/.test(request.url?.split('?')[0] ?? '')) {
      const now = Date.now();
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      const key = request.socket.remoteAddress ?? 'local';
      const entry = attempts.get(key) ?? { count: 0, until: now + 60000 };
      entry.count++;
      attempts.set(key, entry);
      if (entry.count > 20) {
        response.setHeader('Retry-After', String(Math.ceil((entry.until - now) / 1000)));
        json(response, 429, { error: 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.' });
        return;
      }
    }
    void route(request, response, pool, storage).catch((error: unknown) => {
      if (error instanceof HttpError) {
        json(response, error.status, { error: error.message });
      } else {
        console.error('Error al procesar la petición:', error);
        json(response, 500, { error: 'No se pudo completar la petición' });
      }
    });
  });
}

async function route(request: IncomingMessage, response: ServerResponse, pool: Pool, storage: FileStorage | undefined) {
  const path = request.url?.split('?')[0] ?? '/';
  if (request.method === 'GET' && path === '/api/health') {
    json(response, 200, { status: 'ok' });
    return;
  }

  if (request.method === 'POST' && (path === '/api/auth/register' || path === '/api/auth/login')) {
    const body = await readBody(request);
    const name = username(body.username);
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) {
      throw new HttpError(400, 'La contraseña debe tener entre 8 y 128 caracteres');
    }
    if (path.endsWith('/register')) {
      const hash = await hashPassword(body.password);
      const result = await pool.query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING username', [name, hash]);
      if (!result.rowCount) throw new HttpError(409, 'Ese username no está disponible');
      json(response, 201, { username: name });
    } else {
      const result = await pool.query('SELECT password_hash FROM users WHERE username = $1', [name]);
      const hash = result.rows[0]?.password_hash;
      const valid = await verifyPassword(body.password, hash ?? dummyHash);
      if (!hash || !valid) throw new HttpError(401, 'Username o contraseña incorrectos');
      await logoutSession(pool, request, response);
      await createSession(pool, response, name);
      json(response, 200, { username: name });
    }
    return;
  }
  if (request.method === 'POST' && path === '/api/auth/logout') {
    await logoutSession(pool, request, response);
    json(response, 200, { status: 'ok' });
    return;
  }
  const owner = await authenticatedUsername(pool, request);
  if (await fileRoute(request, response, pool, owner, storage)) return;
  if (path === '/api/auth/me' || path === '/api/messages' || path.startsWith('/api/conversations/')) {
    if (!owner) throw new HttpError(401, 'Inicia sesión para continuar');
  }
  if (request.method === 'GET' && path === '/api/auth/me') {
    json(response, 200, { username: owner });
    return;
  }

  if (request.method === 'POST' && path === '/api/messages') {
    const body = await readBody(request);
    const sender = owner!;
    if (body.sender !== undefined && username(body.sender) !== sender) throw new HttpError(403, 'No puedes enviar mensajes como otro usuario');
    const recipient = username(body.recipient);
    if (sender === recipient) throw new HttpError(400, 'El destinatario debe ser otro usuario');
    const attachmentId = body.attachmentId;
    const text = body.text === undefined && attachmentId ? '' : body.text;
    if (typeof text !== 'string' || (!text.trim() && !attachmentId) || text.length > 4000) {
      throw new HttpError(400, 'El mensaje debe contener entre 1 y 4000 caracteres y no puede estar vacío');
    }
    if (attachmentId !== undefined) {
      if (typeof attachmentId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(attachmentId)) {
        throw new HttpError(400, 'Adjunto inválido');
      }
      const file = await pool.query('SELECT 1 FROM files WHERE id = $1 AND owner_username = $2', [attachmentId, sender]);
      if (!file.rowCount) throw new HttpError(403, 'No puedes enviar este archivo');
    }
    const recipientExists = await pool.query('SELECT 1 FROM users WHERE username = $1', [recipient]);
    if (!recipientExists.rowCount) throw new HttpError(404, 'El destinatario no existe');
    const result = await pool.query(
      `INSERT INTO messages (sender_username, recipient_username, text, attachment_id)
       VALUES ($1, $2, $3, $4) RETURNING ${messageColumns}`,
      [sender, recipient, text.trim(), attachmentId ?? null],
    );
    json(response, 201, { message: result.rows[0] });
    return;
  }

  const list = path.match(/^\/api\/conversations\/([^/]+)$/);
  if (request.method === 'GET' && list) {
    let decoded: string;
    try { decoded = decodeURIComponent(list[1]); }
    catch { throw new HttpError(400, 'El username en la URL no es válido'); }
    const requestedOwner = username(decoded);
    if (requestedOwner !== owner) throw new HttpError(403, 'No puedes leer conversaciones de otro usuario');
    const result = await pool.query(
      `SELECT DISTINCT ON (contact) ${messageColumns},
         CASE WHEN sender_username = $1 THEN recipient_username ELSE sender_username END AS contact
       FROM messages WHERE sender_username = $1 OR recipient_username = $1
       ORDER BY contact, created_at DESC, id DESC`,
      [owner],
    );
    const conversations = result.rows.map(({ contact, ...lastMessage }) => ({ username: contact, lastMessage }));
    conversations.sort((a, b) => b.lastMessage.createdAt.getTime() - a.lastMessage.createdAt.getTime()
      || (BigInt(a.lastMessage.id) > BigInt(b.lastMessage.id) ? -1 : 1));
    json(response, 200, { conversations });
    return;
  }

  const conversation = path.match(/^\/api\/conversations\/([^/]+)\/([^/]+)$/);
  if (request.method === 'GET' && conversation) {
    let participants: string[];
    try {
      participants = conversation.slice(1).map((part) => decodeURIComponent(part));
    } catch {
      throw new HttpError(400, 'El username en la URL no es válido');
    }
    const first = username(participants[0]);
    const second = username(participants[1]);
    if (owner !== first && owner !== second) throw new HttpError(403, 'No perteneces a esta conversación');
    if (first === second) throw new HttpError(400, 'La conversación debe ser con otro usuario');
    const result = await pool.query(
      `SELECT ${messageColumns} FROM messages
       WHERE (sender_username = $1 AND recipient_username = $2)
          OR (sender_username = $2 AND recipient_username = $1)
       ORDER BY created_at ASC, id ASC`,
      [first, second],
    );
    json(response, 200, { participants: [first, second], messages: result.rows });
    return;
  }
  json(response, 404, { error: 'Ruta no encontrada' });
}
