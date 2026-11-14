// Watch-party synchronization.
//
// Every participant keeps a copy of a small shared "playback state". Any
// participant can change it (play, pause, seek, change tracks); the change is
// broadcast over the data channels and the newest version wins
// (Lamport-style counter, ties broken by participant id). Positions are
// expressed against the shared server clock, so each browser can compute
// where the movie should be "right now" and gently correct drift.

const DRIFT_SEEK = 1.0; // seconds off → hard seek
const DRIFT_NUDGE = 0.06; // seconds off → adjust playback speed

export function emptyState() {
  return { seq: 0, by: '', movie: null, paused: true, pos: 0, at: 0, rate: 1, audio: 0, sub: null, subFiles: [] };
}

function newer(a, b) {
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.by > b.by;
}

const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const DRIVE_KEY = /^[A-Za-z0-9_-]{0,200}$/;

/** A peer's movie info with its Google Drive reference validated (it ends up in request URLs and headers). */
function cleanMovie(movie) {
  if (!movie || typeof movie !== 'object') return movie;
  const d = movie.drive;
  if (d === undefined) return movie;
  const { drive, ...rest } = movie;
  if (d && typeof d === 'object' && typeof d.id === 'string' && DRIVE_ID.test(d.id) && typeof d.resourceKey === 'string' && DRIVE_KEY.test(d.resourceKey)) {
    rest.drive = { id: d.id, resourceKey: d.resourceKey };
  }
  return rest;
}

export function sameMovie(a, b) {
  if (!a || !b) return false;
  if (a.size && b.size && a.size === b.size) return true;
  return a.name === b.name && Math.abs((a.duration || 0) - (b.duration || 0)) < 2;
}

export class MovieSync extends EventTarget {
  constructor({ mesh, signaling, player, selfId }) {
    super();
    this.mesh = mesh;
    this.signaling = signaling;
    this.player = player;
    this.selfId = selfId;
    this.state = emptyState();
    this.subTexts = new Map(); // external subtitle id -> {id, name, text}
    this.peerStatus = new Map(); // peerId -> {file, ready, buffering}
    this.localFile = null; // {name, size, duration} of the file we loaded
    this.useAnyway = false; // user accepted a file that doesn't match
    this.seekLatency = 0.15;
    this.blocked = false;
    this._selfUntil = 0; // media events before this time were caused by our own code

    mesh.addEventListener('message', (e) => this._onMessage(e.detail.peer, e.detail.msg));
    mesh.addEventListener('channel-open', (e) => this._hello(e.detail.peer));
    mesh.addEventListener('peer-removed', (e) => {
      this.peerStatus.delete(e.detail.peer.id);
      this._emit('status');
    });
    for (const ev of ['waiting', 'playing', 'canplay', 'seeked']) player.addEventListener(ev, () => this._sendStatus());
    player.addEventListener('ended', () => this._sendStatus());
    // System PiP windows (Safari, Firefox) toggle the <video> directly.
    player.addEventListener('play', () => this._onMediaEvent('play'));
    player.addEventListener('pause', () => this._onMediaEvent('pause'));
    player.addEventListener('reloading', () => this.expectMediaChange(3000));
    this._timer = setInterval(() => this._tick(), 500);
  }

  /** Call right before code that makes the <video> play, pause, seek or move. */
  expectMediaChange(ms = 500) {
    this._selfUntil = Math.max(this._selfUntil, performance.now() + ms);
  }

  _onMediaEvent(kind) {
    const p = this.player;
    const v = p.video;
    if (performance.now() < this._selfUntil) return;
    if (!p.loaded || !this.fileMatches || v.ended || v.seeking) return;
    // A hidden tab (e.g. iOS backgrounding) may pause media by itself; only
    // trust events while the user can actually see or use the video.
    const watching = document.visibilityState === 'visible' || document.pictureInPictureElement === v || !('pictureInPictureEnabled' in document);
    if (!watching) return;
    if (kind === 'pause' && !this.state.paused) this.pause();
    else if (kind === 'play' && this.state.paused) this.play();
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  now() {
    return this.signaling.now();
  }

  /** Where the movie should be right now according to the shared state. */
  expectedPosition(s = this.state) {
    if (s.paused) return s.pos;
    const t = s.pos + ((this.now() - s.at) / 1000) * (s.rate || 1);
    const d = s.movie?.duration;
    return d ? Math.min(t, d) : t;
  }

  get fileMatches() {
    return !!this.localFile && (this.useAnyway || sameMovie(this.localFile, this.state.movie));
  }

  // ---- local actions -------------------------------------------------------
  _commit(patch) {
    const next = { ...this.state, ...patch, seq: this.state.seq + 1, by: this.selfId };
    this.state = next;
    this.mesh.broadcast({ type: 'sync-state', state: next });
    this._apply(true);
    this._emit('state');
  }

  /** User picked a file. `asRoomMovie` makes it the room's movie. */
  setLocalFile(info, asRoomMovie) {
    this.localFile = info;
    this.useAnyway = false;
    if (asRoomMovie || !this.state.movie) {
      this._commit({ movie: info, paused: true, pos: 0, at: this.now(), audio: 0, sub: null, subFiles: [] });
    } else {
      if (!sameMovie(info, this.state.movie)) this.useAnyway = true;
      this._apply(true);
    }
    this._sendStatus();
    this._emit('state');
  }

  clearLocalFile() {
    this.localFile = null;
    this.useAnyway = false;
    this._sendStatus();
    this._emit('state');
  }

  closeMovie() {
    this._commit({ movie: null, paused: true, pos: 0, sub: null, subFiles: [] });
  }

  play() {
    const d = this.state.movie?.duration || this.player.duration;
    let pos = this.fileMatches ? this.player.time : this.expectedPosition();
    if (d && pos >= d - 0.5) pos = 0;
    this._commit({ paused: false, pos, at: this.now() });
  }

  pause() {
    const pos = this.fileMatches ? this.player.time : this.expectedPosition();
    this._commit({ paused: true, pos, at: this.now() });
  }

  toggle() {
    const d = this.state.movie?.duration;
    const ended = d && this.expectedPosition() >= d - 0.5;
    if (this.state.paused || ended) this.play();
    else this.pause();
  }

  seek(pos) {
    this._commit({ pos: Math.max(0, pos), at: this.now() });
  }

  setAudio(index) {
    this._commit({ audio: index });
  }

  setSubtitle(id) {
    this._commit({ sub: id });
  }

  addSubtitleFile(entry) {
    this.subTexts.set(entry.id, entry);
    this.player.addExternalSubtitle(entry.id, entry.name, entry.text);
    this.mesh.broadcast({ type: 'sub-file', ...entry });
    const subFiles = this.state.subFiles.filter((s) => s.id !== entry.id).concat([{ id: entry.id, name: entry.name }]);
    this._commit({ subFiles, sub: entry.id });
  }

  // ---- applying the shared state to the local player ------------------------------
  async _apply(force) {
    const s = this.state;
    const p = this.player;
    if (!this.fileMatches || !p.loaded) return;

    if (p.audioIndex !== s.audio && s.audio < (p.audioTracks?.length || 0)) {
      this.expectMediaChange(1000);
      await p.setAudioTrack(s.audio);
      this.expectMediaChange(1000);
    }
    const subId = s.sub && p.subtitles.has(s.sub) ? s.sub : null;
    if (p.subtitleId !== subId) p.setSubtitle(subId);

    const target = this.expectedPosition();
    const diff = p.time - target;
    if (s.paused) {
      this.expectMediaChange();
      if (!p.paused) p.pause();
      p.playbackRate = 1;
      if (Math.abs(diff) > 0.15 || force) {
        if (Math.abs(diff) > 0.03) p.seek(target);
      }
      return;
    }
    const d = s.movie?.duration || p.duration;
    if (d && target >= d - 0.25) {
      // Movie is over for everyone.
      this.expectMediaChange();
      if (!p.paused) p.pause();
      return;
    }
    if (Math.abs(diff) > (force ? 0.3 : DRIFT_SEEK)) this._seekTo(target + this.seekLatency);
    if (p.paused) {
      this.expectMediaChange();
      try {
        await p.play();
        this.blocked = false;
      } catch (err) {
        if (err?.name === 'NotAllowedError') {
          this.blocked = true;
          this._emit('blocked');
        }
      }
    }
  }

  _seekTo(t) {
    const p = this.player;
    const started = performance.now();
    this.expectMediaChange();
    p.seek(t);
    const onSeeked = () => {
      p.removeEventListener('playing', onSeeked);
      const took = (performance.now() - started) / 1000;
      // Learn how long seeks take so we land on time next time.
      this.seekLatency = Math.min(2, Math.max(0.05, this.seekLatency * 0.6 + took * 0.4));
    };
    p.addEventListener('playing', onSeeked);
  }

  /** User clicked the "start playback" overlay after an autoplay block. */
  async unblock() {
    this.blocked = false;
    this.expectMediaChange();
    try {
      await this.player.play();
    } catch {
      /* ignore */
    }
    this._apply(true);
  }

  _tick() {
    const s = this.state;
    const p = this.player;
    if (!this.fileMatches || !p.loaded) return;
    if (s.paused || p.paused || p.video.seeking || p.video.readyState < 3) {
      if (!s.paused && p.paused && !this.blocked) this._apply(false);
      if (p.playbackRate !== 1) p.playbackRate = 1;
      return;
    }
    const diff = p.time - this.expectedPosition();
    if (Math.abs(diff) > DRIFT_SEEK) {
      this._seekTo(this.expectedPosition() + this.seekLatency);
      p.playbackRate = 1;
    } else if (Math.abs(diff) > DRIFT_NUDGE) {
      // Catch up / slow down smoothly (up to ±8%) instead of jumping.
      const rate = 1 - Math.max(-0.08, Math.min(0.08, diff * 0.5));
      p.playbackRate = Math.round(rate * 100) / 100;
    } else if (p.playbackRate !== 1) {
      p.playbackRate = 1;
    }
  }

  // ---- network ----------------------------------------------------------------
  _hello(peer) {
    if (this.state.seq > 0) peer.send({ type: 'sync-state', state: this.state });
    peer.send({ type: 'sync-status', ...this._myStatus() });
  }

  _myStatus() {
    const p = this.player;
    return {
      file: this.localFile && { name: this.localFile.name, size: this.localFile.size, duration: this.localFile.duration },
      matches: this.fileMatches,
      buffering: this.fileMatches && p.loaded && !this.state.paused && p.video.readyState < 3,
    };
  }

  _sendStatus() {
    const st = this._myStatus();
    const key = JSON.stringify(st);
    if (key === this._lastStatus) return;
    this._lastStatus = key;
    this.mesh.broadcast({ type: 'sync-status', ...st });
  }

  _onMessage(peer, msg) {
    switch (msg.type) {
      case 'sync-state': {
        const s = msg.state;
        if (!s || typeof s.seq !== 'number' || typeof s.by !== 'string') return;
        if (!newer(s, this.state)) return;
        const prev = this.state;
        this.state = { ...emptyState(), ...s, movie: cleanMovie(s.movie) ?? null, subFiles: Array.isArray(s.subFiles) ? s.subFiles.slice(0, 50) : [] };
        if (!sameMovie(prev.movie, this.state.movie)) this.useAnyway = false;
        // Fetch any shared subtitle file we don't have yet.
        for (const f of this.state.subFiles) {
          if (f && typeof f.id === 'string' && !this.subTexts.has(f.id)) peer.send({ type: 'sub-request', id: f.id });
        }
        this._emit('remote-change', { peer, prev, state: this.state });
        this._apply(true);
        this._emit('state');
        this._sendStatus();
        break;
      }
      case 'sync-status':
        this.peerStatus.set(peer.id, {
          file: msg.file && typeof msg.file === 'object' ? { name: String(msg.file.name || ''), size: Number(msg.file.size) || 0, duration: Number(msg.file.duration) || 0 } : null,
          matches: !!msg.matches,
          buffering: !!msg.buffering,
        });
        this._emit('status');
        break;
      case 'sub-request': {
        const entry = this.subTexts.get(msg.id);
        if (entry) peer.send({ type: 'sub-file', ...entry });
        break;
      }
      case 'sub-file': {
        if (typeof msg.id !== 'string' || typeof msg.text !== 'string' || this.subTexts.has(msg.id)) return;
        if (msg.text.length > 5 * 1024 * 1024) return;
        const entry = { id: msg.id, name: String(msg.name || 'Subtitles').slice(0, 120), text: msg.text };
        this.subTexts.set(entry.id, entry);
        this.player.addExternalSubtitle(entry.id, entry.name, entry.text);
        this._apply(false);
        break;
      }
      default:
        break;
    }
  }

  destroy() {
    clearInterval(this._timer);
  }
}
