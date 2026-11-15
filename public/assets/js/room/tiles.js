// Video tiles (one per participant), profiles and the people list.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { watchLevel } from '../media.js';
import { $, toast, icon, colorFor, initials } from './util.js';

export class Tiles {
  profileOf(peerId) {
    if (peerId === this.id) return { name: this.name, audio: this.media.micOn && !!this.media.audioTrack, video: !!this.media.videoTrack };
    return this.profiles.get(peerId) || { name: this.mesh.peers.get(peerId)?.name || 'Guest', audio: false, video: false };
  }

  _broadcastProfile(peer) {
    const msg = { type: 'profile', name: this.name, audio: this.media.micOn && !!this.media.audioTrack, video: !!this.media.videoTrack };
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
      if (!this.profiles.has(peer.id)) this.profiles.set(peer.id, { name: peer.name || 'Guest', audio: false, video: false });
      if (!this.tiles.has(peer.id)) this._makeTile(peer.id, false); // a rebuilt link keeps its tile
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
      const mic = icon(p.audio ? 'mic' : 'mic-off');
      if (!p.audio) mic.classList.add('bad');
      const cam = icon(p.video ? 'cam' : 'cam-off');
      if (!p.video) cam.classList.add('bad');
      li.append(av, who, mic, cam);
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
