import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3000);

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (request.method === 'GET' && request.url?.split('?')[0] === '/api/health') {
    response.writeHead(200);
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  response.writeHead(404);
  response.end(JSON.stringify({ error: 'Ruta no encontrada' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`API disponible en http://127.0.0.1:${port}`);
});
