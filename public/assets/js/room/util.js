// Helpers shared by the lobby and the parts of the room (see room/*.js).

// While the movie is in a Document Picture-in-Picture window, its controls live in that document:
// `$` looks there too. Set and cleared by room/pip.js.
export const pipState = { window: null, document: null };
export const $ = (id) => document.getElementById(id) || pipState.document?.getElementById(id);
export const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem('te.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem('te.' + k);
      else localStorage.setItem('te.' + k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

export function show(screen) {
  for (const id of ['landing', 'lobby', 'message', 'room']) $(id).hidden = id !== screen;
}

export function showMessage(title, text) {
  $('message-title').textContent = title;
  $('message-text').textContent = text;
  show('message');
}

export function toast(text, kind = '', ms = 0) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms || (kind === 'warn' ? 6000 : 3500));
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

export function setIcon(btn, name) {
  btn.querySelector('use').setAttribute('href', '#i-' + name);
}

export function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i >= 3 ? 2 : i ? 1 : 0)} ${u[i]}`;
}

export function colorFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(--avatar-${(h % 10) + 1})`; // palette lives in style.css (:root)
}
export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function randomId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

/** 32 characters of base64url (192 random bits): a secret, unlike randomId() which is shown to others. */
export function randomSecret() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashText(text) {
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16) + text.length.toString(16);
  }
}

export function linkify(text, parent) {
  const re = /\bhttps?:\/\/[^\s<>"']+/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    parent.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.href = m[0];
    a.textContent = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    parent.append(a);
    last = re.lastIndex;
  }
  parent.append(text.slice(last));
}

/** Copy the methods of `Source` (a class) onto the prototype of `Target`: how room/*.js join the Room. */
export function mixin(Target, Source) {
  for (const key of Reflect.ownKeys(Source.prototype)) {
    if (key === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(Target.prototype, key)) throw new Error(`Room method ${String(key)} is defined twice`);
    Object.defineProperty(Target.prototype, key, Object.getOwnPropertyDescriptor(Source.prototype, key));
  }
}
