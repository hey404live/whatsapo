import assert from 'node:assert/strict';
import { once } from 'node:events';
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

before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  await initializeDatabase(pool);
  await initializeDatabase(pool);
  server = createApp(pool);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

function send(body) {
  return fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
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
  const response = await fetch(`${base}/api/conversations/nuevo/otro`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { participants: ['nuevo', 'otro'], messages: [] });
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
    method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
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
  assert.deepEqual(await (await fetch(`${base}/api/conversations/nadie`)).json(), { conversations: [] });
  assert.equal((await fetch(`${base}/api/conversations/%ZZ`)).status, 400);
});
