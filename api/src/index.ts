import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import type { Pool } from 'pg';
import { createApp } from './app.js';
import { createPool, initializeDatabase } from './database.js';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) loadEnvFile(envFile);
// Se carga solo en el proceso de la API; nunca se imprime su contenido.
const r2EnvFile = new URL('../.env.r2.local', import.meta.url);
if (existsSync(r2EnvFile)) loadEnvFile(r2EnvFile);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
let pool: Pool | undefined;

try {
  pool = createPool();
  const databasePool = pool;
  pool.on('error', (error) => console.error('Error de PostgreSQL:', error));
  await initializeDatabase(pool);
  const server = createApp(pool);
  server.listen(port, host, () => {
    console.log(`API disponible en http://${host}:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => { void databasePool.end(); });
    });
  }
} catch (error) {
  console.error('No se pudo iniciar la API. Comprueba PostgreSQL y DATABASE_URL.', error);
  await pool?.end();
  process.exitCode = 1;
}
