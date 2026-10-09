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

El cliente usa `/api` en el mismo origen. Vite redirige estas peticiones a `http://127.0.0.1:3000`.
La API admite los orígenes locales de Vite; `CLIENT_ORIGIN` permite configurar el origen del despliegue.
Si cambias `PORT`, ajusta el destino del proxy en `client/vite.config.ts`.

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
Al iniciar, la API crea las tablas `users`, `sessions`, `messages` y sus índices si todavía no existen.

```sh
docker compose exec postgres psql -U whatsapo -d whatsapo  # Abre la consola SQL
docker compose stop                                    # Detiene la base de datos
docker compose up -d --wait                             # Vuelve a iniciarla
```

## Desplegar la API

El build compila la API, pero no inicia PostgreSQL ni ejecuta `compose.yaml`.
Crea una base de datos PostgreSQL accesible desde el servicio y configura estas variables
en el entorno de ejecución de la API:

- `DATABASE_URL`: URL de conexión proporcionada por PostgreSQL, con usuario, contraseña,
  host, puerto y base de datos. No uses `127.0.0.1` ni `localhost`: dentro del contenedor
  apuntan al propio contenedor de la API. Si el proveedor exige TLS, usa sus parámetros de conexión.
- `NODE_ENV=production`: exige `DATABASE_URL` y activa las cookies Secure.
- `CLIENT_ORIGIN`: origen HTTPS del cliente, por ejemplo `https://chat.example.com`.
- `PORT`: usa el puerto que asigna la plataforma; por defecto es `3000`.

La API escucha en `0.0.0.0` para recibir conexiones del servicio. `HOST` permite sobrescribirlo.
Configura el puerto del servicio para que coincida con `PORT` y, si la plataforma permite
elegir una ruta de comprobación de salud, usa `/api/health`.
El usuario de PostgreSQL necesita permisos para crear y modificar las tablas al arrancar.
Después de guardar las variables, vuelve a desplegar.

Un error `ECONNREFUSED 127.0.0.1:5432` significa que la API está intentando usar PostgreSQL
local: revisa que `DATABASE_URL` esté configurada en el servicio de la API y que no contenga
la URL de desarrollo. En producción, una variable ausente produce un error explícito.

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
minúsculas. Se admiten de 1 a 50 caracteres `a-z`, `0-9` y `_`. Es necesario registrar una cuenta e iniciar sesión:
cada mensaje guarda el username del remitente y del destinatario. La pareja de usernames define
una conversación, independientemente de quién envía el mensaje.

### Enviar un mensaje

`POST /api/messages` con `Content-Type: application/json`:

```sh
curl -b cookies.txt -X POST http://127.0.0.1:3000/api/messages \
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
curl -b cookies.txt http://127.0.0.1:3000/api/conversations/ana/juan
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
carga las conversaciones guardadas. Haz clic en una para leer su historial o pulsa «+» junto a
«Mensajes» para abrir el modal de nueva conversación. Introduce el username del destinatario y pulsa «Abrir chat». Los mensajes se muestran como enviados después
de que la API confirma que se guardaron. Las conversaciones y el historial abierto se actualizan cada
cinco segundos mientras la pestaña está visible. Si falla un envío, se conserva el borrador.
Al salir se limpian los borradores y el estado del usuario anterior.

Para conversar con dos cuentas simultáneamente, usa perfiles de navegador diferentes o una ventana
privada: las pestañas del mismo navegador comparten la cookie de sesión.

## Registro e inicio de sesión

El enlace «Regístrate» abre `/#/registro`; `/#/login` muestra el inicio de sesión.
Ambas pantallas piden username y contraseña. Las contraseñas tienen entre 8 y 128 caracteres,
se comparan exactamente (sin recortar espacios) y se almacenan con scrypt y una sal aleatoria.
No se guarda la contraseña en el navegador ni en texto plano en PostgreSQL.

- `POST /api/auth/register`: recibe `{ "username": "nuevo", "password": "..." }`, devuelve `201`
  al crear la cuenta o `409` si el username ya está ocupado. Después se solicita iniciar sesión.
- `POST /api/auth/login`: recibe los mismos campos, devuelve el username y una cookie HttpOnly
  si la contraseña coincide. Un fallo devuelve `401` con un mensaje genérico.
- `GET /api/auth/me`: verifica la cookie y devuelve el username de la sesión activa.
- `POST /api/auth/logout`: revoca la sesión en la base de datos y elimina la cookie.

La sesión dura 30 días y se verifica con la API al recargar. El antiguo username de localStorage
se elimina y ya no permite entrar por sí solo. Las rutas de chat exigen sesión, toman el remitente
de ella y rechazan lecturas de conversaciones ajenas. El destinatario debe existir. Si se envía
`sender` por compatibilidad, debe coincidir con la sesión. El inicio de sesión y registro tienen
un límite local de 20 intentos por minuto y dirección IP (en memoria; se reinicia con la API).

Para usar curl, guarda la cookie al iniciar sesión con `curl -c cookies.txt` y envíala después con
`curl -b cookies.txt`. Las credenciales del JSON deben corresponder a una cuenta registrada.

### Nombres anteriores a las contraseñas

La migración conserva los mensajes existentes y reserva sus usernames en `users` con
`password_hash = NULL`. Estos nombres no se pueden registrar ni usar para iniciar sesión hasta
que el administrador asigne una contraseña mediante el mismo hash scrypt. Esto evita entregar
conversaciones antiguas a quien intente registrar uno de esos nombres. No se asignan contraseñas
predeterminadas ni se permite reclamar estas cuentas desde el formulario de registro.

Las pruebas usan un esquema temporal independiente que se elimina al finalizar. Puedes apuntarlas
a otra base de datos con `TEST_DATABASE_URL`; no modifican los mensajes de desarrollo.

Para desplegar, sirve `client/dist` por HTTPS, redirige `/api` al servidor Node y configura `CLIENT_ORIGIN` con el origen público y `NODE_ENV=production` para cookies Secure. Las peticiones con origen no permitido se rechazan.

## Guardar archivos en Cloudflare R2

La API carga `api/.env` y después `api/.env.r2.local` al iniciar, tanto en desarrollo como compilada.
Las variables ya presentes en el entorno tienen prioridad. El archivo local está excluido de Git;
no lo compartas. Configura `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` y
`R2_ENDPOINT` (o `R2_ACCOUNT_ID` para derivar el endpoint estándar). Reinicia la API tras cambiarlos.
La integración usa el SDK S3 con región `auto`, según la documentación de Cloudflare:
https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/

En unbroker.cloud, configura estas mismas variables como secretos del servicio de la API.
`API_DEPLOYMENT_PROVIDER` es informativo y no interviene en la conexión. No se requiere URL pública
ni CORS en R2: los archivos pasan por la API. Mantén deshabilitado el acceso público del bucket
para que las descargas sean privadas.

`POST /api/files` exige sesión y recibe el contenido binario directamente (no multipart ni JSON):

```sh
curl -b cookies.txt http://127.0.0.1:3000/api/files \
  -H 'Content-Type: application/pdf' \
  -H 'X-File-Name: informe.pdf' \
  --data-binary @informe.pdf
```

En el navegador usa `body: file`, `Content-Type: file.type || 'application/octet-stream'` y
`X-File-Name: encodeURIComponent(file.name)`. Devuelve `201` con
`{ "file": { "id": "uuid", "filename": "informe.pdf", "contentType": "application/pdf", "size": 123,
"createdAt": "...", "url": "/api/files/uuid" } }`.

`GET /api/files/:id` descarga el archivo; exige sesión y permite acceso al propietario y a
los participantes de mensajes que incluyan ese archivo. `GET /api/files/:id/preview` sirve
imágenes PNG, JPEG, GIF y WebP reconocidas por su firma binaria; otros tipos se descargan
como archivos. Los buckets permanecen privados.
PostgreSQL guarda los metadatos y R2 guarda los bytes con claves únicas. Si falla el registro en
PostgreSQL, la API intenta eliminar el objeto subido. Si esa limpieza falla, se registra un aviso
sin credenciales para que se pueda revisar R2.

`UPLOAD_MAX_SIZE_MB` admite hasta 50 MB y usa 10 MB por defecto. `UPLOAD_ALLOWED_MIME_TYPES`
puede contener tipos MIME separados por comas; vacío permite cualquier tipo MIME válido.
El tipo MIME lo declara el cliente; no se verifica el contenido ni se escanean virus.
Las descargas se sirven como adjuntos con `nosniff`; las vistas previas raster usan su tipo MIME.
Errores: `401` sin sesión, `400` archivo vacío o nombre inválido, `413` tamaño excesivo,
`415` tipo no permitido, `503` configuración ausente y `502` fallo de almacenamiento.

El botón de clip junto al campo de mensaje inicia la subida. La tarjeta muestra una miniatura
para imágenes, nombre, tamaño, porcentaje y barra de progreso. Al completar la transferencia
muestra «Guardando» mientras R2 confirma, y después «Listo para enviar». Puedes cancelar
la subida o quitar el adjunto. Pulsa Enviar con un texto opcional para compartirlo en el chat.
Si falla el envío del mensaje, se conserva el archivo ya subido para reintentar.

`POST /api/messages` acepta `attachmentId` de un archivo propio y un `text` opcional cuando
hay adjunto. Los mensajes y últimos mensajes de conversaciones incluyen `attachment` con
metadatos, `url` de descarga y `previewUrl` si es imagen. Los adjuntos enviados se conservan
al recargar y se ven para ambos participantes; usuarios ajenos no pueden descargarlos.
La selección pendiente se limpia al salir o recargar. Los archivos subidos y luego descartados
permanecen en R2; por ahora no hay una política automática de limpieza de esos archivos.
