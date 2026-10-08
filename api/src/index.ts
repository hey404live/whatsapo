import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createApp } from './app.js';
import { createPool, initializeDatabase } from './database.js';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) loadEnvFile(envFile);
// Se carga solo en el proceso de la API; nunca se imprime su contenido.
const r2EnvFile = new URL('../.env.r2.local', import.meta.url);
if (existsSync(r2EnvFile)) loadEnvFile(r2EnvFile);

const port = Number(process.env.PORT ?? 3000);
const pool = createPool();
pool.on('error', (error) => console.error('Error de PostgreSQL:', error));

try {
  await initializeDatabase(pool);
  const server = createApp(pool);
  server.listen(port, '127.0.0.1', () => {
    console.log(`API disponible en http://127.0.0.1:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => { void pool.end(); });
    });
  }
} catch (error) {
  console.error('No se pudo iniciar la API. Comprueba PostgreSQL y DATABASE_URL.', error);
  await pool.end();
  process.exitCode = 1;
}
