import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Pool } from 'pg';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export interface FileStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

export function createR2Storage(env = process.env): FileStorage | undefined {
  const bucket = env.R2_BUCKET_NAME;
  const endpoint = env.R2_ENDPOINT || (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
  if (!bucket || !endpoint || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return undefined;
  const client = new S3Client({
    region: 'auto', endpoint,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!(result.Body instanceof Readable)) throw new Error('Respuesta de almacenamiento inválida');
      return result.Body;
    },
    async remove(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function fileRoute(request: IncomingMessage, response: ServerResponse, pool: Pool,
  owner: string | null, storage: FileStorage | undefined) {
  const path = request.url?.split('?')[0] ?? '';
  if (path !== '/api/files' && !path.startsWith('/api/files/')) return false;
  const fail = (status: number, error: string) => { request.resume(); reply(response, status, { error }); return true; };
  if (!owner) return fail(401, 'Inicia sesión para continuar');
  if (!storage) return fail(503, 'Configura las credenciales R2 en el servidor para guardar archivos');
  const download = path.match(/^\/api\/files\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(\/preview)?$/i);
  if (request.method === 'GET' && download) {
    const result = await pool.query(`SELECT * FROM files WHERE id = $1 AND (owner_username = $2 OR EXISTS (
      SELECT 1 FROM messages WHERE attachment_id = files.id AND (sender_username = $2 OR recipient_username = $2)))`, [download[1], owner]);
    const file = result.rows[0];
    if (!file) return fail(404, 'Archivo no encontrado');
    const preview = Boolean(download[2]);
    if (preview && !file.preview_type) return fail(415, 'Este archivo no tiene vista previa');
    try {
      const body = await storage.get(file.object_key);
      response.writeHead(200, {
        'Content-Type': preview ? file.preview_type : 'application/octet-stream',
        'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g, '%27')}`,
        'Content-Length': String(file.size_bytes), 'X-Content-Type-Options': 'nosniff',
      });
      await pipeline(body, response);
    } catch {
      if (!response.headersSent) return fail(502, 'No se pudo descargar el archivo de R2');
      response.destroy();
    }
    return true;
  }
  if (request.method !== 'POST' || path !== '/api/files') return fail(404, 'Ruta no encontrada');
  let filename: string;
  try { filename = decodeURIComponent(String(request.headers['x-file-name'] ?? '')).trim(); }
  catch { return fail(400, 'X-File-Name debe contener un nombre codificado con encodeURIComponent'); }
  if (!filename || filename.length > 255 || /[\x00-\x1f\x7f/\\]/.test(filename)) return fail(400, 'Nombre de archivo inválido');
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? '';
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) return fail(415, 'Indica el Content-Type del archivo');
  const allowed = (process.env.UPLOAD_ALLOWED_MIME_TYPES || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(contentType)) return fail(415, 'Tipo de archivo no permitido');
  const mb = Number(process.env.UPLOAD_MAX_SIZE_MB || 10);
  if (!Number.isFinite(mb) || mb <= 0 || mb > 50) return fail(503, 'UPLOAD_MAX_SIZE_MB debe estar entre 0 y 50 MB');
  const limit = Math.floor(mb * 1024 * 1024);
  if (Number(request.headers['content-length']) > limit) return fail(413, 'El archivo supera el tamaño máximo permitido');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size <= limit) chunks.push(Buffer.from(chunk));
  }
  if (size > limit) return fail(413, 'El archivo supera el tamaño máximo permitido');
  if (!size) return fail(400, 'El archivo está vacío');
  const id = randomUUID();
  const key = `uploads/${owner}/${id}`;
  const bytes = Buffer.concat(chunks);
  // Solo imágenes raster reconocibles; nunca HTML o SVG activo en el origen de la API.
  const previewType = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) ? 'image/gif'
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  try { await storage.put(key, bytes, contentType); }
  catch { return fail(502, 'No se pudo guardar el archivo en R2'); }
  let file;
  try {
    const result = await pool.query(`INSERT INTO files (id, owner_username, object_key, filename, content_type, size_bytes, preview_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, filename, content_type AS "contentType", size_bytes AS size, created_at AS "createdAt"`,
    [id, owner, key, filename, contentType, size, previewType]);
    file = result.rows[0];
  } catch (error) {
    try { await storage.remove(key); } catch { console.error('No se pudo eliminar un archivo huérfano de R2; requiere limpieza.'); }
    throw error;
  }
  reply(response, 201, { file: { ...file, url: `/api/files/${id}`, previewUrl: previewType ? `/api/files/${id}/preview` : null } });
  return true;
}
