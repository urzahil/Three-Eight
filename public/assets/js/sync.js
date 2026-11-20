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
  // At the cap _commit() cannot go higher, so the tie-break by `by` could freeze the room (a hostile peer sending
  // `by: '\uffff'.repeat(64)` would win every tie) or split it (the committer has the lower id). There the arriving
  // state wins: last writer wins by arrival. Harmless: a received state is never re-broadcast, so nothing loops.
  if (a.seq === MAX_SEQ) return true;
  return a.by > b.by;
}

const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** A peer's movie info with its Google Drive reference validated (it ends up in request URLs). */
function cleanMovie(movie) {
  if (!movie || typeof movie !== 'object') return movie;
  const d = movie.drive;
  if (d === undefined) return movie;
  const { drive, ...rest } = movie;
  if (d && typeof d === 'object' && typeof d.id === 'string' && DRIVE_ID.test(d.id)) {
    rest.drive = { id: d.id };
    // The folder the video was listed in (where its subtitle files live); optional.
    if (typeof d.folder === 'string' && DRIVE_ID.test(d.folder)) rest.drive.folder = d.folder;
  }
  return rest;
}

// Absolute cap on seq (`seq + 1` stays exact up to here); cleanState() rejects anything above it. A peer can
// still send a seq at the cap. Then _commit() cannot go higher: it clamps to MAX_SEQ, which is still a value
// peers accept, and at the cap newer() lets the arriving state win (see there), so every commit is accepted by
// the others. Nothing throws and nothing is sent that peers would reject.
const MAX_SEQ = Number.MAX_SAFE_INTEGER - 1;
const MAX_POS = 1e7; // seconds (about 115 days)
const MAX_AT = 1e14; // epoch milliseconds (year 5138)
const MAX_ID = 64; // participant ids are at most 64 characters
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const short = (v, max) => String(v).slice(0, max);
const clamp = (n, lo, hi) => (isNum(n) ? Math.min(hi, Math.max(lo, n)) : lo);

/**
 * Validate and normalise a sync-state from a peer. Returns null when its core fields (seq, by, paused,
 * pos, at) are unusable or the movie is malformed; the other fields are clamped to sane values.
 */
export function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  if (!Number.isSafeInteger(s.seq) || s.seq < 0 || s.seq > MAX_SEQ) return null;
  if (typeof s.by !== 'string' || !s.by || s.by.length > MAX_ID) return null;
  if (typeof s.paused !== 'boolean' || !isNum(s.pos) || s.pos < 0 || s.pos > MAX_POS || !isNum(s.at) || s.at < 0 || s.at > MAX_AT) return null;
  let movie = null;
  if (s.movie != null) {
    const m = s.movie;
    if (typeof m !== 'object' || Array.isArray(m) || typeof m.name !== 'string') return null;
    movie = cleanMovie({
      name: short(m.name, 300),
      size: isNum(m.size) && m.size >= 0 ? m.size : 0,
      duration: isNum(m.duration) && m.duration >= 0 ? m.duration : 0,
      ...(m.drive !== undefined && { drive: m.drive }),
      ...(typeof m.fp === 'string' && FP_RE.test(m.fp) && { fp: m.fp }),
    });
  }
  const subFiles = [];
  if (Array.isArray(s.subFiles)) {
    for (const f of s.subFiles.slice(0, 50)) {
      if (f && typeof f.id === 'string' && f.id && typeof f.name === 'string') subFiles.push({ id: short(f.id, 100), name: short(f.name, 120) });
    }
  }
  return {
    seq: s.seq,
    by: s.by,
    movie,
    paused: s.paused,
    pos: s.pos,
    at: s.at,
    rate: isNum(s.rate) ? Math.min(4, Math.max(0.25, s.rate)) : 1,
    audio: Number.isSafeInteger(s.audio) ? Math.min(64, Math.max(0, s.audio)) : 0,
    sub: typeof s.sub === 'string' && s.sub ? short(s.sub, 100) : null,
    subFiles,
  };
}

const DURATION_TOLERANCE = 2; // seconds
const FP_RE = /^[0-9a-f]{32}$/; // content fingerprint (swarm.js computeFingerprint), optional in a movie

/**
 * Is `b` the film `a` describes? When both carry a content fingerprint (a sample of the file's bytes, see
 * swarm.js), it decides. Otherwise equal sizes match even when the names differ (a renamed copy), unless both
 * durations are known and differ: two different films of the same size are rare but not impossible. Without
 * a usable size, the name and the duration decide.
 */
export function sameMovie(a, b) {
  if (!a || !b) return false;
  if (a.fp && b.fp) return a.fp === b.fp;
  const da = a.duration || 0;
  const db = b.duration || 0;
  const durationsDiffer = da > 0 && db > 0 && Math.abs(da - db) >= DURATION_TOLERANCE;
  if (a.size && b.size && a.size === b.size) return !durationsDiffer;
  return a.name === b.name && Math.abs(da - db) < DURATION_TOLERANCE;
}

const MAX_EARLY_SUBS = 4;

export class MovieSync extends EventTarget {
  constructor({ mesh, signaling, player, selfId }) {
    super();
    this.mesh = mesh;
    this.signaling = signaling;
    this.player = player;
    this.selfId = selfId;
    this.state = emptyState();
    this.subTexts = new Map(); // external subtitle id -> {id, name, text}, only for files the room shares now
    this.subAsked = new Map(); // shared subtitle id we lack -> ids of the peers already asked for it
    this.subEarly = new Map(); // files that arrived before the state that lists them (the sharer sends the file first)
    // Our own subtitle choice, never shared: undefined follows the room, null is off just for us, otherwise a
    // track id. It lasts until the room picks another subtitle or another movie.
    this.mySub = undefined;
    // Subtitle files we loaded only for ourselves (id -> {id, name}): never sent to peers, dropped with the movie.
    this.myFiles = new Map();
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

  /** The subtitle this browser shows: our own choice if we made one, else the room's. */
  get subtitle() {
    return this.mySub !== undefined ? this.mySub : this.state.sub;
  }

  /** Forget our own subtitle choice when the room moves on (another subtitle or movie). True if there was one. */
  _resetMySub(prev, next) {
    if (!sameMovie(prev.movie, next.movie)) this._dropMyFiles();
    if (this.mySub === undefined || (prev.sub === next.sub && sameMovie(prev.movie, next.movie))) return false;
    this.mySub = undefined;
    return true;
  }

  get fileMatches() {
    return !!this.localFile && (this.useAnyway || sameMovie(this.localFile, this.state.movie));
  }

  // ---- local actions -------------------------------------------------------
  _commit(patch) {
    // Whatever the patch holds, peers must accept the result: keep every number inside the range cleanState() allows.
    const next = { ...this.state, ...patch, seq: Math.min(this.state.seq + 1, MAX_SEQ), by: this.selfId };
    next.pos = clamp(next.pos, 0, MAX_POS);
    next.at = clamp(next.at, 0, MAX_AT);
    this._resetMySub(this.state, next);
    this.state = next;
    this.mesh.broadcast({ type: 'sync-state', state: next });
    this._syncSubtitles();
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

  /**
   * Is the film over? By the room's clock, or because our own copy ended: its last frame can come well before the
   * duration the container states (an MKV's Info may claim more), so the playhead may stop short of the end.
   */
  atEnd() {
    if (!this.state.movie) return false;
    if (this.fileMatches && this.player.loaded && this.player.video?.ended) return true;
    const d = this.state.movie.duration || this.player.duration;
    if (!d) return false;
    if (this.fileMatches && this.player.loaded && this.player.time >= d - 0.5) return true;
    return this.expectedPosition() >= d - 0.5;
  }

  play() {
    // Play at the end starts over (from the start, not from where our copy happened to stop).
    const pos = this.atEnd() ? 0 : this.fileMatches ? this.player.time : this.expectedPosition();
    this._commit({ paused: false, pos, at: this.now() });
  }

  pause() {
    const pos = this.fileMatches ? this.player.time : this.expectedPosition();
    this._commit({ paused: true, pos, at: this.now() });
  }

  toggle() {
    if (this.state.paused || this.atEnd()) this.play();
    else this.pause();
  }

  seek(pos) {
    this._commit({ pos: Math.max(0, pos), at: this.now() });
  }

  setAudio(index) {
    this._commit({ audio: index });
  }

  /** Change the subtitle for everyone. */
  setSubtitle(id) {
    this.mySub = undefined; // choosing for the room includes us
    this._commit({ sub: id });
  }

  /** Load a subtitle file only for us ({id, name, text}; the id must not collide with shared files') and show it. */
  addMySubtitleFile(entry) {
    this.myFiles.set(entry.id, { id: entry.id, name: entry.name });
    this.player.addExternalSubtitle(entry.id, entry.name, entry.text, 'private');
    this.setMySubtitle(entry.id);
  }

  _dropMyFiles() {
    for (const id of this.myFiles.keys()) this.player.removeExternalSubtitle(id);
    this.myFiles.clear();
  }

  /** Change the subtitle only here (null: off). undefined, or the room's own choice, follows the room again. */
  setMySubtitle(id) {
    this.mySub = id === undefined || id === this.state.sub ? undefined : id;
    this._apply(false);
    this._emit('state');
  }

  _addSubText(entry) {
    this.subTexts.set(entry.id, entry);
    this.player.addExternalSubtitle(entry.id, entry.name, entry.text);
  }

  /** Ask `peer` for the shared subtitle files we still lack: each file once per peer, so another member can answer. */
  _requestSubFiles(peer) {
    for (const f of this.state.subFiles) {
      if (this.subTexts.has(f.id)) continue;
      let asked = this.subAsked.get(f.id);
      if (!asked) this.subAsked.set(f.id, (asked = new Set()));
      if (asked.has(peer.id)) continue;
      asked.add(peer.id);
      peer.send({ type: 'sub-request', id: f.id });
    }
  }

  /** Keep the external subtitles in step with the shared state: add early arrivals, drop files no longer shared. */
  _syncSubtitles() {
    const shared = new Set(this.state.subFiles.map((f) => f.id));
    for (const id of shared) {
      const early = this.subEarly.get(id);
      if (!early) continue;
      this.subEarly.delete(id);
      if (!this.subTexts.has(id)) this._addSubText(early);
    }
    for (const id of [...this.subAsked.keys()]) if (!shared.has(id) || this.subTexts.has(id)) this.subAsked.delete(id);
    for (const id of [...this.subTexts.keys()]) {
      if (shared.has(id)) continue;
      this.subTexts.delete(id);
      this.player.removeExternalSubtitle(id);
    }
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
    const want = this.subtitle;
    const subId = want && p.subtitles.has(want) ? want : null;
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

  /** Monotonic milliseconds for timing seeks. */
  _clock() {
    return performance.now();
  }

  _seekTo(t) {
    const p = this.player;
    const started = this._clock();
    this.expectMediaChange();
    // Only the latest seek is measured. "seeked" always follows a seek ("playing" does not when the target is
    // already buffered, and would then measure until some later resume).
    if (this._onSeeked) p.removeEventListener('seeked', this._onSeeked);
    const onSeeked = () => {
      p.removeEventListener('seeked', onSeeked);
      if (this._onSeeked === onSeeked) this._onSeeked = null;
      const took = (this._clock() - started) / 1000;
      // Learn how long seeks take so we land on time next time; a seek that took ages (stalled, tab in the
      // background) says nothing about the next one.
      if (took < 2.5) this.seekLatency = Math.min(2, Math.max(0.05, this.seekLatency * 0.6 + took * 0.4));
    };
    this._onSeeked = onSeeked;
    p.addEventListener('seeked', onSeeked);
    p.seek(t);
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
      // where the file comes from: our device, Google Drive or friends' copies (through the swarm)
      src: !p.file?.remote ? 'file' : p.file.peerOnly ? 'peers' : 'drive',
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
        const s = cleanState(msg.state);
        if (!s) return;
        if (!newer(s, this.state)) {
          // The same state from another member (each sends theirs when a link opens): the first sender may not
          // have had the subtitle files yet, so ask this one too.
          if (s.seq === this.state.seq && s.by === this.state.by) this._requestSubFiles(peer);
          return;
        }
        const prev = this.state;
        const resetMine = this._resetMySub(prev, s);
        this.state = s;
        if (!sameMovie(prev.movie, this.state.movie)) this.useAnyway = false;
        this._syncSubtitles();
        this._requestSubFiles(peer);
        this._emit('remote-change', { peer, prev, state: this.state, resetMine });
        this._apply(true);
        this._emit('state');
        this._sendStatus();
        break;
      }
      case 'sync-status':
        this.peerStatus.set(peer.id, {
          file: msg.file && typeof msg.file === 'object' ? { name: String(msg.file.name || ''), size: Number(msg.file.size) || 0, duration: Number(msg.file.duration) || 0 } : null,
          matches: !!msg.matches,
          src: msg.src === 'drive' || msg.src === 'peers' ? msg.src : 'file',
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
        if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 100 || typeof msg.text !== 'string' || this.subTexts.has(msg.id)) return;
        if (msg.text.length > 5 * 1024 * 1024) return;
        const entry = { id: msg.id, name: String(msg.name || 'Subtitles').slice(0, 120), text: msg.text };
        if (!this.state.subFiles.some((f) => f.id === entry.id)) {
          // Not shared (yet): the state listing it usually follows right away. Keep a few, not every file a peer sends.
          this.subEarly.delete(entry.id);
          this.subEarly.set(entry.id, entry);
          while (this.subEarly.size > MAX_EARLY_SUBS) this.subEarly.delete(this.subEarly.keys().next().value);
          return;
        }
        this._addSubText(entry);
        this._apply(false);
        break;
      }
      default:
        break;
    }
  }

  destroy() {
    clearInterval(this._timer);
    if (this._onSeeked) this.player.removeEventListener('seeked', this._onSeeked);
    this._onSeeked = null;
  }
}
