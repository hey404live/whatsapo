import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { createPool, initializeDatabase } from '../dist/database.js';

// Cada ejecución usa su propio esquema y no toca los mensajes de desarrollo.
const connectionString = process.env.TEST_DATABASE_URL
  ?? 'postgresql://whatsapo:whatsapo_local@127.0.0.1:5432/whatsapo';
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = createPool(connectionString);
let pool;
let server;
let base;
const nativeFetch = globalThis.fetch;
const cookies = new Map();
function fetch(url, options = {}) {
  return nativeFetch(url, { ...options, headers: { Cookie: cookies.get('alice') ?? '', ...options.headers } });
}
async function auth(path, username, password = 'Prueba_segura_123') {
  return nativeFetch(`${base}/api/auth/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
}

before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  await initializeDatabase(pool);
  await initializeDatabase(pool);
  server = createApp(pool);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['alice', 'bob', 'charlie']) {
    assert.equal((await auth('register', name)).status, 201);
    const login = await auth('login', name);
    assert.equal(login.status, 200);
    cookies.set(name, login.headers.get('set-cookie').split(';')[0]);
  }
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

function send(body) {
  return fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies.get(typeof body?.sender === 'string' ? body.sender.trim().toLowerCase() : '') ?? cookies.get('alice') }, body: JSON.stringify(body),
  });
}

test('persiste mensajes, normaliza usernames y aísla conversaciones en ambos sentidos', async () => {
  const text = "¡Hola! 🌿 '); DROP TABLE messages; --";
  const firstResponse = await send({ sender: ' Alice ', recipient: 'BOB', text });
  assert.equal(firstResponse.status, 201);
  const first = (await firstResponse.json()).message;
  assert.equal(first.sender, 'alice');
  assert.equal(first.recipient, 'bob');
  assert.equal(first.text, text);
  assert.match(first.id, /^\d+$/);
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));
  const replyResponse = await send({ sender: 'bob', recipient: 'alice', text: 'Respuesta' });
  assert.equal(replyResponse.status, 201);
  const reply = (await replyResponse.json()).message;
  assert.equal((await send({ sender: 'alice', recipient: 'charlie', text: 'Otra conversación' })).status, 201);
  assert.equal((await send({ sender: 'charlie', recipient: 'bob', text: 'No pertenece a Alice' })).status, 201);

  // Fuerza fechas iguales para comprobar que el ID desempata el orden.
  await pool.query('UPDATE messages SET created_at = $1', ['2026-01-01T00:00:00Z']);
  for (const path of ['alice/bob', 'bob/alice', '%20ALICE%20/BOB']) {
    const response = await fetch(`${base}/api/conversations/${path}`);
    assert.equal(response.status, 200);
    const { messages } = await response.json();
    assert.deepEqual(messages.map((message) => message.id), [first.id, reply.id]);
  }

  // Reconectar el servidor y el pool no pierde los mensajes guardados.
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  server = createApp(pool);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const persisted = await (await fetch(`${base}/api/conversations/alice/bob`)).json();
  assert.equal(persisted.messages.length, 2);
});

test('una conversación nueva devuelve una lista vacía', async () => {
  const response = await fetch(`${base}/api/conversations/alice/otro`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { participants: ['alice', 'otro'], messages: [] });
});

test('rechaza mensajes y usernames inválidos sin guardar filas', async () => {
  const beforeCount = (await pool.query('SELECT count(*) FROM messages')).rows[0].count;
  for (const body of [
    {}, null, [],
    { sender: 'alice', recipient: 'bob', text: '   ' },
    { sender: 'alice', recipient: 'bob', text: 'a'.repeat(4001) },
    { sender: 'alice', recipient: 'bob', text: 42 },
    { sender: 'alice', recipient: 'ALICE', text: 'Hola' },
    { sender: 'bad/name', recipient: 'bob', text: 'Hola' },
    { sender: 'a'.repeat(51), recipient: 'bob', text: 'Hola' },
  ]) {
    const response = await send(body);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal((await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  })).status, 400);
  assert.equal((await fetch(`${base}/api/messages`, { method: 'POST', body: 'hola' })).status, 415);
  assert.equal((await send({ sender: 'alice', recipient: 'bob', text: 'a'.repeat(70000) })).status, 413);
  assert.equal((await fetch(`${base}/api/conversations/alice/%ZZ`)).status, 400);
  assert.equal((await fetch(`${base}/api/conversations/alice/alice`)).status, 400);
  assert.equal((await pool.query('SELECT count(*) FROM messages')).rows[0].count, beforeCount);
});

test('conserva health, CORS y errores 404', async () => {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const preflight = await fetch(`${base}/api/messages`, {
    method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'content-type', Origin: 'http://localhost:5173' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type');
  assert.equal((await fetch(`${base}/missing`)).status, 404);
});

test('lista solo las conversaciones del usuario con el último mensaje', async () => {
  const response = await fetch(`${base}/api/conversations/%20ALICE%20`);
  assert.equal(response.status, 200);
  const { conversations } = await response.json();
  assert.deepEqual(conversations.map((contact) => contact.username), ['charlie', 'bob']);
  assert.equal(conversations[1].lastMessage.text, 'Respuesta');
  assert.equal(conversations[1].lastMessage.sender, 'bob');
  assert.equal((await fetch(`${base}/api/conversations/nadie`)).status, 403);
  assert.equal((await fetch(`${base}/api/conversations/%ZZ`)).status, 400);
});

test('registra cuentas únicas y guarda solo hashes con sal', async () => {
  assert.equal((await auth('register', ' ALICE ')).status, 409);
  assert.equal((await auth('register', 'invalido', 'corta')).status, 400);
  const rows = (await pool.query('SELECT password_hash FROM users WHERE username IN ($1, $2)', ['alice', 'bob'])).rows;
  assert.match(rows[0].password_hash, /^scrypt:/);
  assert.notEqual(rows[0].password_hash, 'Prueba_segura_123');
  assert.notEqual(rows[0].password_hash, rows[1].password_hash);
  const results = await Promise.all([auth('register', 'concurrente'), auth('register', 'CONCURRENTE')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});

test('exige contraseña correcta y una sesión válida para leer o enviar', async () => {
  const wrong = await auth('login', 'alice', 'incorrecta_123');
  const missing = await auth('login', 'desconocido', 'incorrecta_123');
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.deepEqual(await wrong.json(), await missing.json());
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: '' } })).status, 401);
  assert.equal((await fetch(`${base}/api/conversations/alice/bob`, { headers: { Cookie: '' } })).status, 401);
  assert.equal((await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { Cookie: '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'alice', recipient: 'bob', text: 'No autorizado' }),
  })).status, 401);
  assert.equal((await fetch(`${base}/api/conversations/bob`)).status, 403);
  assert.equal((await fetch(`${base}/api/conversations/bob/charlie`)).status, 403);
  assert.equal((await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'bob', recipient: 'charlie', text: 'Suplantación' }),
  })).status, 403);
  assert.equal((await send({ sender: 'alice', recipient: 'no_existe', text: 'Hola' })).status, 404);
  assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Origin: 'https://otro.example' } })).status, 403);
});

test('persiste adjuntos, muestra imágenes y permite acceso solo a participantes', async () => {
  const objects = new Map();
  const fileServer = createApp(pool, {
    async put(key, bytes) { objects.set(key, bytes); },
    async get(key) { return Readable.from(objects.get(key)); },
    async remove(key) { objects.delete(key); },
  });
  fileServer.listen(0, '127.0.0.1');
  await once(fileServer, 'listening');
  const root = `http://127.0.0.1:${fileServer.address().port}`;
  const headers = name => ({ Cookie: cookies.get(name) });
  try {
    const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
    const uploaded = await nativeFetch(`${root}/api/files`, { method: 'POST',
      headers: { ...headers('alice'), 'Content-Type': 'image/png', 'X-File-Name': 'foto.png' }, body: png });
    assert.equal(uploaded.status, 201);
    const { file } = await uploaded.json();
    assert.ok(file.previewUrl.endsWith('/preview'));
    assert.equal((await nativeFetch(`${root}${file.previewUrl}`, { headers: headers('bob') })).status, 404);
    const sendFile = (name, attachmentId) => nativeFetch(`${root}/api/messages`, { method: 'POST',
      headers: { ...headers(name), 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: name === 'alice' ? 'bob' : 'alice', attachmentId }) });
    assert.equal((await sendFile('bob', file.id)).status, 403);
    const sent = await sendFile('alice', file.id);
    assert.equal(sent.status, 201);
    const { message } = await sent.json();
    assert.equal(message.text, '');
    assert.equal(message.attachment.id, file.id);
    const preview = await nativeFetch(`${root}${file.previewUrl}`, { headers: headers('bob') });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.match(preview.headers.get('content-disposition'), /^inline;/);
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
    assert.equal((await nativeFetch(`${root}${file.url}`, { headers: headers('charlie') })).status, 404);
    assert.equal((await nativeFetch(`${root}${file.previewUrl}`)).status, 401);
    const history = await (await nativeFetch(`${root}/api/conversations/bob/alice`, { headers: headers('bob') })).json();
    assert.equal(history.messages.at(-1).attachment.filename, 'foto.png');
    const list = await (await nativeFetch(`${root}/api/conversations/bob`, { headers: headers('bob') })).json();
    assert.equal(list.conversations.find(c => c.username === 'alice').lastMessage.attachment.id, file.id);
    const svg = await nativeFetch(`${root}/api/files`, { method: 'POST',
      headers: { ...headers('alice'), 'Content-Type': 'image/svg+xml', 'X-File-Name': 'activo.svg' }, body: '<svg></svg>' });
    const other = (await svg.json()).file;
    assert.equal(other.previewUrl, null);
    assert.equal((await nativeFetch(`${root}${other.url}/preview`, { headers: headers('alice') })).status, 415);
    await initializeDatabase(pool);
  } finally { await new Promise(resolve => fileServer.close(resolve)); }
});

test('restaura sesión, revoca al salir y rechaza sesiones expiradas', async () => {
  const login = await auth('login', 'ALICE');
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const headers = { Cookie: setCookie.split(';')[0] };
  const me = await fetch(`${base}/api/auth/me`, { headers });
  assert.deepEqual(await me.json(), { username: 'alice' });
  assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(`${base}/api/auth/me`, { headers })).status, 401);
  await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE username = 'charlie'");
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookies.get('charlie') } })).status, 401);
});

test('reserva usernames históricos sin asignarlos a nuevos registros', async () => {
  await pool.query("INSERT INTO messages (sender_username, recipient_username, text) VALUES ('historico', 'alice', 'Anterior a las cuentas')");
  await initializeDatabase(pool);
  assert.equal((await auth('register', 'historico')).status, 409);
  assert.equal((await auth('login', 'historico')).status, 401);
});

test('limita intentos de autenticación incluso con query string', async () => {
  const limitedServer = createApp(pool);
  limitedServer.listen(0, '127.0.0.1');
  await once(limitedServer, 'listening');
  try {
    const url = `http://127.0.0.1:${limitedServer.address().port}/api/auth/login?test=1`;
    for (let attempt = 0; attempt < 20; attempt++) {
      assert.equal((await nativeFetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })).status, 400);
    }
    const blocked = await nativeFetch(url, { method: 'POST' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally { await new Promise((resolve) => limitedServer.close(resolve)); }
});
