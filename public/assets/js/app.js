import { Signaling } from './signaling.js';
import { Mesh } from './mesh.js';
import { MovieSync } from './sync.js';
import { MoviePlayer } from './player/player.js';
import { LocalMedia, watchLevel, audioContext } from './media.js';
import { Swarm } from './player/swarm.js';
import { $, store, show, showMessage, toast, setIcon, colorFor, initials, randomId, mixin, pipState } from './room/util.js';
import { bindThemeSelect } from './theme.js';
import { Tiles } from './room/tiles.js';
import { Toolbar } from './room/toolbar.js';
import { Chat } from './room/chat.js';
import { Movie } from './room/movie.js';
import { MovieMenus } from './room/menus.js';
import { DriveBrowser } from './room/drive-browser.js';
import { Pip } from './room/pip.js';
import { Settings } from './room/settings.js';
import { Keyboard } from './room/keyboard.js';
import { Screen } from './room/screen.js';

/** This tab's participant id (kept across reloads so a rejoin replaces our old connection). */
function sessionId() {
  try {
    const id = sessionStorage.getItem('te.id') || randomId();
    sessionStorage.setItem('te.id', id);
    return id;
  } catch {
    return randomId(); // storage blocked
  }
}

/** ICE servers etc.; a stalled request must not leave the lobby on "Joining…" forever. */
async function fetchConfig() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch('/api/config', { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`The server answered with an error (${res.status}).`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError' || err instanceof TypeError) throw new Error('Could not reach the server. Check your connection and try again.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
const roomName = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ''));

// Installable app (PWA). Service workers need a secure context (HTTPS or localhost); elsewhere this is skipped.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('service worker not registered:', err));
}

// Interface style pickers (start page, lobby, settings); a PiP window follows the change too.
for (const select of document.querySelectorAll('select[data-theme-select]')) bindThemeSelect(select, () => [pipState.document]);

if (!roomName) {
  show('landing');
  // The installed app opens on "/": offer the room used last.
  $('landing-room').value = store.get('lastRoom', '');
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
  const res = await fetch('/api/rooms/' + encodeURIComponent(room)).catch(() => {
    // Offline (the installed app can open without a connection), or the server is down.
    throw new Error('Could not reach the server. Check your connection and try again.');
  });
  if (res.status === 404) {
    showMessage('Room not found', `There is no room called “${room}”. Check the link with whoever invited you.`);
    return;
  }
  if (!res.ok) throw new Error('Server error');
  const info = await res.json();
  document.title = `${info.name} · Three-Eight`;
  store.set('lastRoom', info.name);
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
  const fillDevices = async () => {
    const d = await media.devices();
    for (const kind of ['audio', 'video']) {
      const sel = $(`lobby-${kind}-dev`);
      sel.replaceChildren(...d[kind].map((dev, i) => new Option(dev.label || `${kind === 'audio' ? 'Microphone' : 'Camera'} ${i + 1}`, dev.deviceId)));
      sel.value = media.currentDeviceId(kind);
    }
  };
  $('lobby-audio-dev').onchange = (e) => media.setDevice('audio', e.target.value);
  $('lobby-video-dev').onchange = (e) => media.setDevice('video', e.target.value);
  $('lobby-mic').onclick = () => media.setMic(!media.micOn);
  $('lobby-cam').onclick = async () => {
    const ok = await media.setCam(!media.camOn);
    if (!ok) toast('Could not start the camera.', 'warn');
    fillDevices();
  };
  // The devices are requested below, and the browser may keep its permission prompt open for as long as it
  // likes (Firefox lets it be dismissed without an answer). The form works right away: until the prompt is
  // answered, the device controls wait, and joining goes ahead without camera and microphone.
  const deviceControls = ['lobby-mic', 'lobby-cam', 'lobby-audio-dev', 'lobby-video-dev'];
  for (const id of deviceControls) $(id).disabled = true;
  refreshPreview();
  let inLobby = true; // false once the room has taken over

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
    let signaling = null;
    try {
      const cfg = await fetchConfig();
      const id = sessionId();
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      signaling = new Signaling(`${proto}//${location.host}/ws`);
      signaling.addEventListener('retrying', (ev) => {
        $('lobby-join').textContent = `Can’t reach the server, retrying (${ev.detail.attempt})…`;
      });
      const welcome = await signaling.join({ room: info.name, id, name, password });
      store.set(pwKey, $('lobby-remember').checked && password ? password : null);
      store.set('media', { mic: media.micOn, cam: media.camOn, audioDevice: media.deviceIds.audio, videoDevice: media.deviceIds.video });
      inLobby = false;
      stopMeter();
      media.removeEventListener('change', refreshPreview);
      preview.srcObject = null;
      // If the devices are still pending, the Room picks them up from the media 'change' events when they come.
      new Room({ signaling, welcome, media, name, id, iceServers: cfg.iceServers, roomName: welcome.room || info.name });
    } catch (err) {
      console.error('join failed', err);
      signaling?.close(); // stop any reconnect attempts
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

  await media.init().catch((err) => console.error('media init failed', err));
  for (const id of deviceControls) $(id).disabled = false;
  if (inLobby) refreshPreview();
  if (media.errors.audio || media.errors.video) {
    const e = media.errors.audio || media.errors.video;
    if (e.name === 'NotAllowedError') toast('Camera/microphone access was blocked. You can still join and watch.', 'warn');
    else if (e.name === 'NotSupportedError') toast(e.message, 'warn');
  }
  if (inLobby) fillDevices();
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
    this.profiles = new Map(); // peerId -> {name, audio, video, screen}
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
    // Film pieces are shared between the viewers (and a local copy can feed friends who have none).
    this.swarm = new Swarm(this.mesh, { selfId: id, share: store.get('shareFile', true) !== false });
    this._holderSig = '';
    // Embedded subtitles that someone has extracted are passed on, so streaming viewers need not extract them.
    this._cueFail = new Map();
    this.swarm.setSubSource({
      list: () => this.player.completeSubtitles(),
      get: (id) => this.player.subtitleCues(id),
      accepts: (id) => this.player.isEmbeddedTrack(id),
    });
    this.player.cueGate = (id) => this._askCues(id);
    this.player.addEventListener('tracks', () => {
      this.swarm.subsChanged();
      this._wantCues();
    });
    this.swarm.addEventListener('change', () => {
      this._wantCues();
      this._renderPeople();
      // The overlay offers copies by name: redraw it only when that list changes (not on every cache update).
      const m = this.sync.state.movie;
      const sig = m ? this.swarm.holders(m).join(',') : '';
      if (sig !== this._holderSig) {
        this._holderSig = sig;
        this._renderStage();
        if ($('movie-dialog').open) this._renderMovieDialog();
      }
    });
    this.player.addEventListener('unload', () => {
      if (this.swarm.film?.local) this.swarm.closeFilm(); // a streamed film closes with its RemoteFile
    });
    this.drive = null; // DriveClient when the admin attached a Google Drive folder to this room
    this.driveFolder = '';
    this._driveToken = 0;
    this._setDrive(welcome.drive);

    if (new URLSearchParams(location.search).has('debug')) window.room = this;
    document.title = `${roomName} · Three-Eight`;
    $('room-title').textContent = roomName;
    show('room');

    this._initTiles();
    this._initToolbar();
    this._initScreen(); // before the movie: both decide who gets the stage
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

  leave(explicit) {
    if (this.left) return;
    this.left = true;
    try {
      this.lock?.release();
    } catch {
      /* ignore */
    }
    this.closePip();
    this.drive?.endSession(); // clear the Drive cookie: it would outlive the page
    this.sync.destroy();
    this.screen?.destroy();
    this.player.unload();
    this.swarm.destroy();
    this.mesh.close();
    this.media.stop();
    this.signaling.close();
    for (const t of this.tiles.values()) t.stopLevel?.();
    if (explicit) show('message');
  }
}

// The Room is the glue: it owns the state and wires the parts together. Each part (room/*.js) is a class
// whose methods are installed on the Room, so they keep using `this.sync`, `this._renderStage()` etc.
for (const part of [Tiles, Toolbar, Chat, Movie, MovieMenus, DriveBrowser, Pip, Settings, Keyboard, Screen]) mixin(Room, part);
