import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Pool } from 'pg';

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
  text, created_at AS "createdAt"`;

export function createApp(pool: Pool) {
  return createServer((request, response) => {
    // Permite peticiones directas desde el cliente durante el tutorial.
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers',
      request.headers['access-control-request-headers'] ?? 'Content-Type, Authorization');
    response.setHeader('Vary', 'Access-Control-Request-Headers');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    void route(request, response, pool).catch((error: unknown) => {
      if (error instanceof HttpError) {
        json(response, error.status, { error: error.message });
      } else {
        console.error('Error al procesar la petición:', error);
        json(response, 500, { error: 'No se pudo completar la petición' });
      }
    });
  });
}

async function route(request: IncomingMessage, response: ServerResponse, pool: Pool) {
  const path = request.url?.split('?')[0] ?? '/';
  if (request.method === 'GET' && path === '/api/health') {
    json(response, 200, { status: 'ok' });
    return;
  }

  if (request.method === 'POST' && path === '/api/messages') {
    const body = await readBody(request);
    const sender = username(body.sender);
    const recipient = username(body.recipient);
    if (sender === recipient) throw new HttpError(400, 'El destinatario debe ser otro usuario');
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) {
      throw new HttpError(400, 'El mensaje debe contener entre 1 y 4000 caracteres y no puede estar vacío');
    }
    const result = await pool.query(
      `INSERT INTO messages (sender_username, recipient_username, text)
       VALUES ($1, $2, $3) RETURNING ${messageColumns}`,
      [sender, recipient, body.text.trim()],
    );
    json(response, 201, { message: result.rows[0] });
    return;
  }

  const list = path.match(/^\/api\/conversations\/([^/]+)$/);
  if (request.method === 'GET' && list) {
    let decoded: string;
    try { decoded = decodeURIComponent(list[1]); }
    catch { throw new HttpError(400, 'El username en la URL no es válido'); }
    const owner = username(decoded);
    const result = await pool.query(
      `SELECT DISTINCT ON (contact) id, sender_username AS sender,
         recipient_username AS recipient, text, created_at AS "createdAt",
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
