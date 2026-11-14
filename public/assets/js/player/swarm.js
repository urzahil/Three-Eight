// Sharing a film between the viewers of a room, over the WebRTC film channel (mesh.js, channel id 1).
//
// The film is split into 1 MiB pieces (aligned: piece = floor(byte / 1 MiB); the last one is shorter).
// A viewer that streams the film reads it through a RemoteFile whose `request` is `film.request` (below):
// for every missing byte range, whole pieces are fetched from friends or, for a Google Drive film, from
// our server. The RemoteFile block cache is the piece store; pieces that arrive are injected into it, so
// they can be served to other viewers too.
//
// Film identity ("key"): `d:<driveId>` for a film from the room's Drive folder, `s:<size>` for a film
// that is a file on someone's device. A Drive film and a local copy of the same size are the same film
// (this is the same rule as sync.js `sameMovie`), so local copies can serve a Drive film.
//
// INTEGRITY: there are no per-piece hashes. Matching by size is the trust model between friends that the
// app already has (everybody picks their own copy of a file, and only its size is compared). A friend
// who deliberately sends wrong bytes can make your player show garbage; it can't do more than that,
// because every message is validated (see decodeFrame and the checks in Swarm) and bytes only ever go
// to the demuxer, like any file.
//
// PROTOCOL
//   Channel 0 (JSON, mesh.js `send`):
//     { type: 'film-have', key: string|null, local: bool, ranges: [[firstPiece, lastPiece], ...], via: 'file'|'drive'|'peers' }
//       what this viewer can serve for the film it has open (key null: nothing). `local` = the whole file
//       is on this device. `ranges` = pieces completely in its cache (merged, at most 32 ranges).
//       Sent on change, at most once a second, and to every new peer.
//   Channel 1 (binary frames, little endian), header of 16 bytes + payload:
//       u8 type | u8 flags | u16 req | u32 keyId | u32 piece | u32 offset | payload
//     WANT   (1)  receiver -> holder: please send piece (whole). `req` identifies the request.
//     DATA   (2)  holder -> receiver: bytes [offset, offset + payload.length) of the piece, in order.
//                 payload is 1..MAX_PAYLOAD bytes, so a whole message is at most 64 KiB.
//     DENY   (3)  holder -> receiver: cannot send it (flags: 1 busy, 2 unavailable). Receiver moves on.
//     CANCEL (4)  receiver -> holder: stop, I don't need it any more (or gave up).
//     keyId is a 32-bit FNV-1a hash of the key; frames for another film are dropped or denied.
//
// WHO FETCHES WHAT (per piece p, for the receiver):
//   (b) some connected peer advertises `local` for this film: ask one of them, `locals[p mod count]`
//       (sorted by id); on failure the next one (Drive film: at most two, then the server).
//   (c) Drive film, nobody local: if a peer that streams the same film already has p cached
//       (advertised ranges), ask it. Otherwise the "fetcher" of p is `streamers[p mod N]`, where streamers
//       are this viewer plus the connected peers streaming the same key, sorted by id. If that is me, I
//       fetch p from our server; if not I ask the fetcher, which answers from its cache or fetches p from
//       the server first. Everyone sorts the same list, so a region that everybody jumps to at the same
//       time is fetched from the server about once.
//   (d) a peer that doesn't start answering in `firstByteMs`, stalls, is too slow, denies us or leaves is
//       skipped for a while (`badMs`). A Drive film then plans again without it (the next fetcher in the
//       assignment, which is the one the other viewers pick too, so a lost fetcher still costs the server
//       about one fetch of the piece) and after two failed friends falls back to our server for that piece.
//       A film that only exists on friends' devices tries the next local holder and otherwise fails (and
//       RemoteFile retries). Reads of a few blocks (embedded subtitles) go straight to the server.

import { RemoteFile, RemoteError } from './remotefile.js';

const MiB = 1024 * 1024;
export const PIECE = MiB;
export const HEADER = 16;
export const MAX_FRAME = 64 * 1024;
export const MAX_PAYLOAD = MAX_FRAME - HEADER;
export const T = { WANT: 1, DATA: 2, DENY: 3, CANCEL: 4 };
export const DENIED = { BUSY: 1, UNAVAILABLE: 2 };
const MAX_PIECES = 1 << 22; // 4 TiB of film
const PIECE_LIMIT = 64 * MiB; // no sane piece size is larger: offsets beyond it are garbage
const KEY_RE = /^(d:[A-Za-z0-9_-]{10,200}|s:[0-9]{1,15})$/;
const noop = () => {};

// ---- pure helpers --------------------------------------------------------------------------------------

/** The film's identity: `d:<driveId>` for a Drive film, otherwise `s:<size>`. */
export function filmKey({ drive, size }) {
  return drive?.id ? `d:${drive.id}` : `s:${size}`;
}

/** Keys that name the same film as this movie ({size, drive?}): its Drive key and its size key. */
export function movieKeys(movie) {
  const keys = [];
  if (movie?.drive?.id) keys.push(`d:${movie.drive.id}`);
  if (movie?.size > 0) keys.push(`s:${movie.size}`);
  return keys;
}

/** 32-bit FNV-1a of a (ASCII) key. */
export function keyId(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The viewer that fetches piece `piece` from the server: streamers sorted by id, `piece mod N`. */
export function assignFetcher(piece, streamers) {
  if (!streamers.length) return null;
  const sorted = [...streamers].sort();
  return sorted[piece % sorted.length];
}

export function encodeFrame({ type, req = 0, key = 0, piece = 0, offset = 0, flags = 0, payload = null }) {
  const n = payload ? payload.length : 0;
  const buf = new Uint8Array(HEADER + n);
  const v = new DataView(buf.buffer);
  v.setUint8(0, type);
  v.setUint8(1, flags);
  v.setUint16(2, req, true);
  v.setUint32(4, key, true);
  v.setUint32(8, piece, true);
  v.setUint32(12, offset, true);
  if (n) buf.set(payload, HEADER);
  return buf;
}

/** Parse a frame; null if it is malformed in any way (wrong size, unknown type, payload where there is none, ...). */
export function decodeFrame(data) {
  let u8;
  if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else return null;
  if (u8.length < HEADER || u8.length > MAX_FRAME) return null;
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const f = { type: v.getUint8(0), flags: v.getUint8(1), req: v.getUint16(2, true), key: v.getUint32(4, true), piece: v.getUint32(8, true), offset: v.getUint32(12, true), payload: u8.subarray(HEADER) };
  if (f.piece >= MAX_PIECES) return null;
  switch (f.type) {
    case T.DATA:
      if (f.flags !== 0 || f.payload.length < 1 || f.payload.length > MAX_PAYLOAD || f.offset + f.payload.length > PIECE_LIMIT) return null;
      return f;
    case T.WANT:
    case T.CANCEL:
      if (f.flags !== 0 || f.payload.length !== 0 || f.offset !== 0) return null;
      return f;
    case T.DENY:
      if (f.payload.length !== 0 || (f.flags !== DENIED.BUSY && f.flags !== DENIED.UNAVAILABLE)) return null;
      return f;
    default:
      return null;
  }
}

/** Sorted, disjoint [first, last] ranges, merged down to at most `max` by closing the smallest gaps (this may over-claim). */
export function mergeRanges(ranges, max = 32) {
  const out = ranges.map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < out.length; ) {
    if (out[i][0] <= out[i - 1][1] + 1) {
      out[i - 1][1] = Math.max(out[i - 1][1], out[i][1]);
      out.splice(i, 1);
    } else i++;
  }
  while (out.length > Math.max(1, max)) {
    let best = 1;
    for (let i = 2; i < out.length; i++) if (out[i][0] - out[i - 1][1] < out[best][0] - out[best - 1][1]) best = i;
    out[best - 1][1] = out[best][1];
    out.splice(best, 1);
  }
  return out;
}

export const inRanges = (ranges, p) => ranges.some((r) => p >= r[0] && p <= r[1]);

/** A peer's `film-have` message, validated; null if it is not well-formed. */
export function parseHave(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.key === null) return { key: '', local: false, ranges: [], via: '' };
  if (typeof msg.key !== 'string' || !KEY_RE.test(msg.key) || typeof msg.local !== 'boolean') return null;
  if (!Array.isArray(msg.ranges) || msg.ranges.length > 64) return null;
  const ranges = [];
  for (const r of msg.ranges) {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1]) || r[0] < 0 || r[1] < r[0] || r[1] >= MAX_PIECES) return null;
    ranges.push([r[0], r[1]]);
  }
  const via = msg.via === 'file' || msg.via === 'drive' || msg.via === 'peers' ? msg.via : '';
  return { key: msg.key, local: msg.local, ranges: mergeRanges(ranges, 64), via };
}

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

/** The server's answer to a piece request when it is not the piece (quota, token, ...): handed back so RemoteFile can explain it. */
class ServerReply extends Error {
  constructor(res, body) {
    super(`The server answered with an error (${res.status}).`);
    this.status = res.status;
    this.body = body;
    this.contentType = res.headers?.get?.('content-type') || '';
  }

  toResponse() {
    return new Response(this.body, { status: this.status, headers: this.contentType ? { 'Content-Type': this.contentType } : {} });
  }
}

/** Run `fn(signal)` once per key, shared by all callers; it is aborted when every caller has aborted. */
function shared(map, key, signal, fn) {
  let e = map.get(key);
  if (e && e.ctrl.signal.aborted) e = null;
  if (!e) {
    const ctrl = new AbortController();
    e = { refs: 0, ctrl, promise: null };
    const entry = e;
    e.promise = fn(ctrl.signal).finally(() => {
      if (map.get(key) === entry) map.delete(key);
    });
    e.promise.catch(noop);
    map.set(key, e);
  }
  const entry = e;
  entry.refs++;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (--entry.refs <= 0) entry.ctrl.abort();
      reject(abortError());
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
      (err) => { signal?.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

// ---- a film that this viewer has open ------------------------------------------------------------------------

class Film {
  /**
   * @param {Swarm} swarm
   * @param {object} o
   * @param {string} o.key  `d:<id>` or `s:<size>`
   * @param {number} o.size
   * @param {Blob} [o.local]  the film as a file on this device (served to friends when sharing is on)
   * @param {(start, endInclusive, signal) => Promise<Response>} [o.server]  Range request to our server (Drive films)
   * @param {RemoteFile} [o.store]  the block cache that holds pieces (set with bind() when it needs `request` first)
   */
  constructor(swarm, o) {
    this.swarm = swarm;
    this.key = o.key;
    this.size = o.size;
    this.local = o.local || null;
    this.server = o.server || null;
    this.store = o.store || null;
    this.nPieces = Math.ceil(o.size / swarm.pieceSize);
    // A Drive film is also named by its size, which is how a local copy of it advertises itself.
    this.keys = new Set([o.key]);
    if (this.server && !this.key.startsWith('s:')) this.keys.add(`s:${o.size}`);
    this.keyIds = new Set([...this.keys].map(keyId));
    this.inflight = new Map(); // piece -> shared acquisition (peers, then the server)
    this.serverInflight = new Map(); // piece -> shared server fetch
    this.acqs = new Map(); // req -> my outstanding want
    this.jobs = new Map(); // `${peerId}:${req}` -> piece I am sending to a friend
    this.wants = new Map(); // peerId -> number of my outstanding wants
    this.slotWaiters = [];
    this.closed = false;
    this.active = false;
    this.request = (start, end, signal, opts) => swarm._request(this, start, end, signal, opts);
  }

  bind(store) {
    this.store = store;
    store.abort?.signal.addEventListener('abort', () => this.swarm.closeFilm(this), { once: true });
  }

  /** Make this the film the swarm advertises and serves (replacing the previous one). */
  activate() {
    this.swarm._activate(this);
  }

  get peerOnly() {
    return !this.server && !this.local;
  }

  dispose() {
    this.swarm.closeFilm(this);
  }
}

// ---- the swarm ----------------------------------------------------------------------------------------------------

export class Swarm extends EventTarget {
  /**
   * @param {object} mesh  mesh.js Mesh: peers (id -> Peer with filmOpen), send(id, msg), broadcast(msg),
   *   sendFilm(id, bytes, tag), dropFilm(id, tag), and the events 'message', 'film', 'channel-open', 'film-open',
   *   'film-close', 'peer-removed'
   * @param {object} [o]  tunables (the tests make the times small)
   */
  constructor(mesh, o = {}) {
    super();
    this.mesh = mesh;
    this.selfId = o.selfId ?? mesh.selfId;
    this.pieceSize = o.pieceSize || PIECE;
    this.firstByteMs = o.firstByteMs ?? 4000; // no first byte by then: the peer is skipped
    this.minRate = o.minRate ?? 256 * 1024; // bytes/s: a piece must arrive within firstByteMs + size / minRate
    this.badMs = o.badMs ?? 30000; // how long a peer that failed us is left alone
    this.maxServing = o.maxServing ?? 8; // pieces sent to friends at once (memory: about 2 MiB each)
    this.maxPerPeer = o.maxPerPeer ?? 3; // ... and for one friend
    this.maxWantsPerPeer = o.maxWantsPerPeer ?? 2; // pieces I ask one friend for at once
    this.advertiseMs = o.advertiseMs ?? 1000;
    this.maxRanges = o.maxRanges ?? 32;
    this.share = o.share !== false; // send pieces of a file on this device
    this.have = new Map(); // peerId -> parsed film-have
    this.bad = new Map(); // peerId -> time until which we don't ask it
    this.film = null;
    this.reqSeq = 0;
    this.stats = { server: 0, peers: 0, served: 0, dropped: 0, fallbacks: 0 }; // bytes (dropped, fallbacks: counts)
    this._lastSent = '';
    this._lastAt = 0;
    this._timer = 0;

    this._on = (target, type, fn) => {
      target.addEventListener(type, fn);
      return () => target.removeEventListener(type, fn);
    };
    this._off = [
      this._on(mesh, 'message', (e) => {
        if (e.detail.msg?.type === 'film-have') this._onHave(e.detail.peer, e.detail.msg);
      }),
      this._on(mesh, 'film', (e) => this._onFilm(e.detail.peer, e.detail.data)),
      this._on(mesh, 'channel-open', (e) => this._sendHave(e.detail.peer.id)),
      this._on(mesh, 'film-open', () => this._changed()),
      this._on(mesh, 'film-close', (e) => this._peerGone(e.detail.peer.id)),
      this._on(mesh, 'peer-removed', (e) => {
        this.have.delete(e.detail.peer.id);
        this.bad.delete(e.detail.peer.id);
        this._peerGone(e.detail.peer.id);
        this._emit('change');
      }),
    ];
  }

  destroy() {
    this.closeFilm();
    clearTimeout(this._timer);
    for (const off of this._off) off();
  }

  _emit(type) {
    this.dispatchEvent(new Event(type));
  }

  now() {
    return Date.now();
  }

  setShare(on) {
    this.share = !!on;
    this._changed();
    this._emit('change');
  }

  // ---- opening films ------------------------------------------------------------------------------------------
  /**
   * A film that is a file on this device: advertised as `local` (when sharing is on) and served from the file.
   * Reading it for playback does not involve the swarm.
   */
  openLocal(file) {
    const film = new Film(this, { key: `s:${file.size}`, size: file.size, local: file });
    film.activate();
    return film;
  }

  /**
   * A RemoteFile that reads through the swarm. `server` (Drive films) is a Range request to our server,
   * used for the pieces that nobody else provides; without it the film can only come from friends' copies.
   * The film becomes the active one at film.activate() (or its first read).
   */
  openRemote({ name, size, drive = null, server = null, nativeUrl = null, ...rest }) {
    const film = new Film(this, { key: filmKey({ drive: server ? drive : null, size }), size, server });
    const rf = new RemoteFile({ maxParallel: 4, ...rest, name, size, nativeUrl, request: film.request });
    film.bind(rf);
    rf.swarm = film;
    rf.peerOnly = film.peerOnly;
    if (drive) rf.drive = drive;
    return rf;
  }

  _activate(film) {
    if (film.closed || this.film === film) return;
    const prev = this.film;
    this.film = film;
    film.active = true;
    if (prev) this._teardown(prev);
    this._changed();
    this._emit('change');
  }

  closeFilm(film = this.film) {
    if (!film || film.closed) return;
    this._teardown(film);
    if (this.film === film) {
      this.film = null;
      this._changed();
    }
    this._emit('change');
  }

  _teardown(film) {
    film.closed = true;
    film.active = false;
    for (const e of film.inflight.values()) e.ctrl.abort();
    for (const e of film.serverInflight.values()) e.ctrl.abort();
    for (const acq of [...film.acqs.values()]) acq.finish(null, true);
    for (const job of [...film.jobs.values()]) this._cancelJob(film, job);
    for (const w of film.slotWaiters.splice(0)) w();
  }

  // ---- what peers can serve (for the UI) -------------------------------------------------------------------------
  _usable(id) {
    return !!this.mesh.peers.get(id)?.filmOpen;
  }

  /** Ids of connected peers that have a whole copy of this movie ({size, drive?}) on their device and share it. */
  holders(movie) {
    const keys = new Set(movieKeys(movie));
    return [...this.have].filter(([id, h]) => h.local && keys.has(h.key) && this._usable(id)).map(([id]) => id).sort();
  }

  /** How a peer gets the film: 'file' | 'drive' | 'peers' | '' (nothing advertised). */
  viaOf(id) {
    return this.have.get(id)?.via || '';
  }

  // ---- advertising ---------------------------------------------------------------------------------------------------
  _haveMessage() {
    const f = this.film;
    const none = { type: 'film-have', key: null, local: false, ranges: [], via: '' };
    if (!f || f.closed) return none;
    if (f.local) {
      if (!this.share) return none;
      return { type: 'film-have', key: f.key, local: true, ranges: [[0, f.nPieces - 1]], via: 'file' };
    }
    const ranges = f.store?.cachedPieces ? mergeRanges(f.store.cachedPieces(this.pieceSize), this.maxRanges) : [];
    return { type: 'film-have', key: f.key, local: false, ranges, via: f.server ? 'drive' : 'peers' };
  }

  _sendHave(id) {
    const msg = this._haveMessage();
    if (msg.key !== null) this.mesh.send(id, msg); // a newcomer needs no news of "nothing"; it starts with none
  }

  /** Something changed: advertise, at most once per advertiseMs. */
  _changed() {
    if (this._timer) return;
    const wait = Math.max(0, this._lastAt + this.advertiseMs - this.now());
    this._timer = setTimeout(() => {
      this._timer = 0;
      const msg = this._haveMessage();
      const s = JSON.stringify(msg);
      if (s === this._lastSent) return;
      this._lastSent = s;
      this._lastAt = this.now();
      this.mesh.broadcast(msg);
    }, wait);
    this._timer.unref?.();
  }

  _onHave(peer, msg) {
    const h = parseHave(msg);
    if (!h) return;
    if (!h.key) this.have.delete(peer.id);
    else this.have.set(peer.id, h);
    this._emit('change');
  }

  // ---- bad peers -------------------------------------------------------------------------------------------------------
  _markBad(id) {
    this.bad.set(id, this.now() + this.badMs);
  }

  _peerGone(id) {
    const f = this.film;
    if (!f) return;
    for (const acq of [...f.acqs.values()]) if (acq.peerId === id) acq.finish(null);
    for (const job of [...f.jobs.values()]) if (job.peerId === id) this._cancelJob(f, job);
  }

  // ---- choosing where to get a piece ---------------------------------------------------------------------------------
  /** { peers: ids to try in order, server: whether the server is the last resort } for piece p. */
  _plan(film, p) {
    const now = this.now();
    const ok = (id) => this._usable(id) && !(this.bad.get(id) > now);
    const entries = [...this.have].filter(([id, h]) => ok(id) && film.keys.has(h.key));
    const locals = entries.filter(([, h]) => h.local).map(([id]) => id).sort();
    if (locals.length) {
      const n = locals.length;
      const order = locals.map((_, i) => locals[(p + i) % n]);
      return { peers: film.server ? order.slice(0, 2) : order, server: !!film.server };
    }
    if (!film.server) return { peers: [], server: false };
    const streamers = entries.filter(([, h]) => h.key === film.key).map(([id]) => id);
    const cached = entries.filter(([, h]) => h.key === film.key && inRanges(h.ranges, p)).map(([id]) => id).sort();
    if (cached.length) return { peers: [cached[p % cached.length]], server: true };
    const fetcher = assignFetcher(p, [this.selfId, ...streamers]);
    return { peers: fetcher === this.selfId ? [] : [fetcher], server: true };
  }

  _bounds(film, p) {
    const start = p * this.pieceSize;
    return [start, Math.min(film.size, start + this.pieceSize)];
  }

  // ---- reading (the `request` of a RemoteFile) -------------------------------------------------------------------
  async _request(film, start, end, signal, opts = {}) {
    if (film.closed) {
      // The film stopped being shared (another film became active, or we switched to native playback):
      // a Drive film can still be read from the server directly.
      if (film.server && !film.store?.closed) return film.server(start, end, signal);
      throw new RemoteError('The movie was closed.', { permanent: true });
    }
    if (!film.active && !this.film) film.activate();
    // A few blocks for an embedded subtitle: don't pull whole pieces for that.
    if (opts.small && film.server) return film.server(start, end, signal);
    const P = this.pieceSize;
    const first = Math.floor(start / P);
    const last = Math.floor(end / P);
    try {
      const pieces = [];
      for (let p = first; p <= last; p++) pieces.push(this._piece(film, p, signal));
      const got = await Promise.all(pieces);
      const out = new Uint8Array(end - start + 1);
      for (let i = 0; i < got.length; i++) {
        const pStart = (first + i) * P;
        const from = Math.max(start, pStart);
        const to = Math.min(end + 1, pStart + got[i].length);
        out.set(got[i].subarray(from - pStart, to - pStart), from - start);
      }
      return new Response(out, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${film.size}` } });
    } catch (err) {
      if (err instanceof ServerReply) return err.toResponse();
      throw err;
    }
  }

  _piece(film, p, signal) {
    return shared(film.inflight, p, signal, (sig) => this._acquire(film, p, sig));
  }

  async _acquire(film, p, sig) {
    const [a, b] = this._bounds(film, p);
    const cached = film.store?.peek?.(a, b);
    if (cached) return cached;
    // Ask a friend; when it fails it is marked bad, so planning again (without it) picks the next one: for a Drive
    // film the next fetcher in the assignment, which is the same one the other viewers pick, so a lost fetcher still
    // costs the server about one fetch of the piece. Drive: at most two friends, then the server.
    const tried = new Set();
    let plan = this._plan(film, p);
    for (;;) {
      const id = plan.peers.find((x) => !tried.has(x));
      if (!id || (film.server && tried.size >= 2)) break;
      tried.add(id);
      const data = await this._fromPeer(film, id, p, sig);
      if (sig.aborted || film.closed) throw abortError();
      if (data) {
        this._stored(film, p, data);
        this.stats.peers += data.length;
        return data;
      }
      plan = this._plan(film, p);
    }
    if (!film.server) throw new RemoteError(this.have.size ? 'Could not get this part of the movie from your friends.' : 'Nobody is sharing this movie right now.');
    if (tried.size) this.stats.fallbacks++;
    return this._fromServer(film, p, sig);
  }

  _stored(film, p, data) {
    film.store?.inject?.(p * this.pieceSize, data);
    this._changed();
  }

  /** Piece p from our server (shared between my own reads and friends' requests). */
  _fromServer(film, p, signal) {
    return shared(film.serverInflight, p, signal, async (sig) => {
      const [a, b] = this._bounds(film, p);
      const res = await film.server(a, b - 1, sig);
      if (res.status !== 206 && !(res.status === 200 && a === 0 && b === film.size)) {
        if (res.status === 200) throw new RemoteError('The server ignored the byte range request, so this file cannot be streamed.', { status: 200, permanent: true });
        let body = null;
        try {
          if (Number(res.headers.get('content-length') || 0) < 65536) body = await res.arrayBuffer();
        } catch {
          /* the status alone says enough */
        }
        throw new ServerReply(res, body);
      }
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.length !== b - a) throw new RemoteError('The download was cut short.', { status: res.status });
      this.stats.server += data.length;
      this._stored(film, p, data);
      return data;
    });
  }

  async _slot(film, id, sig) {
    while ((film.wants.get(id) || 0) >= this.maxWantsPerPeer) {
      await new Promise((resolve) => {
        const wake = () => { sig.removeEventListener('abort', wake); resolve(); };
        film.slotWaiters.push(wake);
        sig.addEventListener('abort', wake, { once: true });
      });
      if (sig.aborted || film.closed) return false;
    }
    film.wants.set(id, (film.wants.get(id) || 0) + 1);
    return true;
  }

  _unslot(film, id) {
    film.wants.set(id, Math.max(0, (film.wants.get(id) || 1) - 1));
    for (const w of film.slotWaiters.splice(0)) w();
  }

  /** Ask a friend for piece p; the piece, or null if it failed (it is then skipped for a while). */
  async _fromPeer(film, id, p, sig) {
    if (!(await this._slot(film, id, sig))) return null;
    const [a, b] = this._bounds(film, p);
    const len = b - a;
    const h = this.have.get(id);
    if (!h || !this._usable(id)) {
      this._unslot(film, id);
      return null;
    }
    let req;
    do req = ((this.reqSeq = (this.reqSeq + 1) & 0xffff) || 1); while (film.acqs.has(req));
    const kid = keyId(h.key);
    return new Promise((resolve) => {
      const acq = { req, peerId: id, p, keyId: kid, buf: new Uint8Array(len), got: 0, first: 0, stall: 0, total: 0, finish: null };
      acq.finish = (data, silent) => {
        if (film.acqs.get(req) !== acq) return;
        film.acqs.delete(req);
        clearTimeout(acq.first);
        clearTimeout(acq.stall);
        clearTimeout(acq.total);
        sig.removeEventListener('abort', onAbort);
        this._unslot(film, id);
        if (!data) {
          if (!silent && !sig.aborted) this._markBad(id);
          if (this._usable(id)) this.mesh.sendFilm(id, encodeFrame({ type: T.CANCEL, req, key: kid, piece: p }), `c${req}`);
        }
        resolve(data);
      };
      const onAbort = () => acq.finish(null, true);
      sig.addEventListener('abort', onAbort, { once: true });
      film.acqs.set(req, acq);
      acq.first = setTimeout(() => acq.finish(null), this.firstByteMs);
      acq.total = setTimeout(() => acq.finish(null), this.firstByteMs + (len / this.minRate) * 1000);
      if (!this.mesh.sendFilm(id, encodeFrame({ type: T.WANT, req, key: kid, piece: p }), `w${req}`)) acq.finish(null);
    });
  }

  // ---- incoming film frames -------------------------------------------------------------------------------------------
  _onFilm(peer, data) {
    const f = decodeFrame(data);
    const film = this.film;
    if (!f || !film || film.closed) {
      if (!f) this.stats.dropped++;
      else if (f.type === T.WANT) this._deny(peer.id, f, DENIED.UNAVAILABLE);
      return;
    }
    switch (f.type) {
      case T.WANT:
        return this._onWant(film, peer, f);
      case T.CANCEL: {
        const job = film.jobs.get(`${peer.id}:${f.req}`);
        if (job) this._cancelJob(film, job);
        return;
      }
      case T.DATA:
        return this._onData(film, peer, f);
      case T.DENY: {
        const acq = film.acqs.get(f.req);
        if (!acq || acq.peerId !== peer.id || acq.p !== f.piece) return;
        if (f.flags === DENIED.BUSY) acq.finish(null, true);
        else acq.finish(null);
        return;
      }
      default:
    }
  }

  _onData(film, peer, f) {
    const acq = film.acqs.get(f.req);
    // Only the frames we asked for, from whom we asked, in order, inside the piece: anything else is dropped.
    if (!acq || acq.peerId !== peer.id || acq.keyId !== f.key || acq.p !== f.piece || f.offset !== acq.got || f.offset + f.payload.length > acq.buf.length) {
      this.stats.dropped++;
      return;
    }
    acq.buf.set(f.payload, f.offset);
    acq.got += f.payload.length;
    clearTimeout(acq.first);
    clearTimeout(acq.stall);
    if (acq.got === acq.buf.length) {
      acq.finish(acq.buf);
      return;
    }
    acq.stall = setTimeout(() => acq.finish(null), this.firstByteMs);
  }

  // ---- serving ------------------------------------------------------------------------------------------------------------
  _deny(peerId, f, code) {
    this.mesh.sendFilm(peerId, encodeFrame({ type: T.DENY, req: f.req, key: f.key, piece: f.piece, flags: code }), `d${f.req}`);
  }

  _onWant(film, peer, f) {
    if (!film.keyIds.has(f.key)) return this._deny(peer.id, f, DENIED.UNAVAILABLE);
    if (f.piece >= film.nPieces) return; // not a piece of this film: garbage
    const id = `${peer.id}:${f.req}`;
    if (film.jobs.has(id)) return;
    let mine = 0;
    for (const j of film.jobs.values()) if (j.peerId === peer.id) mine++;
    if (mine >= this.maxPerPeer || film.jobs.size >= this.maxServing) return this._deny(peer.id, f, DENIED.BUSY);
    const job = { id, peerId: peer.id, req: f.req, key: f.key, p: f.piece, cancelled: false, ctrl: new AbortController() };
    film.jobs.set(id, job);
    this._serve(film, job).finally(() => {
      if (film.jobs.get(id) === job) film.jobs.delete(id);
    });
  }

  _cancelJob(film, job) {
    job.cancelled = true;
    job.ctrl.abort();
    this.mesh.dropFilm(job.peerId, `j${job.req}`);
    film.jobs.delete(job.id);
  }

  /** The bytes of piece p that I can give a friend right now, from my file, my cache, or (Drive film) the server. */
  async _servable(film, p, sig) {
    const [a, b] = this._bounds(film, p);
    if (film.local) {
      if (!this.share) return null;
      const buf = new Uint8Array(await film.local.slice(a, b).arrayBuffer());
      return buf.length === b - a ? buf : null;
    }
    const cached = film.store?.peek?.(a, b);
    if (cached) return cached;
    if (film.server) return this._fromServer(film, p, sig);
    return null;
  }

  async _serve(film, job) {
    let data = null;
    try {
      data = await this._servable(film, job.p, job.ctrl.signal);
    } catch {
      data = null;
    }
    if (job.cancelled || film.closed) return;
    const reply = { req: job.req, key: job.key, piece: job.p };
    if (!data) return this._deny(job.peerId, reply, DENIED.UNAVAILABLE);
    const tag = `j${job.req}`;
    for (let off = 0; off < data.length; off += MAX_PAYLOAD) {
      const payload = data.subarray(off, Math.min(data.length, off + MAX_PAYLOAD));
      if (!this.mesh.sendFilm(job.peerId, encodeFrame({ type: T.DATA, req: job.req, key: job.key, piece: job.p, offset: off, payload }), tag)) {
        job.cancelled = true;
        return;
      }
    }
    this.stats.served += data.length;
  }
}
