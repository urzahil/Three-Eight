import { Signaling } from './signaling.js';
import { Mesh } from './mesh.js';
import { MovieSync } from './sync.js';
import { MoviePlayer } from './player/player.js';
import { LocalMedia, watchLevel, audioContext } from './media.js';
import { Swarm } from './player/swarm.js';
import { $, store, show, showMessage, toast, setIcon, colorFor, initials, randomId, randomSecret, mixin, pipState } from './room/util.js';
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

/**
 * This tab's participant id and the secret that goes with it (kept across reloads, so a rejoin replaces our old
 * connection). The id is visible to everyone in the room; the secret is what lets only this tab take its id over.
 */
function session() {
  try {
    let id = sessionStorage.getItem('te.id');
    let secret = sessionStorage.getItem('te.secret');
    if (!id || !secret) {
      id = randomId();
      secret = randomSecret();
      sessionStorage.setItem('te.id', id);
      sessionStorage.setItem('te.secret', secret);
    }
    return { id, secret };
  } catch {
    return { id: randomId(), secret: randomSecret() }; // storage blocked
  }
}

/** Forget this tab's id: the next session() makes a new one (the old one is in use by somebody else). */
function resetSession() {
  try {
    sessionStorage.removeItem('te.id');
    sessionStorage.removeItem('te.secret');
  } catch {
    /* storage blocked: session() makes a new one anyway */
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

// Leaving the page closes the room's connections (Room.leave on 'pagehide'), which lets the browser keep the page in
// its back/forward cache. Coming back with Back must not show that dead room (or a lobby whose devices are gone).
window.addEventListener('pageshow', (e) => {
  if (e.persisted && roomName) location.reload();
});

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
  if (res.status === 429) {
    showMessage('Please wait', 'Too many rooms that do not exist were tried from your network. Try again in a few minutes.');
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
  // Only a different track needs a new preview stream or level meter (typing the name must not rebuild them).
  let previewVideo;
  let previewAudio;
  const refreshAvatar = () => {
    $('lobby-avatar').textContent = initials($('lobby-name').value || '?');
    $('lobby-avatar').style.background = colorFor($('lobby-name').value || 'x');
  };
  const refreshPreview = () => {
    if (media.videoTrack !== previewVideo) {
      previewVideo = media.videoTrack;
      preview.srcObject = previewVideo ? new MediaStream([previewVideo]) : null;
    }
    preview.hidden = !media.videoTrack;
    $('lobby-avatar').hidden = !!media.videoTrack;
    refreshAvatar();
    $('lobby-mic').classList.toggle('off', !media.micOn || !media.audioTrack);
    setIcon($('lobby-mic'), media.micOn && media.audioTrack ? 'mic' : 'mic-off');
    $('lobby-cam').classList.toggle('off', !media.camOn);
    setIcon($('lobby-cam'), media.camOn ? 'cam' : 'cam-off');
    if (media.audioTrack !== previewAudio) {
      previewAudio = media.audioTrack;
      stopMeter();
      stopMeter = watchLevel(previewAudio, (l) => {
        $('lobby-meter').style.height = media.micOn ? `${Math.round(l * 100)}%` : '0';
      });
    }
  };
  media.addEventListener('change', refreshPreview);
  $('lobby-name').addEventListener('input', () => {
    refreshAvatar();
    audioContext(); // typing is a user gesture: lets a suspended meter's audio context resume
  });
  const fillDevices = async () => {
    const d = await media.devices();
    for (const kind of ['audio', 'video']) {
      const sel = $(`lobby-${kind}-dev`);
      sel.replaceChildren(...d[kind].map((dev, i) => new Option(dev.label || `${kind === 'audio' ? 'Microphone' : 'Camera'} ${i + 1}`, dev.deviceId)));
      sel.value = media.currentDeviceId(kind);
    }
  };
  const changeDevice = async (kind, deviceId) => {
    if (!(await media.setDevice(kind, deviceId))) toast(`Could not start that ${kind === 'audio' ? 'microphone' : 'camera'}.`, 'warn');
    fillDevices(); // shows the device actually in use
  };
  $('lobby-audio-dev').onchange = (e) => changeDevice('audio', e.target.value);
  $('lobby-video-dev').onchange = (e) => changeDevice('video', e.target.value);
  $('lobby-mic').onclick = async () => {
    if (!(await media.toggleMic())) toast('Could not access a microphone.', 'warn');
  };
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
      let me = session();
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const connect = () => {
        signaling?.close();
        signaling = new Signaling(`${proto}//${location.host}/ws`);
        signaling.addEventListener('retrying', (ev) => {
          $('lobby-join').textContent = ev.detail.busy ? 'The server is busy, retrying…' : `Can’t reach the server, retrying (${ev.detail.attempt})…`;
        });
        return signaling.join({ room: info.name, id: me.id, secret: me.secret, name, password });
      };
      let welcome;
      try {
        welcome = await connect();
      } catch (err) {
        if (err.code !== 'id-taken') throw err;
        // Somebody else's connection holds our id (everyone in the room can see it): join with a new one.
        resetSession();
        me = session();
        welcome = await connect();
      }
      const id = me.id;
      store.set(pwKey, $('lobby-remember').checked && password ? password : null);
      store.set('media', { mic: media.micOn, cam: media.camOn, audioDevice: media.deviceIds.audio, videoDevice: media.deviceIds.video });
      inLobby = false;
      stopMeter();
      media.removeEventListener('change', refreshPreview);
      preview.srcObject = null;
      // If the devices are still pending, the Room picks them up from the media 'change' events when they come.
      // ICE servers (with TURN credentials, when the server has TURN) come with the welcome: only members get them.
      new Room({ signaling, welcome, media, name, id, iceServers: Array.isArray(welcome.iceServers) ? welcome.iceServers : [], roomName: welcome.room || info.name });
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
      if (Array.isArray(e.detail?.iceServers)) this.mesh.setIceServers(e.detail.iceServers); // fresh TURN credentials
    });
    signaling.addEventListener('ice', (e) => this.mesh.setIceServers(e.detail)); // renewed before the old ones expire
    signaling.addEventListener('drive', (e) => this._setDrive(e.detail));
    signaling.addEventListener('fatal', (e) => {
      const { code } = e.detail;
      // A reload must not come back with an id that somebody else holds.
      if (code === 'id-taken') resetSession();
      this.leave(false);
      if (code === 'bad-password') {
        // Changed by the admin while we were reconnecting: the remembered one no longer opens the room.
        store.set('pw.' + roomName.toLowerCase(), null);
        showMessage('The room password changed', 'The room password was changed while you were disconnected. Rejoin with the new password.');
      } else {
        showMessage('Disconnected', e.detail.message || 'You were disconnected from the room.');
      }
      // Removed by the admin, or the room is gone: rejoining is not the way on.
      if (code !== 'kicked' && code !== 'room-deleted' && code !== 'no-room') this._offerRejoin();
    });
    // This tab's id joined again elsewhere (a duplicated tab shares it): that connection took over, this one is done.
    signaling.addEventListener('replaced', () => {
      // The other tab uses the same Drive cookie: leave it in place.
      this.leave(false, { keepDriveSession: true });
      showMessage('Opened in another tab', 'You joined this room again in another tab or window, so this one was disconnected. Rejoin to use this one instead.');
      this._offerRejoin();
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
    // The visibilitychange listener outlives the room: once left, coming back to the tab must not lock the screen.
    if (this.left) return;
    try {
      const lock = await navigator.wakeLock?.request('screen');
      if (this.left) {
        lock?.release(); // left while the request was pending
        return;
      }
      this.lock = lock;
    } catch {
      /* not supported */
    }
  }

  _setConn(text) {
    $('conn-status').textContent = text;
    $('conn-status').hidden = !text;
  }

  /** `keepDriveSession`: another tab of this browser still uses the Drive cookie, so it is not cleared. */
  leave(explicit, { keepDriveSession = false } = {}) {
    if (this.left) return;
    this.left = true;
    document.removeEventListener('keydown', this._onKeydown);
    document.removeEventListener('click', this._onDocClick);
    clearInterval(this._timeTimer);
    try {
      this.lock?.release();
    } catch {
      /* ignore */
    }
    this.closePip();
    if (keepDriveSession) {
      if (this.drive) this.drive.ended = true; // never set it again from here
    } else this.drive?.endSession(); // clear the Drive cookie: it would outlive the page
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
