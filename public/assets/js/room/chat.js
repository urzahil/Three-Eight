// Text chat over the data channels, and the system lines in the chat log.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { $, toast, randomId, linkify } from './util.js';

const MAX_CHAT = 500;

export class Chat {
  _initChat() {
    $('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = $('chat-input').value.trim();
      if (!text) return;
      $('chat-input').value = '';
      const msg = { id: randomId(), from: this.id, name: this.name, text: text.slice(0, 2000), ts: this.signaling.now() };
      this._addChat(msg);
      this.mesh.broadcast({ type: 'chat', msg });
    });
    this.mesh.addEventListener('message', (e) => {
      const { peer, msg } = e.detail;
      if (msg.type === 'chat' && msg.msg) this._addChat(this._cleanChat(msg.msg, peer));
      if (msg.type === 'chat-history' && Array.isArray(msg.messages)) {
        for (const m of msg.messages.slice(-100)) this._addChat(this._cleanChat(m, null), true);
      }
    });
  }

  /** A chat message from the network, made safe to show. One without text is dropped by _addChat(). */
  _cleanChat(m, peer) {
    if (!m || typeof m !== 'object') return { id: '', text: '' };
    const ts = Number(m.ts);
    // History is relayed by a peer who could write anything: it never counts as one of my own messages.
    const from = peer ? peer.id : String(m.from || '').slice(0, 64);
    return {
      id: String(m.id || randomId()).slice(0, 40),
      from: !peer && from === this.id ? '' : from,
      name: String((peer ? this.profileOf(peer.id).name : m.name) || 'Guest').slice(0, 40),
      text: String(m.text || '').slice(0, 2000),
      ts: Number.isFinite(ts) && ts > 0 && ts < 8.64e15 ? ts : this.signaling.now(),
    };
  }

  _addChat(m, quiet = false) {
    if (!m.text || this.chatIds.has(m.id)) return;
    // A full log keeps the newest messages: older history (replayed by a peer) has no place in it.
    if (this.chat.length >= MAX_CHAT && m.ts < this.chat[0].ts) return;
    this.chatIds.add(m.id);
    this.chat.push(m);
    this.chat.sort((a, b) => a.ts - b.ts);
    const log = $('chat-log');
    let evictedSelf = false;
    while (this.chat.length > MAX_CHAT) {
      const old = this.chat.shift();
      this.chatIds.delete(old.id);
      if (old === m) evictedSelf = true;
      else log.querySelector(`.msg[data-id="${CSS.escape(old.id)}"]`)?.remove();
    }
    if (evictedSelf) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const el = document.createElement('div');
    el.className = 'msg';
    el.dataset.ts = m.ts;
    el.dataset.id = m.id;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = m.from === this.id ? 'You' : m.name;
    meta.append(b, new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const body = document.createElement('div');
    body.className = 'body';
    linkify(m.text, body);
    el.append(meta, body);
    // Insert in timestamp order (history may arrive late).
    const after = [...log.children].reverse().find((c) => Number(c.dataset.ts || 0) <= m.ts);
    if (after) after.after(el);
    else log.prepend(el);
    if (atBottom || m.from === this.id) log.scrollTop = log.scrollHeight;
    const visible = !$('sidebar').hidden && this.tab === 'chat';
    if (!visible && m.from !== this.id && !quiet) {
      this.unread++;
      $('chat-badge').textContent = this.unread > 9 ? '9+' : this.unread;
      $('chat-badge').hidden = false;
      toast(`${m.name}: ${m.text.slice(0, 80)}`);
    }
  }

  _systemMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg system';
    el.dataset.ts = this.signaling.now();
    el.textContent = text;
    $('chat-log').appendChild(el);
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
  }
}
