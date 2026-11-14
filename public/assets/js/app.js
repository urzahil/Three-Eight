import { Signaling } from './signaling.js';
import { Mesh } from './mesh.js';
import { MovieSync, sameMovie } from './sync.js';
import { MoviePlayer } from './player/player.js';
import { CompactPip } from './player/compactpip.js';
import { LocalMedia, watchLevel, audioContext } from './media.js';
import { DriveClient, pickSubtitle, subtitleMatches } from './drive.js';

// While the movie is in a Document Picture-in-Picture window, its controls live in that document.
let pipWindow = null;
let pipDocument = null;
const $ = (id) => document.getElementById(id) || pipDocument?.getElementById(id);
const store = {
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

function show(screen) {
  for (const id of ['landing', 'lobby', 'message', 'room']) $(id).hidden = id !== screen;
}

function showMessage(title, text) {
  $('message-title').textContent = title;
  $('message-text').textContent = text;
  show('message');
}

function toast(text, kind = '', ms = 0) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms || (kind === 'warn' ? 6000 : 3500));
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

function setIcon(btn, name) {
  btn.querySelector('use').setAttribute('href', '#i-' + name);
}

function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i >= 3 ? 2 : i ? 1 : 0)} ${u[i]}`;
}

function colorFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(--avatar-${(h % 10) + 1})`; // palette lives in style.css (:root)
}
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function randomId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

async function hashText(text) {
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16) + text.length.toString(16);
  }
}

function linkify(text, parent) {
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

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
const roomName = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ''));

if (!roomName) {
  show('landing');
  $('landing-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const r = $('landing-room').value.trim();
    if (r) location.href = '/' + encodeURIComponent(r);
  });
} else {
  startLobby(roomName).catch((err) => {
    console.error(err);
    showMessage('Something went wrong', err.message || String(err));
  });
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
async function startLobby(room) {
  const res = await fetch('/api/rooms/' + encodeURIComponent(room));
  if (res.status === 404) {
    showMessage('Room not found', `There is no room called “${room}”. Check the link with whoever invited you.`);
    return;
  }
  if (!res.ok) throw new Error('Server error');
  const info = await res.json();
  document.title = `${info.name} · Three-Eight`;
  $('lobby-room-name').textContent = info.name;
  $('lobby-name').value = store.get('name', '');
  const pwKey = 'pw.' + info.name.toLowerCase();
  $('lobby-password-wrap').hidden = !info.passwordRequired;
  $('lobby-remember-wrap').hidden = !info.passwordRequired;
  const savedPw = store.get(pwKey, '');
  $('lobby-password').value = savedPw;
  $('lobby-remember').checked = !!savedPw;
  $('lobby-password').required = info.passwordRequired;
  show('lobby');
  (store.get('name') ? (info.passwordRequired && !savedPw ? $('lobby-password') : $('lobby-join')) : $('lobby-name')).focus();

  const media = new LocalMedia({ ...store.get('media', {}), processing: store.get('processing', true) });
  const preview = $('lobby-video');
  let stopMeter = () => {};
  const refreshPreview = () => {
    preview.srcObject = media.videoTrack ? new MediaStream([media.videoTrack]) : null;
    preview.hidden = !media.videoTrack;
    $('lobby-avatar').hidden = !!media.videoTrack;
    $('lobby-avatar').textContent = initials($('lobby-name').value || '?');
    $('lobby-avatar').style.background = colorFor($('lobby-name').value || 'x');
    $('lobby-mic').classList.toggle('off', !media.micOn || !media.audioTrack);
    setIcon($('lobby-mic'), media.micOn && media.audioTrack ? 'mic' : 'mic-off');
    $('lobby-cam').classList.toggle('off', !media.camOn);
    setIcon($('lobby-cam'), media.camOn ? 'cam' : 'cam-off');
    stopMeter();
    stopMeter = watchLevel(media.audioTrack, (l) => {
      $('lobby-meter').style.height = media.micOn ? `${Math.round(l * 100)}%` : '0';
    });
  };
  media.addEventListener('change', refreshPreview);
  $('lobby-name').addEventListener('input', refreshPreview);
  await media.init();
  refreshPreview();
  if (media.errors.audio || media.errors.video) {
    const e = media.errors.audio || media.errors.video;
    if (e.name === 'NotAllowedError') toast('Camera/microphone access was blocked. You can still join and watch.', 'warn');
    else if (e.name === 'NotSupportedError') toast(e.message, 'warn');
  }
  const fillDevices = async () => {
    const d = await media.devices();
    for (const kind of ['audio', 'video']) {
      const sel = $(`lobby-${kind}-dev`);
      sel.replaceChildren(...d[kind].map((dev, i) => new Option(dev.label || `${kind === 'audio' ? 'Microphone' : 'Camera'} ${i + 1}`, dev.deviceId)));
      sel.value = media.currentDeviceId(kind);
    }
  };
  fillDevices();
  $('lobby-audio-dev').onchange = (e) => media.setDevice('audio', e.target.value);
  $('lobby-video-dev').onchange = (e) => media.setDevice('video', e.target.value);
  $('lobby-mic').onclick = () => media.setMic(!media.micOn);
  $('lobby-cam').onclick = async () => {
    const ok = await media.setCam(!media.camOn);
    if (!ok) toast('Could not start the camera.', 'warn');
    fillDevices();
  };

  $('lobby-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('lobby-name').value.trim().slice(0, 40);
    if (!name) return;
    store.set('name', name);
    $('lobby-error').hidden = true;
    $('lobby-join').disabled = true;
    $('lobby-join').textContent = 'Joining…';
    audioContext(); // unlock audio during the click
    const password = $('lobby-password').value;
    try {
      const cfg = await (await fetch('/api/config')).json();
      const id = sessionStorage.getItem('te.id') || randomId();
      sessionStorage.setItem('te.id', id);
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const signaling = new Signaling(`${proto}//${location.host}/ws`);
      const welcome = await signaling.join({ room: info.name, id, name, password });
      store.set(pwKey, $('lobby-remember').checked && password ? password : null);
      store.set('media', { mic: media.micOn, cam: media.camOn, audioDevice: media.deviceIds.audio, videoDevice: media.deviceIds.video });
      stopMeter();
      media.removeEventListener('change', refreshPreview);
      preview.srcObject = null;
      new Room({ signaling, welcome, media, name, id, iceServers: cfg.iceServers, roomName: welcome.room || info.name });
    } catch (err) {
      $('lobby-error').textContent = err.message || 'Could not join the room.';
      $('lobby-error').hidden = false;
      $('lobby-join').disabled = false;
      $('lobby-join').textContent = 'Join room';
      if (err.code === 'bad-password') {
        $('lobby-password').select();
        store.set(pwKey, null);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------
class Room {
  constructor({ signaling, welcome, media, name, id, iceServers, roomName }) {
    this.signaling = signaling;
    this.media = media;
    this.name = name;
    this.id = id;
    this.roomName = roomName;
    this.tiles = new Map();
    this.profiles = new Map(); // peerId -> {name, audio, video}
    this.chat = [];
    this.chatIds = new Set();
    this.unread = 0;
    this._mediaSession = false; // handlers registered for the loaded movie

    this.mesh = new Mesh(signaling, id, iceServers);
    this.mesh.setTrack('audio', media.audioTrack);
    this.mesh.setTrack('video', media.videoTrack);
    this.player = new MoviePlayer($('movie'), $('subs-layer'));
    this.player.video.volume = store.get('movieVolume', 1);
    this.sync = new MovieSync({ mesh: this.mesh, signaling, player: this.player, selfId: id });
    this.drive = null; // DriveClient when the admin attached a Google Drive folder to this room
    this.driveKey = '';
    this._driveToken = 0;
    this._setDrive(welcome.drive);

    if (new URLSearchParams(location.search).has('debug')) window.room = this;
    document.title = `${roomName} · Three-Eight`;
    $('room-title').textContent = roomName;
    show('room');

    this._initTiles();
    this._initToolbar();
    this._initChat();
    this._initMovie();
    this._initPip();
    this._initSettings();
    this._initKeyboard();

    for (const p of welcome.peers) {
      this.profiles.set(p.id, { name: p.name, audio: false, video: false });
      this.mesh.addPeer(p.id, p.name);
    }

    signaling.addEventListener('disconnected', () => this._setConn('Reconnecting to server…'));
    signaling.addEventListener('reconnected', (e) => {
      this._setConn('');
      this._setDrive(e.detail?.drive); // the admin may have changed it while we were away
    });
    signaling.addEventListener('drive', (e) => this._setDrive(e.detail));
    signaling.addEventListener('fatal', (e) => {
      this.leave(false);
      showMessage('Disconnected', e.detail.message || 'You were disconnected from the room.');
    });
    window.addEventListener('pagehide', () => this.leave(false));
    this._wakeLock();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._wakeLock();
    });
    this.initialized = true;
    if (!welcome.peers.length) this._systemMessage('You are the first one here. Click “Invite” to copy the room link.');
  }

  async _wakeLock() {
    try {
      this.lock = await navigator.wakeLock?.request('screen');
    } catch {
      /* not supported */
    }
  }

  _setConn(text) {
    $('conn-status').textContent = text;
    $('conn-status').hidden = !text;
  }

  profileOf(peerId) {
    if (peerId === this.id) return { name: this.name, audio: this.media.micOn && !!this.media.audioTrack, video: !!this.media.videoTrack };
    return this.profiles.get(peerId) || { name: this.mesh.peers.get(peerId)?.name || 'Guest', audio: false, video: false };
  }

  _broadcastProfile(peer) {
    const msg = { type: 'profile', name: this.name, audio: this.media.micOn && !!this.media.audioTrack, video: !!this.media.videoTrack };
    if (peer) peer.send(msg);
    else this.mesh.broadcast(msg);
  }

  // ---- video tiles -------------------------------------------------------------
  _initTiles() {
    const self = this._makeTile(this.id, true);
    self.video.muted = true;
    this._refreshSelfTile();
    this.media.addEventListener('change', async (e) => {
      const kind = e.detail.kind;
      await this.mesh.setTrack(kind, kind === 'audio' ? this.media.audioTrack : this.media.videoTrack);
      this._refreshSelfTile();
      this._broadcastProfile();
      this._refreshToolbar();
      this._renderPeople();
    });

    this.mesh.addEventListener('peer-added', (e) => {
      const peer = e.detail.peer;
      if (!this.profiles.has(peer.id)) this.profiles.set(peer.id, { name: peer.name || 'Guest', audio: false, video: false });
      this._makeTile(peer.id, false);
      this._updateTile(peer.id);
      this._renderPeople();
    });
    this.mesh.addEventListener('peer-removed', (e) => {
      const peer = e.detail.peer;
      const t = this.tiles.get(peer.id);
      t?.stopLevel?.();
      t?.el.remove();
      this.tiles.delete(peer.id);
      const prof = this.profiles.get(peer.id);
      this._systemMessage(`${prof?.name || 'Someone'} left`);
      this.profiles.delete(peer.id);
      this._layout();
      this._renderPeople();
    });
    this.mesh.addEventListener('track', (e) => {
      const peer = e.detail.peer;
      const t = this.tiles.get(peer.id);
      if (!t) return;
      t.video.srcObject = peer.stream;
      t.video.play().catch(() => {});
      const at = peer.stream.getAudioTracks()[0];
      if (at && t.levelTrack !== at) {
        t.stopLevel?.();
        t.levelTrack = at;
        t.stopLevel = watchLevel(at, (l) => t.el.classList.toggle('speaking', l > 0.08 && this.profileOf(peer.id).audio));
      }
    });
    this.mesh.addEventListener('channel-open', (e) => {
      const peer = e.detail.peer;
      this._broadcastProfile(peer);
      if (this.chat.length) peer.send({ type: 'chat-history', messages: this.chat.slice(-100) });
    });
    this.mesh.addEventListener('peer-state', (e) => {
      const t = this.tiles.get(e.detail.peer.id);
      if (!t) return;
      const s = e.detail.state;
      t.state.textContent = s === 'connected' ? '' : s === 'failed' ? 'connection failed' : s === 'new' || s === 'connecting' ? 'connecting…' : s;
      t.state.hidden = !t.state.textContent;
      if (s === 'failed') toast(`Can't reach ${this.profileOf(e.detail.peer.id).name} directly. A TURN server may be needed (see README).`, 'warn');
    });
    this.mesh.addEventListener('message', (e) => {
      const { peer, msg } = e.detail;
      if (msg.type === 'profile') {
        const prev = this.profiles.get(peer.id);
        const name = String(msg.name || 'Guest').slice(0, 40);
        const first = !prev || !prev.seen;
        this.profiles.set(peer.id, { name, audio: !!msg.audio, video: !!msg.video, seen: true });
        if (first) this._systemMessage(`${name} joined`);
        this._updateTile(peer.id);
        this._renderPeople();
      }
    });
    new ResizeObserver(() => this._layout()).observe($('grid'));
    this._layout();
  }

  _makeTile(id, self) {
    const el = document.createElement('div');
    el.className = 'tile' + (self ? ' self' : '');
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    const label = document.createElement('div');
    label.className = 'label';
    const micIcon = icon('mic-off');
    const nameEl = document.createElement('span');
    label.append(micIcon, nameEl);
    const state = document.createElement('div');
    state.className = 'state';
    state.hidden = true;
    if (!self) {
      state.textContent = 'connecting…';
      state.hidden = false;
    }
    el.append(video, avatar, label, state);
    $('grid').appendChild(el);
    const tile = { el, video, avatar, nameEl, micIcon, state };
    this.tiles.set(id, tile);
    this._layout();
    return tile;
  }

  _refreshSelfTile() {
    const t = this.tiles.get(this.id);
    t.video.srcObject = this.media.videoTrack ? new MediaStream([this.media.videoTrack]) : null;
    this._updateTile(this.id);
    if (this.media.audioTrack !== t.levelTrack) {
      t.stopLevel?.();
      t.levelTrack = this.media.audioTrack;
      t.stopLevel = watchLevel(this.media.audioTrack, (l) => t.el.classList.toggle('speaking', l > 0.08 && this.media.micOn));
    }
  }

  _updateTile(id) {
    const t = this.tiles.get(id);
    if (!t) return;
    const p = this.profileOf(id);
    t.nameEl.textContent = id === this.id ? `${p.name} (you)` : p.name;
    t.avatar.textContent = initials(p.name);
    t.avatar.style.background = colorFor(id);
    t.el.classList.toggle('no-video', !p.video);
    t.micIcon.style.display = p.audio ? 'none' : '';
  }

  _layout() {
    const grid = $('grid');
    const n = this.tiles.size;
    if ($('main').classList.contains('watching')) {
      grid.style.removeProperty('--cols');
      return;
    }
    const W = grid.clientWidth || 1, H = grid.clientHeight || 1;
    let best = 1, bestSize = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min(W / cols, ((H / rows) * 16) / 9);
      if (w > bestSize) { bestSize = w; best = cols; }
    }
    grid.style.setProperty('--cols', best);
  }

  // ---- toolbar -------------------------------------------------------------------
  _initToolbar() {
    $('t-mic').onclick = () => this.toggleMic();
    $('t-cam').onclick = () => this.toggleCam();
    $('t-chat').onclick = () => this.toggleSidebar('chat');
    $('t-movie').onclick = () => this.openMovieDialog();
    $('t-settings').onclick = () => this.openSettings();
    $('t-leave').onclick = () => {
      this.leave(true);
      showMessage('You left the room', 'Thanks for hanging out!');
      const again = document.createElement('a');
      again.className = 'btn primary';
      again.href = location.pathname;
      again.textContent = 'Rejoin';
      $('message-text').after(again);
    };
    $('copy-link').onclick = async () => {
      const url = location.origin + '/' + encodeURIComponent(this.roomName);
      try {
        await navigator.clipboard.writeText(url);
        toast('Room link copied. Share the password separately.');
      } catch {
        prompt('Room link', url);
      }
    };
    $('sidebar-close').onclick = () => this.toggleSidebar(null);
    for (const tab of document.querySelectorAll('.tab')) tab.onclick = () => this._selectTab(tab.dataset.tab);
    this._refreshToolbar();
  }

  _refreshToolbar() {
    const micOn = this.media.micOn && !!this.media.audioTrack;
    $('t-mic').classList.toggle('off', !micOn);
    setIcon($('t-mic'), micOn ? 'mic' : 'mic-off');
    $('t-mic').querySelector('span').textContent = micOn ? 'Mute' : 'Unmute';
    const camOn = !!this.media.videoTrack;
    $('t-cam').classList.toggle('off', !camOn);
    setIcon($('t-cam'), camOn ? 'cam' : 'cam-off');
    $('t-cam').querySelector('span').textContent = camOn ? 'Stop video' : 'Start video';
    $('t-chat').classList.toggle('active', !$('sidebar').hidden);
    $('t-movie').classList.toggle('active', !$('stage').hidden);
  }

  async toggleMic() {
    const ok = await this.media.setMic(!this.media.micOn);
    if (!ok) toast('Could not access a microphone.', 'warn');
    store.set('media', { ...store.get('media', {}), mic: this.media.micOn });
  }

  async toggleCam() {
    const ok = await this.media.setCam(!this.media.camOn);
    if (!ok) toast('Could not start the camera.', 'warn');
    store.set('media', { ...store.get('media', {}), cam: this.media.camOn });
  }

  toggleSidebar(tab) {
    const sb = $('sidebar');
    if (!tab || (!sb.hidden && this.tab === tab)) sb.hidden = true;
    else {
      sb.hidden = false;
      this._selectTab(tab);
    }
    this._refreshToolbar();
    this._layout();
  }

  _selectTab(tab) {
    this.tab = tab;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === tab);
    $('tab-chat').hidden = tab !== 'chat';
    $('tab-people').hidden = tab !== 'people';
    if (tab === 'chat') {
      this.unread = 0;
      $('chat-badge').hidden = true;
      $('chat-log').scrollTop = $('chat-log').scrollHeight;
      if (matchMedia('(pointer: fine)').matches) $('chat-input').focus();
    }
    if (tab === 'people') this._renderPeople();
  }

  _renderPeople() {
    const ids = [this.id, ...this.mesh.peers.keys()];
    $('people-count').textContent = ids.length;
    if ($('tab-people').hidden) return;
    const movie = this.sync.state.movie;
    $('people').replaceChildren(...ids.map((id) => {
      const p = this.profileOf(id);
      const li = document.createElement('li');
      const av = document.createElement('div');
      av.className = 'avatar';
      av.textContent = initials(p.name);
      av.style.background = colorFor(id);
      const who = document.createElement('div');
      who.className = 'who';
      const nm = document.createElement('div');
      nm.textContent = id === this.id ? `${p.name} (you)` : p.name;
      who.append(nm);
      if (movie) {
        const st = id === this.id ? { file: this.sync.localFile, matches: this.sync.fileMatches } : this.sync.peerStatus.get(id);
        const small = document.createElement('small');
        small.textContent = !st || !st.file ? 'no movie file loaded' : st.matches ? (st.buffering ? 'loading…' : 'ready to watch') : 'different file';
        who.append(small);
      }
      const mic = icon(p.audio ? 'mic' : 'mic-off');
      if (!p.audio) mic.classList.add('bad');
      const cam = icon(p.video ? 'cam' : 'cam-off');
      if (!p.video) cam.classList.add('bad');
      li.append(av, who, mic, cam);
      return li;
    }));
  }

  // ---- chat --------------------------------------------------------------------------
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

  _cleanChat(m, peer) {
    return {
      id: String(m.id || randomId()).slice(0, 40),
      from: peer ? peer.id : String(m.from || ''),
      name: String((peer ? this.profileOf(peer.id).name : m.name) || 'Guest').slice(0, 40),
      text: String(m.text || '').slice(0, 2000),
      ts: Number(m.ts) || this.signaling.now(),
    };
  }

  _addChat(m, quiet = false) {
    if (!m.text || this.chatIds.has(m.id)) return;
    this.chatIds.add(m.id);
    this.chat.push(m);
    this.chat.sort((a, b) => a.ts - b.ts);
    if (this.chat.length > 500) this.chat.shift();
    const log = $('chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const el = document.createElement('div');
    el.className = 'msg';
    el.dataset.ts = m.ts;
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

  // ---- movie ---------------------------------------------------------------------------
  _initMovie() {
    const p = this.player;
    const sync = this.sync;
    const box = $('movie-box');

    $('movie-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      $('movie-dialog').close('file');
      if (f) this.chooseMovieFile(f);
    });
    $('movie-dialog').addEventListener('close', () => {
      const v = $('movie-dialog').returnValue;
      if (v === 'unload') {
        p.unload();
        sync.clearLocalFile();
      } else if (v === 'close') {
        p.unload();
        sync.clearLocalFile();
        sync.closeMovie();
      }
    });
    $('sub-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) return toast('Subtitle file is too large.', 'warn');
      await this._shareSubtitle(f.name, new Uint8Array(await f.arrayBuffer()));
    });

    // Controls
    $('m-play').onclick = () => this._userAction(() => sync.toggle());
    $('m-back').onclick = () => this._userAction(() => sync.seek(Math.max(0, this._pos() - this.seekStep)));
    $('m-fwd').onclick = () => this._userAction(() => sync.seek(this._pos() + this.seekStep));
    box.querySelector('video').addEventListener('click', () => this._userAction(() => sync.toggle()));
    box.querySelector('video').addEventListener('dblclick', () => this.toggleFullscreen());
    $('m-volume').value = p.video.volume;
    $('m-volume').oninput = (e) => {
      p.video.volume = Number(e.target.value);
      p.video.muted = false;
      store.set('movieVolume', p.video.volume);
      this._refreshVolume();
    };
    $('m-mute').onclick = () => {
      p.video.muted = !p.video.muted;
      this._refreshVolume();
    };
    $('m-full').onclick = () => this.toggleFullscreen();
    this._initSeekBar();
    this._initMenus();

    // Hide controls when idle.
    let idleTimer = 0;
    const wake = () => {
      box.classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!p.paused && !box.querySelector('.menu:not([hidden])')) box.classList.add('idle');
      }, 3000);
    };
    box.addEventListener('pointermove', wake);
    box.addEventListener('pointerdown', wake);
    p.addEventListener('pause', wake);

    // Player events
    p.addEventListener('tracks', () => this._renderMenus());
    // `long` messages (Google blocking downloads) explain something people need time to read.
    p.addEventListener('notice', (e) => toast(e.detail.text, 'warn', e.detail.long ? 25000 : 0));
    p.addEventListener('fatal', (e) => {
      toast(e.detail.text, 'warn', e.detail.long ? 25000 : 0);
      this._renderStage();
    });
    p.addEventListener('status', (e) => {
      if (e.detail.text) $('m-ready').textContent = e.detail.text;
    });
    for (const ev of ['play', 'pause', 'ended']) p.addEventListener(ev, () => this._refreshPlayButton());

    sync.addEventListener('state', () => {
      if ($('movie-dialog').open) {
        this._renderMovieDialog();
        this._renderDriveItems(); // subtitle files become available once a movie is chosen
      }
      this._updatePlaybackState();
      this._renderStage();
      this._renderMenus();
      this._renderPeople();
    });
    sync.addEventListener('status', () => {
      this._renderReady();
      this._renderPeople();
    });
    sync.addEventListener('blocked', () => this._renderStage());
    sync.addEventListener('remote-change', (e) => this._announce(e.detail));

    setInterval(() => this._renderTime(), 250);
    this._renderStage();
  }

  _pos() {
    return this.sync.fileMatches && this.player.loaded ? this.player.time : this.sync.expectedPosition();
  }

  _userAction(fn) {
    audioContext();
    fn();
  }

  /** Decode subtitle bytes and share them with the room (from a local file or Google Drive). */
  async _shareSubtitle(name, bytes, message) {
    let text = new TextDecoder().decode(bytes);
    if (text.includes('�')) {
      // Not UTF-8: most older subtitle files are Windows-1252 / Latin-1.
      try {
        text = new TextDecoder('windows-1252').decode(bytes);
      } catch {
        /* keep */
      }
    }
    const id = 'x' + (await hashText(text));
    this.sync.addSubtitleFile({ id, name, text });
    toast(message || `Subtitles “${name}” shared with everyone.`);
  }

  openMovieDialog() {
    this._renderMovieDialog();
    this._renderDriveSection();
    $('movie-dialog').showModal();
  }

  _renderMovieDialog() {
    const s = this.sync.state;
    const has = this.sync.localFile;
    const drive = !!this.drive;
    $('movie-dialog-current').hidden = !has && !s.movie;
    $('movie-unload').hidden = !has;
    if (s.movie && !has) {
      $('movie-dialog-text').textContent = drive
        ? `Everyone is watching “${s.movie.name}” (${fmtSize(s.movie.size)}). Stream it from Google Drive, or choose your own copy of the same file — nothing gets uploaded.`
        : `Everyone is watching “${s.movie.name}” (${fmtSize(s.movie.size)}). Choose your copy of the same file — nothing gets uploaded.`;
    } else if (has) {
      $('movie-dialog-text').textContent = `You're watching “${has.name}”. Pick another file to switch, or stop.`;
    } else if (drive) {
      $('movie-dialog-text').textContent = 'Pick a movie from the room’s Google Drive folder, or choose a file on your device. Nothing is uploaded — only play/pause/seek and track choices are shared.';
    } else {
      $('movie-dialog-text').textContent = 'Everyone needs their own copy of the movie file. Nothing is uploaded — only play/pause/seek and track choices are shared.';
    }
  }

  // ---- Google Drive folder -------------------------------------------------------------
  /** Apply the room's Drive settings (from the welcome message or an admin change). null removes them. */
  _setDrive(cfg) {
    const ok = cfg && typeof cfg === 'object' && typeof cfg.apiKey === 'string' && typeof cfg.folderId === 'string';
    const key = ok ? JSON.stringify([cfg.apiKey, cfg.folderId, cfg.resourceKey || '']) : '';
    if (key === this.driveKey) return;
    this.driveKey = key;
    this.drive = ok ? new DriveClient({ apiKey: cfg.apiKey, folderId: cfg.folderId, resourceKey: cfg.resourceKey || '' }) : null;
    this.driveTrail = null;
    this.driveRootName = '';
    this._driveShown = null;
    this._driveSubs = null;
    if (!this.initialized) return;
    if ($('movie-dialog').open) {
      this._renderMovieDialog();
      this._renderDriveSection();
    }
    this._renderStage();
  }

  _renderDriveSection() {
    const on = !!this.drive;
    $('drive-section').hidden = !on;
    $('movie-dialog').classList.toggle('has-drive', on);
    if (!on) return;
    if (!this.driveTrail) {
      this.driveTrail = [{ id: this.drive.folderId, name: this.driveRootName || 'Drive folder' }];
      const drive = this.drive;
      drive.folderInfo().then((info) => {
        if (drive !== this.drive || !this.driveTrail) return;
        this.driveRootName = info.name;
        this.driveTrail[0].name = info.name;
        this._renderDriveCrumbs();
      }, () => { /* keep the fallback name; listing shows the real error */ });
    }
    this._renderDriveCrumbs();
    this._loadDriveFolder();
  }

  _renderDriveCrumbs() {
    const nav = $('drive-crumbs');
    nav.replaceChildren();
    const last = this.driveTrail.length - 1;
    this.driveTrail.forEach((c, i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '›';
        nav.append(sep);
      }
      if (i === last) {
        const here = document.createElement('span');
        here.className = 'here';
        here.setAttribute('aria-current', 'location');
        here.textContent = c.name;
        here.title = c.name;
        nav.append(here);
      } else {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = c.name;
        b.title = c.name;
        b.onclick = () => {
          this.driveTrail.length = i + 1;
          this._renderDriveCrumbs();
          this._loadDriveFolder();
        };
        nav.append(b);
      }
    });
  }

  async _loadDriveFolder() {
    const drive = this.drive;
    const folder = this.driveTrail[this.driveTrail.length - 1];
    const token = ++this._driveToken;
    const list = $('drive-list');
    const note = (text, cls = '') => {
      const p = document.createElement('p');
      p.className = 'muted ' + cls;
      p.textContent = text;
      return p;
    };
    this._driveShown = null;
    list.replaceChildren(note('Loading…'));
    let items;
    try {
      items = await drive.list(folder.id);
    } catch (err) {
      if (token !== this._driveToken || drive !== this.drive) return;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn';
      retry.textContent = 'Try again';
      retry.onclick = () => this._loadDriveFolder();
      list.replaceChildren(note(err.message || 'Could not load the folder.', 'error'), retry);
      return;
    }
    if (token !== this._driveToken || drive !== this.drive) return;
    this._driveShown = items;
    this._renderDriveItems();
  }

  _renderDriveItems() {
    const items = this._driveShown;
    if (!items) return;
    const list = $('drive-list');
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No videos or subtitle files in this folder.';
      list.replaceChildren(p);
      return;
    }
    const room = this.sync.state.movie;
    const canSub = !!(room || this.sync.localFile);
    const rows = items.map((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'drive-item';
      b.dataset.kind = f.kind;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = f.name;
      name.title = f.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      if (f.kind === 'video') {
        meta.textContent = [fmtSize(f.size), f.durationMs ? fmtTime(f.durationMs / 1000) : ''].filter(Boolean).join(' · ');
        if (room && (room.drive?.id === f.id || (room.size && room.size === f.size && room.name === f.name))) {
          b.classList.add('current');
          b.setAttribute('aria-current', 'true');
          meta.textContent = 'now playing' + (meta.textContent ? ' · ' + meta.textContent : '');
        }
        b.onclick = () => this._streamDriveFile(f);
      } else if (f.kind === 'subtitle') {
        meta.textContent = canSub ? 'subtitles' : 'pick a movie first';
        b.disabled = !canSub;
        b.onclick = () => this._shareDriveSubtitle(f, b);
      } else {
        b.onclick = () => {
          this.driveTrail.push({ id: f.id, name: f.name });
          this._renderDriveCrumbs();
          this._loadDriveFolder();
        };
      }
      b.append(icon(f.kind === 'folder' ? 'folder' : f.kind === 'video' ? 'film' : 'cc'), name, meta);
      return b;
    });
    list.replaceChildren(...rows);
  }

  _streamDriveFile(f) {
    let file;
    try {
      const folder = this.driveTrail[this.driveTrail.length - 1].id;
      file = this.drive.remoteFile({ ...f, folder, folderKey: this.drive.keys.get(folder) || '' });
    } catch (err) {
      toast(err.message, 'warn');
      return;
    }
    $('movie-dialog').close('drive');
    this.chooseMovieFile(file);
  }

  async _shareDriveSubtitle(f, button) {
    if (button) button.disabled = true;
    try {
      await this._shareSubtitle(f.name, await this.drive.downloadText(f));
      if ($('movie-dialog').open) $('movie-dialog').close('subtitles');
    } catch (err) {
      toast(err.message || 'Could not download the subtitles.', 'warn', err.blocked ? 25000 : 0);
      if (button) button.disabled = false;
    }
  }

  /** Subtitle files in the folder of the room's Drive movie, for the CC menu. Listed lazily (the listing is cached). */
  _driveSubtitles() {
    const m = this.sync.state.movie;
    const folder = this.drive && m?.drive?.folder;
    if (!folder) return null;
    let st = this._driveSubs;
    if (!st || st.folder !== folder) {
      const drive = this.drive;
      st = this._driveSubs = { folder, status: 'loading', items: [] };
      drive.addKey(folder, m.drive.folderKey);
      drive.list(folder).then((items) => {
        st.status = 'ok';
        st.items = items.filter((f) => f.kind === 'subtitle');
      }, (err) => {
        st.status = 'error';
        st.error = err.message;
      }).then(() => {
        if (this._driveSubs === st) this._renderMenus();
      });
    }
    return st;
  }

  /** Started a movie from Drive for the room: share the subtitle file next to it, if there is a clear match. */
  async _autoDriveSubtitle(file) {
    const drive = this.drive;
    const m = file.drive;
    if (!drive || !m?.folder) return;
    let pick = null;
    try {
      drive.addKey(m.folder, m.folderKey);
      pick = pickSubtitle(file.name, await drive.list(m.folder), navigator.language);
      const st = this.sync.state;
      if (!pick || drive !== this.drive || st.sub || st.subFiles.length || st.movie?.name !== file.name) return;
      await this._shareSubtitle(pick.name, await drive.downloadText(pick), `Subtitles “${pick.name}” loaded from Google Drive. Turn them off in the CC menu.`);
    } catch (err) {
      console.warn('Automatic subtitles failed', err);
      toast(`Could not load subtitles${pick ? ` “${pick.name}”` : ''} from Google Drive.`, 'warn');
    }
  }

  /** The room's movie is on Drive and we can reach it: stream it with one click (a user gesture). */
  _streamRoomMovie() {
    const m = this.sync.state.movie;
    if (!this.drive || !m?.drive) return;
    try {
      this.chooseMovieFile(this.drive.remoteFile({ id: m.drive.id, name: String(m.name || 'Movie'), size: Number(m.size), resourceKey: m.drive.resourceKey, folder: m.drive.folder, folderKey: m.drive.folderKey }));
    } catch (err) {
      toast(err.message, 'warn');
    }
  }

  async chooseMovieFile(file) {
    const s = this.sync.state;
    const quick = { name: file.name, size: file.size, duration: 0 };
    let asRoom = !s.movie;
    if (s.movie && !sameMovie(quick, s.movie) && file.name !== s.movie.name) {
      $('mismatch-text').textContent = `Everyone else is watching “${s.movie.name}” (${fmtSize(s.movie.size)}), but you picked “${file.name}” (${fmtSize(file.size)}).`;
      const choice = await new Promise((resolve) => {
        const d = $('mismatch-dialog');
        d.addEventListener('close', () => resolve(d.returnValue), { once: true });
        d.returnValue = 'cancel';
        d.showModal();
      });
      if (choice === 'cancel') return;
      asRoom = choice === 'room';
    }
    this.loadingMovie = true;
    this.loadingRemote = !!file.remote;
    this._renderStage();
    try {
      await this.player.load(file, { audioIndex: asRoom ? 0 : s.audio });
    } catch (err) {
      console.error(err);
      toast(file.remote && err.remote ? err.message : 'Could not open this file: ' + (err.message || err), 'warn', err.blocked ? 25000 : 0);
      this.player.unload();
      this.loadingMovie = false;
      this._renderStage();
      return;
    }
    if (!this.loadingMovie || this.player.file !== file) return; // cancelled
    this.loadingMovie = false;
    // Prime playback inside this user gesture so later remote "play" commands
    // aren't blocked by autoplay rules (Safari).
    const v = this.player.video;
    if (v.paused) {
      const wasMuted = v.muted;
      v.muted = true;
      this.sync.expectMediaChange(2000);
      v.play().then(() => {
        this.sync.expectMediaChange(1000);
        if (this.sync.state.paused) v.pause();
        v.muted = wasMuted;
      }).catch(() => { v.muted = wasMuted; });
    }
    const info = { name: file.name, size: file.size, duration: Math.round(this.player.duration * 10) / 10 };
    if (file.drive) info.drive = { ...file.drive };
    this.sync.setLocalFile(info, asRoom);
    if (asRoom && file.drive?.folder) this._autoDriveSubtitle(file); // in the background: never holds up playback
    if (asRoom) this.mesh.broadcast({ type: 'chat', msg: { id: randomId(), from: this.id, name: this.name, text: `🎬 Started a movie: ${file.name}`, ts: this.signaling.now() } });
    this._renderStage();
    this._renderMenus();
  }

  _renderStage() {
    const s = this.sync.state;
    const active = !!s.movie || !!this.sync.localFile || !!this.loadingMovie;
    const wasHidden = $('stage').hidden;
    $('stage').hidden = !active;
    $('main').classList.toggle('watching', active);
    if (wasHidden !== !active) this._layout();
    if (!active) this.closePip();
    this._syncMediaSession();
    this._refreshToolbar();
    const ov = $('movie-overlay');
    ov.replaceChildren();
    let overlay = null;
    if (this.loadingMovie) {
      overlay = this._overlay('Opening movie…', this.loadingRemote ? 'Connecting to Google Drive…' : 'Reading the file on your device.', 'Cancel', () => {
        this.loadingMovie = false;
        this.player.unload();
        this._renderStage();
      });
    } else if (s.movie && !this.sync.localFile) {
      const fromDrive = !!(this.drive && s.movie.drive && s.movie.size > 0);
      overlay = this._overlay(
        `“${s.movie.name}”`,
        `${fmtSize(s.movie.size)}${s.movie.duration ? ' · ' + fmtTime(s.movie.duration) : ''}. ${fromDrive ? 'Stream it from Google Drive, or use your own copy of this file, to join in.' : 'Choose your copy of this file to join in.'} ${s.paused ? '' : 'The movie is already playing — you will jump right in.'}`,
        fromDrive ? 'Stream from Google Drive' : 'Choose file…',
        fromDrive ? () => this._streamRoomMovie() : () => $('movie-file').click(),
        fromDrive ? { label: 'Use my own copy…', onClick: () => $('movie-file').click() } : null,
      );
    } else if (!s.movie && this.sync.localFile) {
      overlay = this._overlay('Movie closed', 'The movie was closed for everyone.', 'OK', () => {
        this.player.unload();
        this.sync.clearLocalFile();
      });
    } else if (this.sync.blocked) {
      overlay = this._overlay('Ready', 'Your browser needs a click before it can play.', 'Start playback', () => {
        this.sync.unblock();
        this._renderStage();
      });
    }
    if (overlay) ov.appendChild(overlay);
    ov.hidden = !overlay;
    this._refreshPlayButton();
    this._renderReady();
  }

  _overlay(title, text, button, onClick, second = null) {
    const wrap = document.createElement('div');
    wrap.className = 'stack';
    const h = document.createElement('h2');
    h.textContent = title;
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = text;
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = button;
    b.onclick = onClick;
    wrap.append(h, p, b);
    if (second) {
      const b2 = document.createElement('button');
      b2.className = 'btn secondary';
      b2.textContent = second.label;
      b2.onclick = second.onClick;
      wrap.append(b2);
    }
    return wrap;
  }

  _renderReady() {
    const s = this.sync.state;
    if (!s.movie) return;
    if (!s.paused) this._startedMovie = s.movie;
    const started = this._startedMovie && sameMovie(this._startedMovie, s.movie);
    let ready = this.sync.fileMatches ? 1 : 0;
    let total = 1;
    const waiting = [];
    for (const [id] of this.mesh.peers) {
      total++;
      const st = this.sync.peerStatus.get(id);
      if (st && st.matches) ready++;
      else waiting.push(this.profileOf(id).name);
    }
    $('m-ready').textContent = total === 1 || (started && ready === total) ? '' : ready === total ? `Everyone ready (${total})` : `${ready}/${total} ready${waiting.length ? ' · waiting for ' + waiting.slice(0, 2).join(', ') : ''}`;
  }

  _refreshPlayButton() {
    const playing = !this.sync.state.paused;
    setIcon($('m-play'), playing ? 'pause' : 'play');
  }

  _refreshVolume() {
    const v = this.player.video;
    setIcon($('m-mute'), v.muted || v.volume === 0 ? 'volume-off' : 'volume');
    $('m-volume').value = v.muted ? 0 : v.volume;
  }

  _renderTime() {
    if ($('stage').hidden || this._dragging) return;
    const d = this.sync.state.movie?.duration || this.player.duration || 0;
    const t = this._pos();
    $('m-time').textContent = fmtTime(t);
    $('m-duration').textContent = fmtTime(d);
    $('m-progress').style.width = d ? `${Math.min(100, (t / d) * 100)}%` : '0';
    const b = this.player.loaded ? this.player.buffered.find(([a, e]) => a <= t + 0.5 && e >= t) : null;
    $('m-buffered').style.left = b && d ? `${(b[0] / d) * 100}%` : '0';
    $('m-buffered').style.width = b && d ? `${((b[1] - b[0]) / d) * 100}%` : '0';
  }

  _initSeekBar() {
    const bar = $('m-seek');
    const timeAt = (x) => {
      const r = bar.getBoundingClientRect();
      const d = this.sync.state.movie?.duration || this.player.duration || 0;
      return Math.max(0, Math.min(1, (x - r.left) / r.width)) * d;
    };
    const showHover = (x) => {
      const r = bar.getBoundingClientRect();
      $('m-hover').hidden = false;
      $('m-hover').style.left = `${Math.max(0, Math.min(r.width, x - r.left))}px`;
      $('m-hover').textContent = fmtTime(timeAt(x));
    };
    bar.addEventListener('pointermove', (e) => {
      showHover(e.clientX);
      if (this._dragging) {
        const d = this.sync.state.movie?.duration || this.player.duration || 1;
        $('m-progress').style.width = `${(timeAt(e.clientX) / d) * 100}%`;
        $('m-time').textContent = fmtTime(timeAt(e.clientX));
      }
    });
    bar.addEventListener('pointerleave', () => { if (!this._dragging) $('m-hover').hidden = true; });
    bar.addEventListener('pointerdown', (e) => {
      this._dragging = true;
      try {
        bar.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
      showHover(e.clientX);
    });
    bar.addEventListener('pointerup', (e) => {
      if (!this._dragging) return;
      this._dragging = false;
      $('m-hover').hidden = true;
      this._userAction(() => this.sync.seek(timeAt(e.clientX)));
    });
    bar.addEventListener('pointercancel', () => { this._dragging = false; });
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') this.sync.seek(Math.max(0, this._pos() - 5));
      else if (e.key === 'ArrowRight') this.sync.seek(this._pos() + 5);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  _initMenus() {
    const pairs = [['m-audio', 'm-audio-menu'], ['m-subs', 'm-subs-menu']];
    for (const [btn, menu] of pairs) {
      $(btn).onclick = (e) => {
        e.stopPropagation();
        const m = $(menu);
        const open = m.hidden;
        for (const [, other] of pairs) $(other).hidden = true;
        m.hidden = !open;
        this._renderMenus();
      };
    }
    // Also attached to the Picture-in-Picture document while it is open.
    this._onDocClick = (e) => {
      if (!e.target.closest('.menu')) for (const [, m] of pairs) $(m).hidden = true;
    };
    document.addEventListener('click', this._onDocClick);
  }

  _menuItem(label, on, onClick, note, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = on ? 'on' : '';
    const tick = icon('check');
    tick.classList.add('tick');
    const span = document.createElement('span');
    span.textContent = label;
    b.append(tick, span);
    if (note) {
      const s = document.createElement('small');
      s.textContent = note;
      b.append(s);
    }
    b.disabled = !!disabled;
    b.onclick = (e) => {
      e.stopPropagation();
      onClick();
      for (const id of ['m-audio-menu', 'm-subs-menu']) $(id).hidden = true;
    };
    return b;
  }

  _renderMenus() {
    const info = this.player.info;
    const s = this.sync.state;
    // Audio
    const am = $('m-audio-menu');
    const ah = document.createElement('h4');
    ah.textContent = 'Audio (changes it for everyone)';
    const audioTracks = info?.audioTracks || [];
    am.replaceChildren(ah, ...(audioTracks.length
      ? audioTracks.map((t) => this._menuItem(t.label, s.audio === t.index, () => this.sync.setAudio(t.index), t.supported ? '' : t.note || 'not playable here'))
      : [this._menuItem(this.player.loaded ? 'Default' : 'Load the movie first', true, () => {}, '', true)]));
    $('m-audio').hidden = audioTracks.length < 2;

    // Subtitles
    const sm = $('m-subs-menu');
    const sh = document.createElement('h4');
    sh.textContent = 'Subtitles (changes it for everyone)';
    const items = [this._menuItem('Off', !s.sub, () => this.sync.setSubtitle(null))];
    for (const t of info?.subtitleTracks || []) {
      let note = '';
      if (t.unsupported) note = ['not available when streaming', 'could not be loaded'].includes(t.unsupported) ? t.unsupported : 'not supported';
      else if (t.waiting) note = 'loads when selected'; // streaming: read on demand
      else if (t.progress < 1) note = `loading ${Math.round(t.progress * 100)}%`;
      else if (t.source === 'external') note = 'file';
      items.push(this._menuItem(t.label, s.sub === t.id, () => this.sync.setSubtitle(t.id), note, !!t.unsupported));
    }
    // Shared subtitle files we haven't received yet.
    for (const f of s.subFiles) {
      if (!info?.subtitleTracks.some((t) => t.id === f.id)) items.push(this._menuItem(f.name, s.sub === f.id, () => this.sync.setSubtitle(f.id), 'receiving…', true));
    }
    // Subtitle files next to the movie on Drive (ones already shared show up above as normal entries).
    const dsubs = this._driveSubtitles();
    if (dsubs) {
      const shared = new Set(s.subFiles.map((f) => f.name));
      // A folder can hold several films with their subtitles: list only this film's (none if none match).
      const files = dsubs.items.filter((f) => subtitleMatches(s.movie.name, f.name) && !shared.has(f.name));
      const dh = document.createElement('h4');
      dh.textContent = 'From Google Drive';
      if (dsubs.status === 'loading') items.push(dh, this._menuItem('Loading…', false, () => {}, '', true));
      else if (dsubs.status === 'error') items.push(dh, this._menuItem('Could not list the folder', false, () => { this._driveSubs = null; this._renderMenus(); }, 'retry'));
      else if (files.length) {
        items.push(dh);
        for (const f of files) items.push(this._menuItem(f.name, false, () => this._shareDriveSubtitle(f), fmtSize(f.size)));
      }
      if (dsubs.status === 'ok' && files.length) {
        const lh = document.createElement('h4');
        lh.textContent = 'From your device';
        items.push(lh);
      }
    }
    const load = document.createElement('button');
    load.type = 'button';
    load.append(icon('folder'), document.createTextNode('Load subtitle file (.srt, .vtt, .ass)…'));
    load.onclick = (e) => {
      e.stopPropagation();
      sm.hidden = true;
      $('sub-file').click();
    };
    sm.replaceChildren(sh, ...items, load);
  }

  _announce({ peer, prev, state }) {
    const who = this.profileOf(peer.id).name;
    const by = state.by === peer.id ? who : this.profileOf(state.by).name;
    if (!sameMovie(prev.movie, state.movie)) {
      if (state.movie) toast(`${by} started “${state.movie.name}”. ${this.drive && state.movie.drive ? 'Stream it from Google Drive' : 'Open your copy'} to watch along.`);
      else toast(`${by} closed the movie.`);
      return;
    }
    if (prev.paused !== state.paused) toast(`${by} ${state.paused ? 'paused' : 'pressed play'}`);
    else if (Math.abs(state.pos - this.sync.expectedPosition(prev)) > 2) toast(`${by} jumped to ${fmtTime(state.pos)}`);
    if (prev.audio !== state.audio) {
      const t = this.player.audioTracks?.[state.audio];
      toast(`${by} switched audio${t ? ' to ' + t.label : ''}`);
    }
    if (prev.sub !== state.sub) {
      const t = state.sub ? this.player.subtitles.get(state.sub) : null;
      toast(state.sub ? `${by} turned on subtitles${t ? ': ' + t.label : ''}` : `${by} turned subtitles off`);
    }
  }

  toggleFullscreen() {
    if (pipWindow) return; // the floating window has no full screen
    const el = document.documentElement;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (el.requestFullscreen || el.webkitRequestFullscreen) {
      const r = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      r?.catch?.(() => {});
    } else if (this.player.video.webkitEnterFullscreen) {
      this.player.video.webkitEnterFullscreen(); // iPhone: video-only full screen
    }
  }

  // ---- settings ------------------------------------------------------------------
  _updateSeekTitles() {
    $('m-back').title = `Back ${this.seekStep} s (←)`;
    $('m-fwd').title = `Forward ${this.seekStep} s (→)`;
  }

  _initSettings() {
    const onFs = () => {
      const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      document.body.classList.toggle('fullscreen', fs);
      setIcon($('m-full'), fs ? 'shrink' : 'expand');
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);

    const subScale = store.get('subScale', 1);
    $('subs-layer').style.setProperty('--sub-scale', subScale);
    $('set-subsize').value = String(subScale);
    const seekStep = Number(store.get('seekStep', 10));
    this.seekStep = [5, 10, 15, 30, 60].includes(seekStep) ? seekStep : 10;
    $('set-seekstep').value = String(this.seekStep);
    this._updateSeekTitles();
    $('set-lowband').checked = store.get('lowBandwidth', false);
    this.mesh.setLowPower($('set-lowband').checked);
    $('set-noise').checked = this.media.processing;

    $('set-audio-dev').onchange = (e) => this._changeDevice('audio', e.target.value);
    $('set-video-dev').onchange = (e) => this._changeDevice('video', e.target.value);
    $('set-noise').onchange = (e) => {
      this.media.setProcessing(e.target.checked);
      store.set('processing', e.target.checked);
    };
    $('set-lowband').onchange = (e) => {
      this.mesh.setLowPower(e.target.checked);
      store.set('lowBandwidth', e.target.checked);
    };
    $('set-subsize').onchange = (e) => {
      $('subs-layer').style.setProperty('--sub-scale', e.target.value);
      store.set('subScale', Number(e.target.value));
      this.compactPip?.setSubScale(e.target.value);
    };
    $('set-seekstep').onchange = (e) => {
      this.seekStep = Number(e.target.value);
      store.set('seekStep', this.seekStep);
      this._updateSeekTitles();
    };
    // Only browsers with Document PiP have a choice of style.
    $('set-pipstyle-label').hidden = this.pipMode !== 'document';
    $('set-pipstyle').value = store.get('pipStyle', 'floating') === 'compact' ? 'compact' : 'floating';
    $('set-pipstyle').onchange = (e) => {
      store.set('pipStyle', e.target.value);
      this.closePip(); // the next click uses the new style
    };
    $('set-subdelay').oninput = (e) => {
      this.player.subtitleDelay = Number(e.target.value) || 0;
    };
    $('settings-dialog').addEventListener('close', () => {
      const name = $('set-name').value.trim().slice(0, 40);
      if (name && name !== this.name) {
        this.name = name;
        store.set('name', name);
        this.signaling.rename(name);
        this._broadcastProfile();
        this._updateTile(this.id);
        this._renderPeople();
      }
    });
  }

  async _changeDevice(kind, deviceId) {
    await this.media.setDevice(kind, deviceId);
    store.set('media', { ...store.get('media', {}), [kind === 'audio' ? 'audioDevice' : 'videoDevice']: deviceId });
  }

  async openSettings() {
    $('set-name').value = this.name;
    const d = await this.media.devices();
    for (const kind of ['audio', 'video']) {
      const sel = $(`set-${kind}-dev`);
      sel.replaceChildren(...d[kind].map((dev, i) => new Option(dev.label || `${kind === 'audio' ? 'Microphone' : 'Camera'} ${i + 1}`, dev.deviceId)));
      sel.value = this.media.currentDeviceId(kind);
    }
    $('settings-dialog').showModal();
  }

  // ---- keyboard ----------------------------------------------------------------------
  _initKeyboard() {
    // Also attached to the Picture-in-Picture document while it is open.
    this._onKeydown = (e) => {
      if (e.target.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
      const movie = !$('stage').hidden && this.sync.fileMatches;
      switch (e.key) {
        case ' ':
        case 'k':
          if (!movie) return;
          this._userAction(() => this.sync.toggle());
          break;
        case 'ArrowLeft':
          if (!movie) return;
          this.sync.seek(Math.max(0, this._pos() - this.seekStep));
          break;
        case 'ArrowRight':
          if (!movie) return;
          this.sync.seek(this._pos() + this.seekStep);
          break;
        case 'f':
          this.toggleFullscreen();
          break;
        case 'm':
          this.toggleMic();
          break;
        case 'v':
          this.toggleCam();
          break;
        case 'c':
          this.toggleSidebar('chat');
          break;
        case 'p':
          if (!movie || !this.player.loaded || !this.pipMode) return;
          this.togglePip();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    document.addEventListener('keydown', this._onKeydown);
  }

  // ---- picture-in-picture ---------------------------------------------------------------
  _initPip() {
    const video = this.player.video;
    const documentPip = 'documentPictureInPicture' in window;
    const nativePip = !!document.pictureInPictureEnabled;
    this.pipMode = documentPip ? 'document' : nativePip ? 'native' : null;
    $('m-pip').hidden = !this.pipMode;
    $('m-pip').onclick = () => this.togglePip();
    if (!documentPip && !('pictureInPictureEnabled' in document)) {
      // Firefox: its own PiP button renders the caption track, so keep it
      // showing, but hide Firefox's in-page rendering (our overlay draws it).
      document.documentElement.classList.add('native-cue-hidden');
      this.player.setNativeCaptionsMode('showing');
    }
    video.addEventListener('enterpictureinpicture', () => this._refreshPip());
    video.addEventListener('leavepictureinpicture', () => this._refreshPip());
    // Compact mode puts a proxy <video> in PiP, not the movie element.
    document.addEventListener('enterpictureinpicture', () => this._refreshPip(), true);
    document.addEventListener('leavepictureinpicture', () => this._refreshPip(), true);
  }

  togglePip() {
    if (pipWindow || this.compactPip) return this.closePip();
    if (!this.player.loaded) return;
    if (this.pipMode === 'document') return store.get('pipStyle', 'floating') === 'compact' ? this._openCompactPip() : this._openDocumentPip();
    if (this.pipMode === 'native') return this._toggleNativePip();
  }

  closePip() {
    pipWindow?.close();
    this.compactPip?.close();
  }

  /** Canvas-based native PiP: no browser title bar, play/pause only. Must run inside the click handler. */
  async _openCompactPip() {
    if (this._pipOpening) return;
    this._pipOpening = true;
    const pip = new CompactPip(this.player, { subScale: store.get('subScale', 1) });
    this.compactPip = pip;
    pip.addEventListener('close', () => {
      if (this.compactPip === pip) this.compactPip = null;
      this._refreshPip();
      this._updatePlaybackState();
    });
    // The PiP buttons may toggle the proxy <video> directly (outside Media Session handlers).
    pip.addEventListener('userpause', () => {
      if (!this.sync.state.paused) this._userAction(() => this.sync.pause());
      pip.resume(); // keep the PiP picture updating
    });
    pip.addEventListener('userplay', () => {
      if (this.sync.state.paused) this._userAction(() => this.sync.play());
    });
    try {
      await pip.open();
    } catch (err) {
      console.warn('Could not open compact picture-in-picture', err);
      pip.close();
      toast('Picture-in-picture is not available for this video.', 'warn');
      return;
    } finally {
      this._pipOpening = false;
    }
    this._refreshPip();
    this._updatePlaybackState();
  }

  async _toggleNativePip() {
    const v = this.player.video;
    try {
      if (document.pictureInPictureElement === v) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch (err) {
      console.warn('Picture-in-picture failed', err);
      toast('Picture-in-picture is not available for this video.', 'warn');
    }
  }

  async _openDocumentPip() {
    if (this._pipOpening) return;
    this._pipOpening = true;
    const box = $('movie-box');
    const v = this.player.video;
    const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
    const width = 480;
    const height = Math.max(200, Math.min(600, Math.round(width / aspect)));
    let win;
    try {
      win = await documentPictureInPicture.requestWindow({ width, height });
      await this._preparePipDocument(win.document);
    } catch (err) {
      console.warn('Could not open the floating window', err);
      win?.close();
      toast('Could not open the floating window.', 'warn');
      return;
    } finally {
      this._pipOpening = false;
    }
    if (win.closed) return;

    const placeholder = document.createElement('div');
    placeholder.id = 'pip-placeholder';
    placeholder.className = 'pip-placeholder';
    placeholder.append(this._overlay('Playing in a floating window', 'The movie, its subtitles and the controls are in their own window.', 'Bring it back', () => this.closePip()));

    pipWindow = win;
    pipDocument = win.document;
    $('stage').append(placeholder);
    this._moveMovieBox(() => pipDocument.body.append(box), win);
    for (const [type, fn] of [['keydown', this._onKeydown], ['click', this._onDocClick]]) pipDocument.addEventListener(type, fn);
    win.addEventListener('resize', () => this.player.renderer.layout());
    win.setInterval(() => this._renderTime(), 250); // the main tab's timers may be throttled
    win.addEventListener('pagehide', () => this._onPipClosed(), { once: true });
    this._refreshPip();
  }

  /** Make the PiP document look like the page: same styles and icon sprite. */
  async _preparePipDocument(doc) {
    doc.title = this.sync.localFile?.name || document.title;
    doc.body.className = 'pip-window';
    const sprite = document.body.querySelector(':scope > svg');
    if (sprite) doc.body.prepend(doc.importNode(sprite, true));
    const loads = [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => {
      const copy = link.cloneNode(true);
      copy.href = link.href; // absolute: the new document's base URL is not ours
      doc.head.append(copy);
      return new Promise((resolve) => {
        copy.addEventListener('load', resolve);
        copy.addEventListener('error', resolve);
      });
    });
    await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 1500))]);
  }

  /**
   * Moving a <video> between documents can pause it: don't let that look like a
   * user action, then resume if the room is playing.
   */
  _moveMovieBox(move, win) {
    this.sync.expectMediaChange(2000);
    move();
    this.player.renderer.layout();
    this.player.kickRenderLoop();
    if (win) win.requestAnimationFrame?.(() => this.player.renderer.layout());
    if (!this.sync.state.paused && this.player.paused) this.player.play().catch(() => {});
  }

  _onPipClosed() {
    if (!pipWindow) return;
    const box = $('movie-box');
    pipWindow = null;
    pipDocument = null;
    document.getElementById('pip-placeholder')?.remove();
    this._moveMovieBox(() => $('stage').prepend(box));
    this.sync.expectMediaChange(2000);
    this._refreshPip();
  }

  _refreshPip() {
    const pe = document.pictureInPictureElement;
    const active = !!pipWindow || (!!pe && (pe === this.player.video || pe === this.compactPip?.proxy));
    const btn = $('m-pip');
    btn.classList.toggle('active', active);
    setIcon(btn, active ? 'pip-exit' : 'pip');
    btn.title = active ? (pipWindow ? 'Return to page (p)' : 'Exit picture-in-picture (p)') : 'Picture-in-picture (p)';
  }

  // ---- media session (PiP window buttons, hardware media keys) ------------------------
  _syncMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const file = this.sync.localFile;
    const on = !!file && this.player.loaded;
    this._updatePlaybackState();
    if (on === this._mediaSession) return;
    this._mediaSession = on;
    const sync = this.sync;
    const seekBy = (d, dir) => this._userAction(() => sync.seek(Math.max(0, this._pos() + dir * (d?.seekOffset || this.seekStep))));
    const handlers = on ? {
      play: () => { if (sync.state.paused) this._userAction(() => sync.play()); },
      pause: () => { if (!sync.state.paused) this._userAction(() => sync.pause()); },
      seekbackward: (d) => seekBy(d, -1),
      seekforward: (d) => seekBy(d, 1),
      seekto: (d) => { if (Number.isFinite(d?.seekTime)) this._userAction(() => sync.seek(d.seekTime)); },
    } : {};
    for (const action of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto']) {
      try {
        navigator.mediaSession.setActionHandler(action, handlers[action] || null);
      } catch {
        /* action not supported */
      }
    }
    try {
      navigator.mediaSession.metadata = on && typeof MediaMetadata !== 'undefined' ? new MediaMetadata({ title: file.name }) : null;
    } catch {
      /* ignore */
    }
  }

  /** Chrome's PiP play/pause button reflects this, so keep it equal to the shared state. */
  _updatePlaybackState() {
    if (!('mediaSession' in navigator)) return;
    const on = !!this.sync.localFile && this.player.loaded;
    try {
      navigator.mediaSession.playbackState = on ? (this.sync.state.paused ? 'paused' : 'playing') : 'none';
    } catch {
      /* ignore */
    }
  }

  leave(explicit) {
    if (this.left) return;
    this.left = true;
    try {
      this.lock?.release();
    } catch {
      /* ignore */
    }
    this.closePip();
    this.sync.destroy();
    this.player.unload();
    this.mesh.close();
    this.media.stop();
    this.signaling.close();
    for (const t of this.tiles.values()) t.stopLevel?.();
    if (explicit) show('message');
  }
}
