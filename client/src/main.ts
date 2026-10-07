import './style.css';

const icons = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 11h8M8 15h5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  check: '<path d="m3 12 4 4L17 6m-6 10L21 6"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  lock: '<rect x="6" y="10" width="12" height="10" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
};
const icon = (name: keyof typeof icons) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
type Message = { id: string; sender: string; recipient: string; text: string; createdAt: string };
type Contact = { username: string; lastMessage?: Message };
const API = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:3000';
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
const drafts = new Map<string, string>();
const normalize = (value: string) => value.trim().toLowerCase();
const validUsername = (value: string) => /^[a-z0-9_]{1,50}$/.test(value);
const initials = (value: string) => value.slice(0, 2).toUpperCase();
const time = (value: string) => new Date(value).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false });
const date = (value: string) => new Date(value).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'No se pudo completar la petición');
  return data as T;
}
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <section class="welcome" aria-labelledby="welcome-title">
    <div class="welcome-card">
      <div class="welcome-brand"><img src="/whatsapo.jpeg" alt="Logo de Whatsapo" width="80" height="80"><span>whatsapo<span class="brand-dot">.</span></span></div>
      <p class="welcome-eyebrow">TU ESPACIO PARA CONECTAR</p>
      <h1 id="welcome-title">Todo empieza<br>con tu nombre.</h1>
      <p class="welcome-description">Elige tu username. Será tu identificador único para que otros puedan encontrarte.</p>
      <form id="welcome-form">
        <label for="username">Username</label>
        <div class="username-field"><span aria-hidden="true">@</span><input id="username" name="username" type="text" placeholder="tu_username" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="username-hint"></div>
        <p id="username-hint">Usa de 1 a 50 letras, números o guiones bajos.</p>
        <button class="enter-chat" type="submit">Entrar al chat ${icon('arrow')}</button>
      </form>
      <p class="welcome-signoff">Las buenas conversaciones empiezan aquí.</p>
    </div>
  </section>
  <section class="messenger" aria-label="Whatsapo, mensajería" hidden>
    <aside class="sidebar">
      <a class="brand" href="./" aria-label="Whatsapo, inicio"><img class="brand-logo" src="/whatsapo.jpeg" alt="" width="48" height="48">whatsapo<span class="brand-dot">.</span></a>
      <div class="sidebar-heading"><h1>Mensajes</h1><span class="contact-count">0</span></div>
      <label class="search">${icon('search')}<input id="search" type="search" placeholder="Buscar una conversación" aria-label="Buscar una conversación" autocomplete="off"><kbd>⌘ K</kbd></label>
      <form id="new-chat" class="new-chat"><input id="recipient" aria-label="Username del destinatario" placeholder="Username del destinatario" autocomplete="off" autocapitalize="none" spellcheck="false" required><button type="submit">Abrir chat</button></form>
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
      <footer class="composer-area"><p id="send-error" role="alert"></p><form id="composer"><input id="message-input" placeholder="Escribe un mensaje…" aria-label="Escribe un mensaje" autocomplete="off" maxlength="4000"><button class="send-button" type="submit" aria-label="Enviar mensaje" disabled>${icon('arrow')}</button></form><div class="composer-note"><span>${icon('lock')}Tu espacio para conectar.</span><span>Enter para enviar</span></div></footer>
    </section>
  </section>`;
const welcome = document.querySelector<HTMLElement>('.welcome')!;
const messenger = document.querySelector<HTMLElement>('.messenger')!;
document.title = 'Whatsapo · Bienvenido';
document.querySelector('#welcome-form')!.addEventListener('submit', (event) => {
  event.preventDefault();
  const field = document.querySelector<HTMLInputElement>('#username')!;
  const name = normalize(field.value);
  field.setCustomValidity(validUsername(name) ? '' : 'Usa entre 1 y 50 letras (a-z), números o guiones bajos.');
  if (!field.reportValidity()) return;
  session++;
  activeUsername = name;
  field.value = name;
  welcome.hidden = true;
  messenger.hidden = false;
  document.title = `Whatsapo · @${name}`;
  document.querySelector('#profile-button strong')!.textContent = `@${name}`;
  search.focus();
  renderConversation();
  void refresh();
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
logout.addEventListener('click', () => {
  closeProfileMenu();
  session++;
  loadVersion++;
  activeUsername = '';
  selected = '';
  contacts = [];
  messages = [];
  drafts.clear();
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
  document.title = 'Whatsapo · Bienvenido';
  document.querySelector<HTMLInputElement>('#username')!.focus();
});
const input = document.querySelector<HTMLInputElement>('#message-input')!;
const send = document.querySelector<HTMLButtonElement>('.send-button')!;
const search = document.querySelector<HTMLInputElement>('#search')!;
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
    button.querySelector('.preview')!.textContent = contact.lastMessage?.text ?? 'Inicia una conversación';
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
function renderComposer() {
  const draft = drafts.get(selected) ?? '';
  if (input.value !== draft) input.value = draft;
  input.disabled = !selected || sending;
  send.disabled = !selected || sending || !input.value.trim();
  send.setAttribute('aria-label', sending ? 'Enviando mensaje' : 'Enviar mensaje');
  document.querySelector('#send-error')!.textContent = sendError;
}
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
  container.replaceChildren();
  messages.forEach((message, index) => {
    const own = message.sender === activeUsername;
    if (index === 0 || date(messages[index - 1].createdAt) !== date(message.createdAt)) {
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      const label = document.createElement('span');
      label.textContent = date(message.createdAt);
      divider.append(label);
      container.append(divider);
    }
    const row = document.createElement('div');
    row.className = `message-row ${own ? 'own' : 'received'}`;
    row.innerHTML = `<span class="message-avatar sage"></span><div class="bubble"><p></p><div class="message-meta"><time></time></div></div>`;
    row.querySelector('.message-avatar')!.textContent = initials(message.sender);
    row.querySelector('p')!.textContent = message.text;
    row.querySelector('time')!.textContent = time(message.createdAt);
    row.querySelector('time')!.setAttribute('datetime', message.createdAt);
    container.append(row);
  });
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
  send.disabled = sending || !selected || !input.value.trim();
});
document.querySelector('#new-chat')!.addEventListener('submit', (event) => {
  event.preventDefault();
  const field = document.querySelector<HTMLInputElement>('#recipient')!;
  const name = normalize(field.value);
  field.setCustomValidity(!validUsername(name) ? 'Usa entre 1 y 50 letras (a-z), números o guiones bajos.' : name === activeUsername ? 'Elige el username de otra persona.' : '');
  if (!field.reportValidity()) return;
  search.value = '';
  field.value = '';
  openConversation(name);
});
document.querySelector('#recipient')!.addEventListener('input', (event) => (event.target as HTMLInputElement).setCustomValidity(''));
document.querySelector('#retry-contacts')!.addEventListener('click', () => void refresh());
document.querySelector('#retry-conversation')!.addEventListener('click', () => void loadConversation());
document.querySelector('#composer')!.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  const recipient = selected;
  const sender = activeUsername;
  if (!text || !recipient || !sender || sending) return;
  const currentSession = session;
  sending = true;
  loading = false;
  loadVersion++;
  sendError = '';
  renderComposer();
  try {
    const result = await api<{ message: Message }>('/api/messages', { sender, recipient, text });
    if (currentSession !== session) return;
    drafts.delete(recipient);
    const contact = contacts.find((contact) => contact.username === recipient);
    if (contact) contact.lastMessage = result.message;
    if (selected === recipient && !messages.some((message) => message.id === result.message.id)) messages.push(result.message);
    setConnection(true);
  } catch {
    if (currentSession !== session) return;
    sendError = 'No se pudo confirmar el envío. Conservamos tu borrador; revisa el historial antes de reintentar.';
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
  if (!messenger.hidden && (event.metaKey || event.ctrlKey) && event.key === 'k') {
    event.preventDefault(); app.classList.remove('chat-open'); search.focus();
  }
});
setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
renderConversation();
