# Whatsapo

Base del proyecto con dos espacios de trabajo de npm:

- `client/`: cliente Vite con TypeScript; código en `src/` y archivos estáticos en `public/`.
- `api/`: API Node.js con TypeScript; punto de entrada en `src/index.ts`.

## Desarrollo

Instala las dependencias y arranca ambos servicios desde la raíz:

```sh
npm install
npm run dev
```

- Cliente: http://localhost:5173
- Estado de la API: http://127.0.0.1:3000/api/health

Vite reenvía `/api` al puerto 3000 durante el desarrollo. La API usa ese puerto por defecto; puedes cambiarlo con la variable de entorno `PORT`, ajustando también el proxy del cliente.

## Comandos

```sh
npm run dev:client  # Solo el cliente
npm run dev:api     # Solo la API
npm run typecheck  # Revisa los tipos de ambos proyectos
npm run build      # Genera client/dist y api/dist
npm start -w api   # Ejecuta la API compilada
```

Para desplegar, sirve `client/dist` como contenido estático y configura el servidor o proxy para enviar `/api` a la API. El proxy de Vite se usa únicamente en desarrollo.
