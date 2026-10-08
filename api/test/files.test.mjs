import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createApp } from '../dist/app.js';
import { createR2Storage } from '../dist/storage.js';

async function fixture(run, options = {}) {
  const objects = new Map();
  const files = new Map();
  const pool = { async query(sql, values) {
    if (sql.startsWith('SELECT username FROM sessions')) return { rows: [{ username: 'alice' }] };
    if (sql.startsWith('INSERT INTO files')) {
      if (options.dbFailure) throw new Error('DB unavailable');
      const [id, owner, key, filename, contentType, size, previewType] = values;
      const file = { id, owner_username: owner, object_key: key, filename, contentType, size, size_bytes: size, preview_type: previewType };
      files.set(id, file);
      return { rows: [file] };
    }
    if (sql.startsWith('SELECT * FROM files')) {
      const file = files.get(values[0]);
      return { rows: file?.owner_username === values[1] ? [file] : [] };
    }
    throw new Error('Unexpected query');
  } };
  const storage = {
    async put(key, body) { if (options.storageFailure) throw new Error('Secret must not appear'); objects.set(key, body); },
    async get(key) { return Readable.from(objects.get(key)); },
    async remove(key) { objects.delete(key); },
  };
  const server = createApp(pool, storage);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/files`;
  const headers = { Cookie: `whatsapo_session=${'a'.repeat(64)}`, 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('Informe español.pdf') };
  try { await run({ url, headers, objects, files }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('sube bytes intactos, devuelve metadatos y descarga solo archivos propios', async () => {
  await fixture(async ({ url, headers, objects, files }) => {
    const bytes = Buffer.from([0, 255, 1, 2]);
    const response = await fetch(url, { method: 'POST', headers, body: bytes });
    assert.equal(response.status, 201);
    const { file } = await response.json();
    assert.equal(file.filename, 'Informe español.pdf');
    assert.equal(file.contentType, 'application/pdf');
    assert.equal(file.size, 4);
    assert.deepEqual([...objects.values()][0], bytes);
    const download = await fetch(`${url}/${file.id}`, { headers });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    files.get(file.id).owner_username = 'bob';
    assert.equal((await fetch(`${url}/${file.id}`, { headers })).status, 404);
    assert.equal((await fetch(`${url}/${file.id}`)).status, 401);
  });
});

test('rechaza peticiones sin sesión, nombres inválidos, archivos vacíos y tamaño excesivo', async () => {
  await fixture(async ({ url, headers, objects }) => {
    assert.equal((await fetch(url, { method: 'POST', body: 'data' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'X-File-Name': '../bad' }, body: 'data' })).status, 400);
    const previous = process.env.UPLOAD_MAX_SIZE_MB;
    process.env.UPLOAD_MAX_SIZE_MB = '0.00001';
    try {
      assert.equal((await fetch(url, { method: 'POST', headers, body: Buffer.alloc(30) })).status, 413);
      assert.equal((await fetch(url, { method: 'POST', headers, body: Readable.from([Buffer.alloc(30)]), duplex: 'half' })).status, 413);
    } finally { if (previous === undefined) delete process.env.UPLOAD_MAX_SIZE_MB; else process.env.UPLOAD_MAX_SIZE_MB = previous; }
    assert.equal(objects.size, 0);
  });
});

test('fallos de R2 no filtran detalles y fallo de DB elimina el objeto', async () => {
  await fixture(async ({ url, headers, files }) => {
    const response = await fetch(url, { method: 'POST', headers, body: 'data' });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'No se pudo guardar el archivo en R2' });
    assert.equal(files.size, 0);
  }, { storageFailure: true });
  await fixture(async ({ url, headers, objects }) => {
    assert.equal((await fetch(url, { method: 'POST', headers, body: 'data' })).status, 500);
    assert.equal(objects.size, 0);
  }, { dbFailure: true });
});

test('configuración incompleta no crea una conexión R2', () => {
  assert.equal(createR2Storage({}), undefined);
});
