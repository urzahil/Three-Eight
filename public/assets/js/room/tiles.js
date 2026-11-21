// Video tiles (one per participant), profiles and the people list.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { watchLevel } from '../media.js';
import { $, store, toast, icon, setIcon, colorFor, initials } from './util.js';

const PEER_VOLUME_NAMES = 100; // people whose volume (just for you) is remembered, by name
const LONG_PRESS_MS = 500; // a touch held this long on a tile shows its volume control

let volumeWorks = null;
/** Does `volume` work on media elements? iOS Safari ignores it (always 1): only mute is offered there. */
function canSetVolume() {
  if (volumeWorks === null) {
    const a = document.createElement('audio');
    try {
      a.volume = 0.5;
    } catch {
      /* read-only */
    }
    volumeWorks = a.volume === 0.5;
  }
  return volumeWorks;
}

export class Tiles {
  profileOf(peerId) {
    if (peerId === this.id) return { name: this.name, audio: this.media.micOn && !!this.media.audioTrack, video: !!this.media.videoTrack, screen: this.screenSince || 0 };
    return this.profiles.get(peerId) || { name: this.mesh.peers.get(peerId)?.name || 'Guest', audio: false, video: false, screen: 0 };
  }

  _broadcastProfile(peer) {
    const msg = { type: 'profile', name: this.name, audio: this.media.micOn && !!this.media.audioTrack, video: !!this.media.videoTrack, screen: this.screenSince || 0 };
    if (peer) peer.send(msg);
    else this.mesh.broadcast(msg);
  }

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
      if (!this.profiles.has(peer.id)) this.profiles.set(peer.id, { name: peer.name || 'Guest', audio: false, video: false, screen: 0 });
      if (!this.tiles.has(peer.id)) this._makeTile(peer.id, false); // a rebuilt link keeps its tile
      this._restorePeerVolume(peer.id);
      this._updateTile(peer.id);
      this._renderPeople();
    });
    this.mesh.addEventListener('peer-removed', (e) => {
      const peer = e.detail.peer;
      const t = this.tiles.get(peer.id);
      if (e.detail.rebuilding) {
        // Same person, new connection: keep the tile and the profile, no "left" message. The picture
        // comes back with the new connection's tracks.
        if (t) {
          t.video.srcObject = null;
          t.state.textContent = 'connecting…';
          t.state.hidden = false;
        }
        this._renderPeople();
        return;
      }
      t?.stopLevel?.();
      if (t) this.output?.detach(t.video);
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
        // screen: when their share started (room clock), 0 when they don't share. A peer is not trusted: anything
        // but a positive finite number means "not sharing".
        const screen = typeof msg.screen === 'number' && Number.isFinite(msg.screen) && msg.screen > 0 ? msg.screen : 0;
        this.profiles.set(peer.id, { name, audio: !!msg.audio, video: !!msg.video, screen, seen: true });
        if (name !== prev?.name) this._restorePeerVolume(peer.id); // known by another name: maybe set for that one
        if (first) this._systemMessage(`${name} joined`);
        this._updateTile(peer.id);
        this._renderPeople();
      }
    });
    // A tap outside a volume control opened by a long press closes it.
    document.addEventListener('pointerdown', (e) => {
      for (const t of this.tiles.values()) if (t.vol && !t.vol.contains(e.target)) t.el.classList.remove('vol-open');
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
    if (!self) this.output?.attach(video); // the speakers or headphones chosen in Settings (see room/settings.js)
    const tile = { el, video, avatar, nameEl, micIcon, state };
    this.tiles.set(id, tile);
    if (!self) this._makeTileVolume(id, tile);
    this._layout();
    return tile;
  }

  /**
   * A remote person's volume and mute, only for us: their sound plays through their tile's <video>. The control shows
   * on hover (or keyboard focus), and on touch screens after a long press on the tile. The speaking indicator is not
   * affected: it shows that they speak, whatever we hear.
   */
  _makeTileVolume(id, tile) {
    const vol = document.createElement('div');
    vol.className = 'tile-vol';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn';
    btn.append(icon('volume'));
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '1';
    range.step = '0.05';
    range.hidden = !canSetVolume(); // iOS: mute only
    vol.append(btn, range);
    tile.el.append(vol);
    Object.assign(tile, { vol, volBtn: btn, volRange: range });
    btn.onclick = () => this._setPeerVolume(id, { muted: !tile.video.muted });
    range.oninput = () => this._setPeerVolume(id, { volume: Number(range.value), muted: false });
    // Long press (touch): show the control. Android announces the long press as 'contextmenu' too: that shows the
    // control instead of the browser's own menu for the video (save, share...).
    let timer = 0;
    let start = null;
    let touchedAt = 0;
    const open = () => tile.el.classList.add('vol-open');
    const cancel = () => {
      clearTimeout(timer);
      start = null;
    };
    tile.el.addEventListener('pointerdown', (e) => {
      cancel();
      if (e.pointerType !== 'touch' || vol.contains(e.target)) return;
      touchedAt = Date.now();
      start = { x: e.clientX, y: e.clientY };
      timer = setTimeout(open, LONG_PRESS_MS);
    });
    tile.el.addEventListener('pointermove', (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); // scrolling the tile strip
    });
    for (const type of ['pointerup', 'pointercancel']) tile.el.addEventListener(type, cancel);
    tile.el.addEventListener('contextmenu', (e) => {
      if (Date.now() - touchedAt > 2000) return; // a right click keeps its menu
      e.preventDefault();
      open();
    });
    this._refreshTileVolume(id);
  }

  /** Change someone's volume and/or mute for us, and remember it under their name. */
  _setPeerVolume(id, { volume, muted }) {
    const t = this.tiles.get(id);
    if (!t?.vol) return;
    if (volume !== undefined && Number.isFinite(volume)) t.video.volume = Math.max(0, Math.min(1, volume));
    if (muted !== undefined) t.video.muted = muted;
    const name = this.profileOf(id).name;
    const list = this._savedPeerVolumes().filter((e) => e[0] !== name);
    if (t.video.muted || t.video.volume < 1) list.push([name, t.video.volume, t.video.muted]);
    store.set('peerVolume', list.length ? list.slice(-PEER_VOLUME_NAMES) : null);
    this._refreshTileVolume(id);
    this._renderPeople();
  }

  /** [name, volume, muted] for the most recent PEER_VOLUME_NAMES people set to something else than full and unmuted. */
  _savedPeerVolumes() {
    const list = store.get('peerVolume', []);
    return Array.isArray(list)
      ? list.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1 && typeof e[2] === 'boolean')
      : [];
  }

  /**
   * Their name is known (they joined, or renamed themselves): use what we set for that name, if anything. Ids change
   * with every tab, so names are what is remembered. Without a saved setting, the tile keeps what it has.
   */
  _restorePeerVolume(id) {
    const t = this.tiles.get(id);
    if (!t?.vol) return;
    const saved = this._savedPeerVolumes().find((e) => e[0] === this.profileOf(id).name);
    if (saved) {
      t.video.volume = saved[1];
      t.video.muted = saved[2];
    }
    this._refreshTileVolume(id);
  }

  _refreshTileVolume(id) {
    const t = this.tiles.get(id);
    if (!t?.vol) return;
    const name = this.profileOf(id).name;
    const v = t.video;
    const silent = v.muted || v.volume === 0;
    t.el.classList.toggle('muted-for-me', silent);
    setIcon(t.volBtn, silent ? 'volume-off' : 'volume');
    t.volBtn.title = v.muted ? `Unmute ${name} (muted just for you)` : `Mute ${name} just for you`;
    t.volBtn.setAttribute('aria-label', t.volBtn.title);
    t.volRange.value = v.muted ? 0 : v.volume;
    t.volRange.setAttribute('aria-label', `${name}’s volume, just for you`);
    t.volRange.title = `${name}’s volume, just for you: ${Math.round(v.volume * 100)}%`;
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
    this._refreshTileVolume(id); // its labels name them
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
        small.textContent = !st || !st.file ? 'no movie file loaded' : st.matches ? (st.buffering ? 'loading…' : this._sourceText(id, st.src)) : 'different file';
        who.append(small);
      }
      const v = id !== this.id && this.tiles.get(id)?.video;
      if (v && (v.muted || v.volume < 1)) {
        const small = document.createElement('small');
        small.className = 'for-you';
        small.textContent = v.muted || v.volume === 0 ? 'muted for you' : `volume ${Math.round(v.volume * 100)}% for you`;
        who.append(small);
      }
      const mic = icon(p.audio ? 'mic' : 'mic-off');
      if (!p.audio) mic.classList.add('bad');
      const cam = icon(p.video ? 'cam' : 'cam-off');
      if (!p.video) cam.classList.add('bad');
      li.append(av, who);
      if (p.screen) {
        const sc = icon('screen');
        sc.classList.add('good');
        sc.setAttribute('aria-label', 'sharing their screen');
        li.append(sc);
      }
      li.append(mic, cam);
      return li;
    }));
  }

  /** "own copy", "streaming (Drive)" or "streaming (from Alice)" for someone whose movie file is loaded and matches. */
  _sourceText(id, src) {
    if (id === this.id) src = !this.player.file?.remote ? 'file' : this.player.file.peerOnly ? 'peers' : 'drive';
    if (src === 'drive') return 'streaming (Drive)';
    if (src === 'peers') {
      const holders = this.sync.state.movie ? this.swarm.holders(this.sync.state.movie).filter((h) => h !== id) : [];
      return holders.length === 1 ? `streaming (from ${this.profileOf(holders[0]).name})` : 'streaming (from friends)';
    }
    return 'own copy';
  }
}
