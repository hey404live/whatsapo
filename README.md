# Whatsapo

Base del proyecto con dos espacios de trabajo de npm:

- `client/`: cliente Vite con TypeScript; código en `src/` y archivos estáticos en `public/`.
- `api/`: API Node.js con TypeScript; punto de entrada en `src/index.ts`.

## Desarrollo

Con Node.js 22.18 o superior y Docker Desktop abierto, instala las dependencias y arranca los servicios desde la raíz:

```sh
npm install
docker compose up -d --wait
npm run dev
```

- Cliente: http://localhost:5173
- Estado de la API: http://127.0.0.1:3000/api/health

El cliente hace peticiones directamente a `http://127.0.0.1:3000`, sin proxy de Vite. Puedes configurar otro servidor con `VITE_API_URL` en `client/.env` (reinicia Vite después de cambiarlo). La API permite cualquier origen mediante CORS y responde a las solicitudes previas `OPTIONS`. La API usa el puerto 3000 por defecto; puedes cambiarlo con la variable de entorno `PORT`, ajustando también `VITE_API_URL` en el cliente.

## PostgreSQL local

Con Docker Desktop abierto, inicia la base de datos desde la raíz:

```sh
docker compose up -d --wait
```

La conexión para desarrollo es `postgresql://whatsapo:whatsapo_local@127.0.0.1:5432/whatsapo`.
La base de datos solo escucha en tu computadora y conserva sus datos en un volumen de Docker.
Las credenciales son exclusivamente para desarrollo local. `api/.env.example` incluye la variable
`DATABASE_URL` como referencia. La API usa esta conexión local por defecto; puedes sobrescribirla
con una variable de entorno o copiando `api/.env.example` a `api/.env`.
Al iniciar, la API crea la tabla `messages` y su índice si todavía no existen.

```sh
docker compose exec postgres psql -U whatsapo -d whatsapo  # Abre la consola SQL
docker compose stop                                    # Detiene la base de datos
docker compose up -d --wait                             # Vuelve a iniciarla
```

## Comandos del proyecto

```sh
npm run dev:client  # Solo el cliente
npm run dev:api     # Solo la API
npm run typecheck  # Revisa los tipos de ambos proyectos
npm run build      # Genera client/dist y api/dist
npm start -w api   # Ejecuta la API compilada
npm test -w api    # Pruebas de integración (requieren PostgreSQL)
```

## Rutas de chat

El username identifica a cada participante: se quitan espacios en los extremos y se convierte a
minúsculas. Se admiten de 1 a 50 caracteres `a-z`, `0-9` y `_`. No hace falta registrar usuarios:
cada mensaje guarda el username del remitente y del destinatario. La pareja de usernames define
una conversación, independientemente de quién envía el mensaje.

### Enviar un mensaje

`POST /api/messages` con `Content-Type: application/json`:

```sh
curl -X POST http://127.0.0.1:3000/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"sender":"ana","recipient":"juan","text":"¡Hola, Juan!"}'
```

Responde `201` con el mensaje guardado:

```json
{
  "message": {
    "id": "1",
    "sender": "ana",
    "recipient": "juan",
    "text": "¡Hola, Juan!",
    "createdAt": "2026-10-07T20:00:00.000Z"
  }
}
```

El ID se devuelve como string y la fecha en UTC. El texto se recorta en los extremos y debe tener
contenido, con un máximo de 4000 caracteres. No se admiten mensajes a uno mismo.

### Leer una conversación

`GET /api/conversations/:username/:otherUsername`:

```sh
curl http://127.0.0.1:3000/api/conversations/ana/juan
```

Responde `200` con `{ "participants": ["ana", "juan"], "messages": [...] }`. Incluye los mensajes
en ambos sentidos, del más antiguo al más reciente, con desempate por ID. Si no hay mensajes,
devuelve una lista vacía. Invertir los usernames devuelve los mismos mensajes. Por ahora se
devuelve todo el historial, sin paginación.

Los errores usan `{ "error": "descripción" }`: `400` para datos inválidos, `413` para cuerpos de
más de 64 KiB, `415` para un tipo de contenido distinto a JSON y `500` para errores internos.

### Listar conversaciones y usar el cliente

`GET /api/conversations/:username` devuelve `{ "conversations": [{ "username": "juan", "lastMessage": { ... } }] }`,
ordenado por el mensaje más reciente. Solo incluye conversaciones donde participa ese username.

Al entrar al cliente, el username del formulario se normaliza y se usa como remitente. La barra lateral
carga las conversaciones guardadas. Haz clic en una para leer su historial o introduce otro username
en «Username del destinatario» y pulsa «Abrir chat». Los mensajes se muestran como enviados después
de que la API confirma que se guardaron. Las conversaciones y el historial abierto se actualizan cada
cinco segundos mientras la pestaña está visible. Si falla un envío, se conserva el borrador.
Al salir se limpian los borradores y el estado del usuario anterior.

Para probar los mensajes existentes, entra como `ana` y abre `juan`, o viceversa.
Puedes abrir dos pestañas con distintos usernames para conversar entre ellas.

Este esquema no autentica al usuario: quien conozca los usernames puede leer o enviar mensajes a su nombre.

Las pruebas usan un esquema temporal independiente que se elimina al finalizar. Puedes apuntarlas
a otra base de datos con `TEST_DATABASE_URL`; no modifican los mensajes de desarrollo.

Para desplegar, sirve `client/dist` como contenido estático y ajusta la URL del cliente a la dirección pública de la API. La configuración CORS abierta está pensada para el tutorial.
