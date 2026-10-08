import './style.css';
import { reconcileChildren } from './reconcile';

const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  attach: '<path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 11h8M8 15h5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  check: '<path d="m3 12 4 4L17 6m-6 10L21 6"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  lock: '<rect x="6" y="10" width="12" height="10" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
};
const icon = (name: keyof typeof icons) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
type Message = { id: string; sender: string; recipient: string; text: string; createdAt: string; attachment?: UploadedFile | null };
type Contact = { username: string; lastMessage?: Message };
const API = import.meta.env.VITE_API_URL ?? '';
let contacts: Contact[] = [];
let selected = '';
let activeUsername = '';
let session = 0;
let loadVersion = 0;
let messages: Message[] = [];
let loading = false;
let sending = false;
let refreshing = false;
let loadError = '';
let sendError = '';
type UploadedFile = { id: string; filename: string; url: string; size: number; previewUrl?: string | null };
type UploadPreview = { filename: string; size: number; localUrl?: string; percent: number };
const uploadPreviews = new Map<string, UploadPreview>();
const formatSize = (size: number) => size < 1048576 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1048576).toFixed(1)} MB`;
function clearAttachment(name: string) {
  const preview = uploadPreviews.get(name);
  if (preview?.localUrl) URL.revokeObjectURL(preview.localUrl);
  uploadPreviews.delete(name);
  uploadedFiles.delete(name);
  uploadErrors.delete(name);
}
const uploadedFiles = new Map<string, UploadedFile>();
let uploadRequest: XMLHttpRequest | undefined;
let uploadConversation = '';
let uploadProgress = '';
const uploadErrors = new Map<string, string>();
const drafts = new Map<string, string>();
const normalize = (value: string) => value.trim().toLowerCase();
const validUsername = (value: string) => /^[a-z0-9_]{1,50}$/.test(value);
const initials = (value: string) => value.slice(0, 2).toUpperCase();
const time = (value: string) => new Date(value).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false });
const date = (value: string) => new Date(value).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
async function api<T>(path: string, body?: unknown): Promise<T> {
  const requestSession = session;
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
    credentials: 'include',
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && requestSession === session && !path.startsWith('/api/auth/')) {
      if (activeUsername) leaveChat();
      authFeedback.textContent = 'Tu sesión terminó. Vuelve a iniciar sesión.';
    }
    throw new Error(data.error ?? 'No se pudo completar la petición');
  }
  return data as T;
}
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <section class="welcome" aria-labelledby="welcome-title">
    <div class="welcome-card">
      <div class="welcome-brand"><img src="/whatsapo.jpeg" alt="Logo de Whatsapo" width="80" height="80"><span>whatsapo<span class="brand-dot">.</span></span></div>
      <p class="welcome-eyebrow">TU ESPACIO PARA CONECTAR</p>
      <h1 id="welcome-title">Qué bueno<br>verte de nuevo.</h1>
      <p class="welcome-description">Ingresa con tu username y contraseña para continuar.</p>
      <form id="welcome-form">
        <label for="username">Username</label>
        <div class="username-field"><span aria-hidden="true">@</span><input id="username" name="username" type="text" placeholder="tu_username" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="username-hint"></div>
        <p id="username-hint">Usa de 1 a 50 letras, números o guiones bajos.</p>
        <label for="password">Contraseña</label>
        <div class="username-field"><input id="password" name="password" type="password" placeholder="Tu contraseña" autocomplete="current-password" minlength="8" maxlength="128" required aria-describedby="password-hint"></div>
        <p id="password-hint">Entre 8 y 128 caracteres.</p>
        <p id="auth-feedback" role="status"></p>
        <button class="enter-chat" type="submit">Entrar al chat ${icon('arrow')}</button>
      </form>
      <a id="auth-switch" class="auth-switch" href="#/registro">¿No tienes cuenta? Regístrate</a>
      <p class="welcome-signoff">Las buenas conversaciones empiezan aquí.</p>
    </div>
  </section>
  <section class="messenger" aria-label="Whatsapo, mensajería" hidden>
    <aside class="sidebar">
      <a class="brand" href="./" aria-label="Whatsapo, inicio"><img class="brand-logo" src="/whatsapo.jpeg" alt="" width="48" height="48">whatsapo<span class="brand-dot">.</span></a>
      <div class="sidebar-heading"><h1>Mensajes</h1><button id="open-new-chat" class="new-chat-trigger" type="button" aria-label="Nueva conversación" aria-haspopup="dialog" aria-controls="new-chat-dialog" title="Nueva conversación">${icon('plus')}</button><span class="contact-count">0</span></div>
      <label class="search">${icon('search')}<input id="search" type="search" placeholder="Buscar una conversación" aria-label="Buscar una conversación" autocomplete="off"><kbd>⌘ K</kbd></label>
      <p id="contacts-status" class="contacts-status" role="status"></p>
      <button id="retry-contacts" class="retry-button" type="button" hidden>Reintentar conversaciones</button>
      <div class="list-heading">TUS CONVERSACIONES <span>—</span></div>
      <nav id="contacts" aria-label="Conversaciones"></nav>
      <div class="profile-area">
        <div id="profile-menu" class="profile-menu" role="menu" aria-label="Tu espacio personal" hidden>
          <button id="logout" type="button" role="menuitem">${icon('back')}<span>Salir</span></button>
        </div>
        <button id="profile-button" class="sidebar-bottom" type="button" aria-label="Tu espacio personal" aria-haspopup="menu" aria-expanded="false" aria-controls="profile-menu">
          <span class="profile-avatar">TÚ</span><span><strong>Tu espacio personal</strong><span id="api-status" role="status">Conectando con la API…</span></span><span class="connection-dot"></span><span class="profile-chevron" aria-hidden="true">${icon('back')}</span>
        </button>
      </div>
    </aside>
    <section class="conversation" aria-label="Conversación activa">
      <header class="chat-header"><button class="back-button icon-button" aria-label="Volver a conversaciones">${icon('back')}</button><div id="header-avatar" class="avatar sage"></div><div class="contact-info"><h2 id="contact-name"></h2><p id="contact-detail"></p></div></header>
      <div class="messages-scroll"><div class="conversation-start"><span class="start-icon">${icon('chat')}</span><p>Las buenas conversaciones empiezan aquí.</p></div><p id="conversation-status" role="status"></p><button id="retry-conversation" class="retry-button" type="button" hidden>Reintentar</button><div id="messages" role="log" aria-label="Mensajes" aria-live="polite"></div></div>
      <footer class="composer-area"><p id="send-error" role="alert"></p><p id="upload-error" role="alert"></p><div id="upload-status" role="status" aria-live="polite"></div><form id="composer"><input id="file-input" type="file" hidden><button id="attach-file" class="attach-button" type="button" aria-label="Subir archivo" title="Subir archivo" disabled>${icon('attach')}</button><input id="message-input" placeholder="Escribe un mensaje…" aria-label="Escribe un mensaje" autocomplete="off" maxlength="4000"><button class="send-button" type="submit" aria-label="Enviar mensaje" disabled>${icon('arrow')}</button></form><div class="composer-note"><span>${icon('lock')}Tu espacio para conectar.</span><span>Enter para enviar</span></div></footer>
    </section>
  </section>
  <dialog id="new-chat-dialog" class="new-chat-dialog" aria-labelledby="new-chat-title" aria-describedby="new-chat-description">
    <div class="new-chat-heading"><h2 id="new-chat-title">Nueva conversación</h2><button id="close-new-chat" class="dialog-close" type="button" aria-label="Cerrar modal">${icon('close')}</button></div>
    <p id="new-chat-description">Escribe el username de la persona con quien quieres conversar.</p>
    <form id="new-chat" class="new-chat">
      <label for="recipient">Username del destinatario</label>
      <input id="recipient" placeholder="Ej. juan" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="recipient-hint" required autofocus>
      <p id="recipient-hint">De 1 a 50 letras, números o guiones bajos.</p>
      <button type="submit">Abrir chat ${icon('arrow')}</button>
    </form>
  </dialog>`;
const welcome = document.querySelector<HTMLElement>('.welcome')!;
const messenger = document.querySelector<HTMLElement>('.messenger')!;
const newChatDialog = document.querySelector<HTMLDialogElement>('#new-chat-dialog')!;
const newChatTrigger = document.querySelector<HTMLButtonElement>('#open-new-chat')!;
const recipientField = document.querySelector<HTMLInputElement>('#recipient')!;
newChatTrigger.addEventListener('click', () => {
  closeProfileMenu();
  recipientField.setCustomValidity('');
  newChatDialog.showModal();
  recipientField.focus();
});
document.querySelector('#close-new-chat')!.addEventListener('click', () => newChatDialog.close());
newChatDialog.addEventListener('click', (event) => {
  const bounds = newChatDialog.getBoundingClientRect();
  if (event.target === newChatDialog && (event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom)) newChatDialog.close();
});

const authFeedback = document.querySelector<HTMLElement>('#auth-feedback')!;
const passwordField = document.querySelector<HTMLInputElement>('#password')!;
const authSubmit = document.querySelector<HTMLButtonElement>('.enter-chat')!;
const authSwitch = document.querySelector<HTMLAnchorElement>('#auth-switch')!;
let authBusy = false;
function showAuthPage() {
  if (activeUsername) return;
  const register = location.hash === '#/registro';
  document.title = register ? 'Whatsapo · Registro' : 'Whatsapo · Iniciar sesión';
  document.querySelector('#welcome-title')!.innerHTML = register ? 'Crea tu cuenta.<br>Empieza a conversar.' : 'Qué bueno<br>verte de nuevo.';
  document.querySelector('.welcome-description')!.textContent = register
    ? 'Elige un username disponible y crea tu contraseña.' : 'Ingresa con tu username y contraseña para continuar.';
  passwordField.autocomplete = register ? 'new-password' : 'current-password';
  passwordField.value = '';
  authSubmit.innerHTML = `${register ? 'Crear cuenta' : 'Entrar al chat'} ${icon('arrow')}`;
  authSwitch.href = register ? '#/login' : '#/registro';
  authSwitch.textContent = register ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Regístrate';
  authFeedback.textContent = '';
}
window.addEventListener('hashchange', showAuthPage);
authSwitch.addEventListener('click', (event) => { if (authBusy) event.preventDefault(); });
function enterChat(name: string) {
  session++;
  activeUsername = name;
  document.querySelector<HTMLInputElement>('#username')!.value = name;
  welcome.hidden = true;
  messenger.hidden = false;
  document.title = `Whatsapo · @${name}`;
  document.querySelector('#profile-button strong')!.textContent = `@${name}`;
  search.focus();
  renderConversation();
  void refresh();
}
document.querySelector('#welcome-form')!.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (authBusy) return;
  const field = document.querySelector<HTMLInputElement>('#username')!;
  const name = normalize(field.value);
  field.setCustomValidity(validUsername(name) ? '' : 'Usa entre 1 y 50 letras (a-z), números o guiones bajos.');
  if (!field.reportValidity()) return;
  const register = location.hash === '#/registro';
  authBusy = true;
  authSubmit.disabled = true;
  authFeedback.textContent = register ? 'Creando cuenta…' : 'Verificando…';
  try {
    const data = await api<{ username: string }>(`/api/auth/${register ? 'register' : 'login'}`, { username: name, password: passwordField.value });
    passwordField.value = '';
    if (register) {
      history.replaceState(null, '', '#/login');
      showAuthPage();
      field.value = data.username;
      authFeedback.textContent = 'Cuenta creada. Inicia sesión con tu contraseña.';
      passwordField.focus();
    } else {
      history.replaceState(null, '', '#/login');
      enterChat(data.username);
    }
  } catch (error) {
    authFeedback.textContent = error instanceof Error ? error.message : 'No se pudo conectar. Inténtalo de nuevo.';
  } finally {
    authBusy = false;
    authSubmit.disabled = false;
  }
});
document.querySelector('#username')!.addEventListener('input', (event) => {
  (event.target as HTMLInputElement).setCustomValidity('');
});
const profileArea = document.querySelector<HTMLElement>('.profile-area')!;
const profileButton = document.querySelector<HTMLButtonElement>('#profile-button')!;
const profileMenu = document.querySelector<HTMLElement>('#profile-menu')!;
const logout = document.querySelector<HTMLButtonElement>('#logout')!;
function closeProfileMenu(restoreFocus = false) {
  profileMenu.hidden = true;
  profileButton.setAttribute('aria-expanded', 'false');
  if (restoreFocus) profileButton.focus();
}
function openProfileMenu() {
  profileMenu.hidden = false;
  profileButton.setAttribute('aria-expanded', 'true');
  logout.focus();
}
profileButton.addEventListener('click', () => {
  if (profileMenu.hidden) openProfileMenu();
  else closeProfileMenu();
});
profileButton.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openProfileMenu();
  }
});
profileArea.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !profileMenu.hidden) {
    event.preventDefault();
    closeProfileMenu(true);
  }
});
profileArea.addEventListener('focusout', (event) => {
  if (!(event.relatedTarget instanceof Node) || !profileArea.contains(event.relatedTarget)) closeProfileMenu();
});
document.addEventListener('click', (event) => {
  if (event.target instanceof Node && !profileArea.contains(event.target)) closeProfileMenu();
});
function leaveChat() {
  if (newChatDialog.open) newChatDialog.close();
  closeProfileMenu();
  session++;
  loadVersion++;
  activeUsername = '';
  selected = '';
  contacts = [];
  messages = [];
  drafts.clear();
  uploadRequest?.abort();
  uploadRequest = undefined;
  uploadConversation = uploadProgress = '';
  for (const name of uploadPreviews.keys()) clearAttachment(name);
  uploadedFiles.clear();
  uploadErrors.clear();
  loading = sending = refreshing = false;
  loadError = sendError = '';
  search.value = '';
  document.querySelector<HTMLInputElement>('#recipient')!.value = '';
  document.querySelector('#contacts-status')!.textContent = '';
  document.querySelector<HTMLButtonElement>('#retry-contacts')!.hidden = true;
  renderConversation();
  messenger.hidden = true;
  welcome.hidden = false;
  app.classList.remove('chat-open');
  history.replaceState(null, '', '#/login');
  showAuthPage();
  document.querySelector<HTMLInputElement>('#username')!.focus();
}
logout.addEventListener('click', async () => {
  logout.disabled = true;
  try {
    await api('/api/auth/logout', {});
    leaveChat();
  } catch {
    closeProfileMenu();
    document.querySelector('#contacts-status')!.textContent = 'No se pudo cerrar la sesión. Reintenta cuando vuelva la conexión.';
  } finally { logout.disabled = false; }
});
const input = document.querySelector<HTMLInputElement>('#message-input')!;
const send = document.querySelector<HTMLButtonElement>('.send-button')!;
const search = document.querySelector<HTMLInputElement>('#search')!;
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!;
const attachFile = document.querySelector<HTMLButtonElement>('#attach-file')!;
attachFile.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file || !selected || !activeUsername || uploadRequest) return;
  const currentSession = session;
  const conversation = selected;
  const request = new XMLHttpRequest();
  uploadRequest = request;
  uploadConversation = conversation;
  uploadProgress = `Subiendo ${file.name}…`;
  uploadErrors.delete(conversation);
  clearAttachment(conversation);
  uploadPreviews.set(conversation, { filename: file.name, size: file.size, percent: 0,
    localUrl: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : undefined });
  request.open('POST', `${API}/api/files`);
  request.withCredentials = true;
  request.timeout = 120000;
  request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  request.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
  request.upload.addEventListener('progress', (event) => {
    if (currentSession !== session) return;
    const preview = uploadPreviews.get(conversation);
    if (preview && event.lengthComputable) preview.percent = Math.round(event.loaded / event.total * 100);
    uploadProgress = event.lengthComputable
      ? `Subiendo ${file.name} · ${Math.round(event.loaded / event.total * 100)}%`
      : `Subiendo ${file.name}…`;
    if (event.lengthComputable && event.loaded === event.total) uploadProgress = `Guardando ${file.name}…`;
    renderComposer();
  });
  request.addEventListener('load', () => {
    if (currentSession !== session) return;
    if (request.status === 401) {
      leaveChat();
      authFeedback.textContent = 'Tu sesión terminó. Vuelve a iniciar sesión.';
      return;
    }
    try {
      const data = JSON.parse(request.responseText);
      if (request.status !== 201) throw new Error(data.error || 'No se pudo guardar el archivo.');
      if (typeof data.file?.filename !== 'string' || !/^\/api\/files\/[a-f0-9-]{36}$/.test(data.file?.url)) {
        throw new Error('La API devolvió una respuesta inválida.');
      }
      uploadedFiles.set(conversation, data.file);
    } catch (error) {
      uploadErrors.set(conversation, error instanceof Error ? error.message : 'No se pudo guardar el archivo.');
    }
  });
  const failed = () => {
    if (currentSession === session) uploadErrors.set(conversation, 'No se pudo confirmar la subida. Selecciona el archivo para reintentar.');
  };
  request.addEventListener('error', failed);
  request.addEventListener('timeout', failed);
  request.addEventListener('loadend', () => {
    if (currentSession !== session) return;
    uploadRequest = undefined;
    uploadConversation = uploadProgress = '';
    renderComposer();
  });
  renderComposer();
  request.send(file);
});
let contactsSignature = '';
function renderContacts() {
  const signature = JSON.stringify([contacts, selected, search.value]);
  if (signature === contactsSignature) return;
  contactsSignature = signature;
  const nav = document.querySelector<HTMLElement>('#contacts')!;
  nav.replaceChildren();
  document.querySelector('.contact-count')!.textContent = String(contacts.length);
  const filtered = contacts.filter((contact) => contact.username.includes(normalize(search.value)));
  for (const contact of filtered) {
    const button = document.createElement('button');
    button.className = `contact ${contact.username === selected ? 'selected' : ''}`;
    button.setAttribute('aria-current', String(contact.username === selected));
    button.innerHTML = `<span class="avatar sage"></span><span class="contact-copy"><span class="contact-top"><strong></strong><time></time></span><span class="preview"></span></span>`;
    button.querySelector('.avatar')!.textContent = initials(contact.username);
    button.querySelector('strong')!.textContent = `@${contact.username}`;
    button.querySelector('time')!.textContent = contact.lastMessage ? time(contact.lastMessage.createdAt) : '';
    button.querySelector('.preview')!.textContent = contact.lastMessage ? (contact.lastMessage.text || contact.lastMessage.attachment?.filename || 'Archivo') : 'Inicia una conversación';
    button.addEventListener('click', () => openConversation(contact.username));
    nav.append(button);
  }
  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-search';
    empty.textContent = contacts.length ? 'No encontramos esa conversación.' : 'Abre un chat con el username de otra persona.';
    nav.append(empty);
  }
}
let uploadCardSignature = '';
function renderComposer() {
  const draft = drafts.get(selected) ?? '';
  if (input.value !== draft) input.value = draft;
  input.disabled = !selected || sending;
  send.disabled = !selected || sending || Boolean(uploadRequest) || (!input.value.trim() && !uploadedFiles.has(selected));
  send.setAttribute('aria-label', sending ? 'Enviando mensaje' : 'Enviar mensaje');
  document.querySelector('#send-error')!.textContent = sendError;
  attachFile.disabled = !selected || !activeUsername || sending || Boolean(uploadRequest);
  attachFile.setAttribute('aria-busy', String(Boolean(uploadRequest)));
  document.querySelector('#upload-error')!.textContent = uploadErrors.get(selected) ?? '';
  const status = document.querySelector('#upload-status')!;
  const signature = JSON.stringify([session, selected, uploadedFiles.get(selected), uploadPreviews.get(selected),
    uploadConversation === selected ? uploadProgress : '', Boolean(uploadRequest && uploadConversation === selected)]);
  if (signature === uploadCardSignature) return;
  uploadCardSignature = signature;
  status.replaceChildren();
  const preview = uploadPreviews.get(selected);
  const file = uploadedFiles.get(selected);
  if (preview || file) {
    const card = document.createElement('div');
    card.className = 'upload-card';
    const imageUrl = preview?.localUrl || (file?.previewUrl ? `${API}${file.previewUrl}` : undefined);
    if (imageUrl) {
      const image = document.createElement('img');
      image.src = imageUrl;
      image.alt = `Vista previa de ${preview?.filename || file?.filename}`;
      image.className = 'upload-thumbnail';
      card.append(image);
    } else {
      const thumbnail = document.createElement('span');
      thumbnail.className = 'upload-file-icon';
      thumbnail.innerHTML = icon('attach');
      card.append(thumbnail);
    }
    const details = document.createElement('div');
    details.className = 'upload-details';
    const title = document.createElement('strong');
    title.textContent = preview?.filename || file!.filename;
    const meta = document.createElement('span');
    meta.textContent = formatSize(preview?.size ?? file!.size);
    const label = document.createElement('span');
    const inProgress = Boolean(uploadRequest && uploadConversation === selected);
    label.textContent = inProgress ? uploadProgress : file ? 'Listo para enviar' : 'La subida falló. Vuelve a seleccionar el archivo.';
    details.append(title, meta, label);
    if (inProgress) {
      const progress = document.createElement('progress');
      progress.max = 100;
      progress.value = preview?.percent ?? 0;
      progress.setAttribute('aria-label', 'Progreso de subida');
      details.append(progress);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'upload-remove';
    remove.setAttribute('aria-label', inProgress ? 'Cancelar subida' : 'Quitar adjunto');
    remove.innerHTML = icon('close');
    const name = selected;
    remove.addEventListener('click', () => {
      if (uploadRequest && uploadConversation === name) uploadRequest.abort();
      clearAttachment(name);
      renderComposer();
    });
    card.append(details, remove);
    status.append(card);
  }
}
let renderedConversation = '';
const renderedRows = new Map<string, { signature: string; row: HTMLDivElement }>();
const renderedDividers = new Map<string, HTMLDivElement>();
function renderConversation(scrollToBottom = true) {
  document.querySelector('#contact-name')!.textContent = selected ? `@${selected}` : 'Tus conversaciones';
  document.querySelector('#contact-detail')!.textContent = selected ? 'Conversación por username' : 'Selecciona o abre un chat para empezar';
  document.querySelector('#header-avatar')!.textContent = selected ? initials(selected) : '';
  document.querySelector('#conversation-status')!.textContent = loadError || (loading ? 'Cargando mensajes…' : selected && !messages.length ? 'Aún no hay mensajes. ¡Saluda!' : '');
  document.querySelector<HTMLButtonElement>('#retry-conversation')!.hidden = !loadError;
  const container = document.querySelector('#messages')!;
  const scroll = document.querySelector('.messages-scroll')!;
  const previousScroll = scroll.scrollTop;
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  const context = JSON.stringify([session, activeUsername, selected]);
  if (context !== renderedConversation) {
    renderedConversation = context;
    renderedRows.clear();
    renderedDividers.clear();
  }
  const children: Element[] = [];
  const currentIds = new Set<string>();
  const dividerIds = new Set<string>();
  messages.forEach((message, index) => {
    const own = message.sender === activeUsername;
    if (index === 0 || date(messages[index - 1].createdAt) !== date(message.createdAt)) {
      const key = `${message.id}:${date(message.createdAt)}`;
      dividerIds.add(key);
      let divider = renderedDividers.get(key);
      if (!divider) {
        divider = document.createElement('div');
        divider.className = 'date-divider';
        const label = document.createElement('span');
        label.textContent = date(message.createdAt);
        divider.append(label);
        renderedDividers.set(key, divider);
      }
      children.push(divider);
    }
    currentIds.add(message.id);
    const signature = JSON.stringify(message);
    const existing = renderedRows.get(message.id);
    if (existing?.signature === signature) {
      children.push(existing.row);
      return;
    }
    const row = document.createElement('div');
    row.className = `message-row ${own ? 'own' : 'received'}`;
    row.innerHTML = `<span class="message-avatar sage"></span><div class="bubble"><p></p><div class="message-meta"><time></time></div></div>`;
    row.querySelector('.message-avatar')!.textContent = initials(message.sender);
    row.querySelector('p')!.textContent = message.text;
    row.querySelector('p')!.hidden = !message.text;
    const attachment = message.attachment;
    if (attachment && /^\/api\/files\/[a-f0-9-]{36}$/.test(attachment.url)) {
      const link = document.createElement('a');
      link.className = 'message-attachment';
      link.href = `${API}${attachment.url}`;
      link.setAttribute('download', attachment.filename);
      if (attachment.previewUrl && /^\/api\/files\/[a-f0-9-]{36}\/preview$/.test(attachment.previewUrl)) {
        const image = document.createElement('img');
        image.src = `${API}${attachment.previewUrl}`;
        image.crossOrigin = 'use-credentials';
        image.alt = attachment.filename;
        image.loading = 'lazy';
        image.addEventListener('load', () => { if (nearBottom || scrollToBottom) scroll.scrollTop = scroll.scrollHeight; }, { once: true });
        image.addEventListener('error', () => { image.hidden = true; }, { once: true });
        link.append(image);
      }
      const filename = document.createElement('span');
      filename.textContent = `${attachment.filename} · ${formatSize(attachment.size)} ↓`;
      link.append(filename);
      row.querySelector('.bubble')!.prepend(link);
    }
    row.querySelector('time')!.textContent = time(message.createdAt);
    row.querySelector('time')!.setAttribute('datetime', message.createdAt);
    renderedRows.set(message.id, { signature, row });
    children.push(row);
  });
  reconcileChildren(container, children);
  for (const id of renderedRows.keys()) if (!currentIds.has(id)) renderedRows.delete(id);
  for (const id of renderedDividers.keys()) if (!dividerIds.has(id)) renderedDividers.delete(id);
  renderComposer();
  renderContacts();
  scroll.scrollTop = scrollToBottom || nearBottom ? scroll.scrollHeight : previousScroll;
}
function openConversation(name: string) {
  loadVersion++;
  selected = name;
  messages = [];
  loadError = sendError = '';
  loading = true;
  if (!contacts.some((contact) => contact.username === name)) contacts.push({ username: name });
  app.classList.add('chat-open');
  renderConversation();
  void loadConversation(true);
}
async function loadConversation(scrollToBottom = false) {
  const name = selected;
  const owner = activeUsername;
  if (!name || !owner || sending) return;
  const currentSession = session;
  const version = ++loadVersion;
  try {
    const data = await api<{ messages: Message[] }>(`/api/conversations/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    if (currentSession !== session || version !== loadVersion) return;
    messages = data.messages;
    const contact = contacts.find((contact) => contact.username === name);
    if (contact) contact.lastMessage = messages.at(-1);
    loadError = '';
    setConnection(true);
  } catch {
    if (currentSession !== session || version !== loadVersion) return;
    loadError = 'No se pudieron cargar los mensajes. Reintenta la conexión.';
    setConnection(false);
  } finally {
    if (currentSession === session && version === loadVersion) {
      loading = false;
      renderConversation(scrollToBottom);
    }
  }
}
function setConnection(connected: boolean) {
  document.querySelector('#api-status')!.textContent = connected ? 'Conectado' : 'Sin conexión · reintentando';
  document.querySelector('.connection-dot')!.classList.toggle('connected', connected);
}
async function refresh() {
  if (!activeUsername || refreshing) return;
  refreshing = true;
  const currentSession = session;
  try {
    const data = await api<{ conversations: Contact[] }>(`/api/conversations/${encodeURIComponent(activeUsername)}`);
    if (currentSession !== session) return;
    const known = new Set(data.conversations.map((contact) => contact.username));
    contacts = [...data.conversations, ...contacts.filter((contact) => !known.has(contact.username))];
    document.querySelector('#contacts-status')!.textContent = '';
    document.querySelector<HTMLButtonElement>('#retry-contacts')!.hidden = true;
    setConnection(true);
    renderContacts();
  } catch {
    if (currentSession !== session) return;
    document.querySelector('#contacts-status')!.textContent = 'No se pudieron cargar tus conversaciones.';
    document.querySelector<HTMLButtonElement>('#retry-contacts')!.hidden = false;
    setConnection(false);
  } finally {
    if (currentSession === session) refreshing = false;
  }
  if (currentSession === session && !loading && !sending) await loadConversation();
}
search.addEventListener('input', renderContacts);
input.addEventListener('input', () => {
  drafts.set(selected, input.value);
  renderComposer();
});
document.querySelector('#new-chat')!.addEventListener('submit', (event) => {
  event.preventDefault();
  const field = document.querySelector<HTMLInputElement>('#recipient')!;
  const name = normalize(field.value);
  field.setCustomValidity(!validUsername(name) ? 'Usa entre 1 y 50 letras (a-z), números o guiones bajos.' : name === activeUsername ? 'Elige el username de otra persona.' : '');
  if (!field.reportValidity()) return;
  search.value = '';
  field.value = '';
  newChatDialog.close();
  openConversation(name);
  input.focus();
});
document.querySelector('#recipient')!.addEventListener('input', (event) => (event.target as HTMLInputElement).setCustomValidity(''));
document.querySelector('#retry-contacts')!.addEventListener('click', () => void refresh());
document.querySelector('#retry-conversation')!.addEventListener('click', () => void loadConversation());
document.querySelector('#composer')!.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  const recipient = selected;
  const sender = activeUsername;
  const attachment = uploadedFiles.get(recipient);
  if ((!text && !attachment) || !recipient || !sender || sending || uploadRequest) return;
  const currentSession = session;
  sending = true;
  loading = false;
  loadVersion++;
  sendError = '';
  renderComposer();
  try {
    const result = await api<{ message: Message }>('/api/messages', { sender, recipient, text, attachmentId: attachment?.id });
    if (currentSession !== session) return;
    drafts.delete(recipient);
    clearAttachment(recipient);
    const contact = contacts.find((contact) => contact.username === recipient);
    if (contact) contact.lastMessage = result.message;
    if (selected === recipient && !messages.some((message) => message.id === result.message.id)) messages.push(result.message);
    setConnection(true);
  } catch (error) {
    if (currentSession !== session) return;
    sendError = `${error instanceof Error ? error.message : 'No se pudo confirmar el envío'}. Conservamos tu borrador.`;
    setConnection(false);
  } finally {
    if (currentSession === session) {
      sending = false;
      renderConversation(selected === recipient);
      if (selected === recipient) input.focus();
      void loadConversation(selected === recipient);
    }
  }
});
document.querySelector('.back-button')!.addEventListener('click', () => app.classList.remove('chat-open'));
document.addEventListener('keydown', (event) => {
  if (!messenger.hidden && !newChatDialog.open && (event.metaKey || event.ctrlKey) && event.key === 'k') {
    event.preventDefault(); app.classList.remove('chat-open'); search.focus();
  }
});
setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
renderConversation();

// El username antiguo ya no concede acceso; la cookie HttpOnly identifica la sesión.
try { localStorage.removeItem('whatsapo.username'); } catch { /* Almacenamiento no disponible. */ }
showAuthPage();
async function restoreSession() {
  authBusy = true;
  authSubmit.disabled = true;
  try {
    const data = await api<{ username: string }>('/api/auth/me');
    enterChat(data.username);
  } catch {
    // Permite iniciar sesión o registrarse si no hay una sesión vigente.
  } finally {
    authBusy = false;
    authSubmit.disabled = false;
  }
}
void restoreSession();
