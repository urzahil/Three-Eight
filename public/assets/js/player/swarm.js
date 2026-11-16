// Sharing a film between the viewers of a room, over the WebRTC film channel (mesh.js, channel id 1).
//
// The film is split into 1 MiB pieces (aligned: piece = floor(byte / 1 MiB); the last one is shorter).
// A viewer that streams the film reads it through a RemoteFile whose `request` is `film.request` (below):
// for every missing byte range, whole pieces are fetched from friends or, for a Google Drive film, from
// our server. The RemoteFile block cache is the piece store; pieces that arrive are injected into it, so
// they can be served to other viewers too.
//
// Film identity ("key"): `d:<driveId>` for a film from the room's Drive folder, `s:<size>:<fingerprint>` for
// a film that is a file on someone's device. The fingerprint is a SHA-256 over the size and three 64 KiB samples
// (start, middle, end) of the file, so two different files of the same size do not pass for one film. A Drive
// film computes the same fingerprint from the same byte ranges, fetched from our server once, lazily (when the
// film is first read); from then on its keys are `d:<driveId>` and `s:<size>:<fingerprint>`, so local copies
// can serve a Drive film, but only when the fingerprints are equal. Until the fingerprint is known a Drive film
// has no local holders and reads from our server. A local file is advertised only once its fingerprint is
// computed (a few small reads). A film that is only streamed from friends gets the fingerprint from the room's
// movie state (sync.js `movie.fp`, set by whoever picked the file). Without crypto.subtle (a page that is not a
// secure context) there is no fingerprint and the key is the old `s:<size>`, which matches only other viewers
// in the same situation.
//
// INTEGRITY: there are no per-piece hashes. The sampled fingerprint catches a different file, not a file
// that differs only between the samples (a re-encode of the same size is implausible, a deliberate attacker
// is possible). A friend who deliberately sends wrong bytes can make your player show garbage; it can't do
// more than that, because every message is validated (see decodeFrame and the checks in Swarm) and bytes only
// ever go to the demuxer, like any file.
//
// PROTOCOL
//   Channel 0 (JSON, mesh.js `send`):
//     { type: 'film-have', key: string|null, local: bool, ranges: [[firstPiece, lastPiece], ...], via: 'file'|'drive'|'peers' }
//       what this viewer can serve for the film it has open (key null: nothing). `local` = the whole file
//       is on this device. `ranges` = pieces completely in its cache (merged, at most 32 ranges).
//       Sent on change, at most once a second, and to every new peer.
//     Embedded subtitles: `film-have` also carries `subs: ['e3', ...]`, the embedded subtitle tracks this viewer
//     has completely extracted. A viewer whose selected embedded track is incomplete asks one holder at a time
//     (local holders first, 5 s each): { type: 'sub-cues-req', key, track } -> { type: 'sub-cues', key, track,
//     cues: [{ start, end, text, top? }] } (seconds; the player's own cue format). Answers are only accepted from
//     the peer asked, for a track we asked for, at most MAX_CUES cues and MAX_CUE_TEXT characters in all.
//   Channel 1 (binary frames, little endian), header of 16 bytes + payload:
//       u8 type | u8 flags | u16 req | u32 keyId | u32 piece | u32 offset | payload
//     WANT   (1)  receiver -> holder: please send piece (whole). `req` identifies the request.
//     DATA   (2)  holder -> receiver: bytes [offset, offset + payload.length) of the piece, in order.
//                 payload is 1..MAX_PAYLOAD bytes, so a whole message is at most 64 KiB.
//     DENY   (3)  holder -> receiver: cannot send it (flags: 1 busy, 2 unavailable). Receiver moves on.
//     CANCEL (4)  receiver -> holder: stop, I don't need it any more (or gave up).
//     keyId is a 32-bit FNV-1a hash of the key; frames for another film are dropped or denied.
//
// WHO FETCHES WHAT (per piece p, for a viewer that does not have the film as a file)
//   The film's ORIGIN is the set of peers that advertise `local` for it (their copy of the file), or, for a
//   Drive film with none, our server. A Drive film with local holders uses the server only as the last fallback.
//   Viewers that merely stream RELAY pieces to each other, so the origin sends about one copy in total:
//   1. a streamer (non-local peer of this film) that advertises p as cached: ask `cached[p mod count]`.
//   2. otherwise the "fetcher" of p is `streamers[p mod N]`: me plus the connected streamers of this film,
//      sorted by id. If that is me, I fetch p from the origin: `locals[p mod count]` (spread over the holders),
//      or the server. If not, I send `want` to the fetcher, which answers from its cache or fetches p from
//      the origin first (sharing the fetch with its own reads). A fetcher never asks another streamer, only
//      the origin, so chains are one hop and cannot loop. Everyone sorts the same list, so a region that
//      everybody jumps to at the same time is fetched from the origin about once.
//   3. a peer that doesn't start answering in `firstByteMs` (twice that for a relay, which fetches first),
//      stalls, is too slow, denies us or leaves is skipped for a while (`badMs`) and the plan is made again
//      without it (the next fetcher, the same one the other viewers pick). After two failed friends we go to
//      the origin directly: the next local holder, or the server for a Drive film. A film that only exists
//      on friends' devices fails with a message when no holder answers (RemoteFile retries). Streamers keep
//      relaying what they have cached when the holders are gone.
//   4. reads of a few blocks (embedded subtitles) go straight to the server (Drive films).

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
const KEY_RE = /^(d:[A-Za-z0-9_-]{10,200}|s:[0-9]{1,15}(:[0-9a-f]{32})?)$/;
export const FP_RE = /^[0-9a-f]{32}$/;
const FP_SAMPLE = 64 * 1024; // bytes read at the start, the middle and the end of a file for its fingerprint
const noop = () => {};
export const MAX_CUES = 20000;
export const MAX_CUE_TEXT = 8 * MiB;
const TRACK_RE = /^e[0-9]{1,6}$/;

// ---- pure helpers --------------------------------------------------------------------------------------

/** The key of a film that is a file: `s:<size>:<fingerprint>`, or `s:<size>` when there is no fingerprint. */
export function sizeKey(size, fp) {
  return fp ? `s:${size}:${fp}` : `s:${size}`;
}

/** The film's identity: `d:<driveId>` for a Drive film, otherwise its size key. */
export function filmKey({ drive, size, fp }) {
  return drive?.id ? `d:${drive.id}` : sizeKey(size, fp);
}

/** Keys that name the same film as this movie ({size, fp?, drive?}): its Drive key and its size key. */
export function movieKeys(movie) {
  const keys = [];
  if (movie?.drive?.id) keys.push(`d:${movie.drive.id}`);
  if (movie?.size > 0) keys.push(sizeKey(movie.size, FP_RE.test(movie.fp || '') ? movie.fp : ''));
  return keys;
}

/** The byte ranges [start, end) a fingerprint samples: the first, middle and last FP_SAMPLE bytes (merged for small files). */
export function fingerprintRanges(size) {
  if (!(size > 0)) return [];
  const mid = Math.max(0, Math.floor(size / 2) - FP_SAMPLE / 2);
  const ranges = [[0, Math.min(size, FP_SAMPLE)], [mid, Math.min(size, mid + FP_SAMPLE)], [Math.max(0, size - FP_SAMPLE), size]].sort((a, b) => a[0] - b[0]);
  const out = [ranges[0]];
  for (const r of ranges.slice(1)) {
    const last = out[out.length - 1];
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/**
 * The fingerprint of a file of `size` bytes: 32 hex characters of SHA-256 over the size and the sampled
 * ranges. `read(start, end)` resolves to the bytes [start, end) (a Uint8Array of exactly that length).
 * Resolves to null when this page has no crypto.subtle.
 */
export async function computeFingerprint(size, read) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || !(size > 0)) return null;
  const ranges = fingerprintRanges(size);
  const parts = [new Uint8Array(8)];
  new DataView(parts[0].buffer).setUint32(0, Math.floor(size / 2 ** 32));
  new DataView(parts[0].buffer).setUint32(4, size >>> 0);
  for (const [a, b] of ranges) {
    const bytes = await read(a, b);
    if (!bytes || bytes.length !== b - a) throw new Error('The file could not be read for its fingerprint.');
    parts.push(bytes);
  }
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) {
    all.set(x, at);
    at += x.length;
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', all));
  return Array.from(digest.subarray(0, 16), (x) => x.toString(16).padStart(2, '0')).join('');
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
  if (msg.key === null) return { key: '', local: false, ranges: [], via: '', subs: [] };
  if (typeof msg.key !== 'string' || !KEY_RE.test(msg.key) || typeof msg.local !== 'boolean') return null;
  if (!Array.isArray(msg.ranges) || msg.ranges.length > 64) return null;
  const ranges = [];
  for (const r of msg.ranges) {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1]) || r[0] < 0 || r[1] < r[0] || r[1] >= MAX_PIECES) return null;
    ranges.push([r[0], r[1]]);
  }
  const via = msg.via === 'file' || msg.via === 'drive' || msg.via === 'peers' ? msg.via : '';
  const subs = Array.isArray(msg.subs) ? msg.subs.filter((t) => typeof t === 'string' && TRACK_RE.test(t)).slice(0, 64) : [];
  return { key: msg.key, local: msg.local, ranges: mergeRanges(ranges, 64), via, subs };
}

/** Cues from a friend, checked and cleaned: [{ start, end, text, top? }], or null if anything is out of bounds. */
export function sanitizeCues(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_CUES) return null;
  const out = [];
  let chars = 0;
  for (const c of raw) {
    if (!c || typeof c !== 'object' || typeof c.text !== 'string' || !Number.isFinite(c.start) || !Number.isFinite(c.end)) return null;
    if (c.start < 0 || c.end <= c.start || c.end > 1e7 || c.text.length > 4000) return null;
    chars += c.text.length;
    if (chars > MAX_CUE_TEXT) return null;
    out.push(c.top === true ? { start: c.start, end: c.end, text: c.text, top: true } : { start: c.start, end: c.end, text: c.text });
  }
  return out;
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
   * @param {string} o.key  `d:<id>` or `s:<size>[:<fingerprint>]`
   * @param {number} o.size
   * @param {string} [o.fp]  the content fingerprint, when already known
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
    this.fp = null; // content fingerprint (see computeFingerprint); null while unknown or unavailable
    // A local file is advertised only when its fingerprint is known (setFp); a Drive film learns it lazily (_ensureFp).
    this.fpTask = null;
    this.fpRetryAt = 0;
    this.setFp(o.fp || null);
    this.fpPending = !!o.local; // set again: setFp() clears it
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

  /**
   * Set the fingerprint (null: none, e.g. no crypto.subtle). A Drive film is named by its Drive ID and, once
   * the fingerprint is known, by its size key, which is how a local copy of it advertises itself; a file
   * (or a film streamed from friends) is named by its size key alone.
   */
  setFp(fp) {
    this.fp = fp;
    this.fpPending = false;
    const drive = this.key.startsWith('d:');
    if (!drive) this.key = sizeKey(this.size, fp);
    this.keys = new Set([this.key]);
    if (drive && (fp || this.fpDone)) this.keys.add(sizeKey(this.size, fp));
    this.keyIds = new Set([...this.keys].map(keyId));
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
    this.cueTimeoutMs = o.cueTimeoutMs ?? 5000;
    this.cueReqs = new Map(); // `${peerId}|${track}` -> pending request
    this.cueFetches = new Map(); // track -> shared promise
    this.subSrc = null;
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
        const m = e.detail.msg;
        if (m?.type === 'film-have') this._onHave(e.detail.peer, m);
        else if (m?.type === 'sub-cues-req') this._onCueReq(e.detail.peer, m);
        else if (m?.type === 'sub-cues') this._onCues(e.detail.peer, m);
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
    const film = new Film(this, { key: sizeKey(file.size, ''), size: file.size, local: file });
    film.activate();
    // `film.ready` resolves (never rejects) to the fingerprint, or null if it cannot be computed.
    film.ready = computeFingerprint(file.size, async (a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer()))
      .catch(() => null)
      .then((fp) => {
        if (!film.closed) {
          film.setFp(fp);
          this._changed();
          this._emit('change');
        }
        return fp;
      });
    return film;
  }

  /**
   * A RemoteFile that reads through the swarm. `server` (Drive films) is a Range request to our server,
   * used for the pieces that nobody else provides; without it the film can only come from friends' copies.
   * The film becomes the active one at film.activate() (or its first read).
   */
  openRemote({ name, size, drive = null, server = null, nativeUrl = null, fp = null, ...rest }) {
    // `fp`: the fingerprint of a film that only exists on friends' devices, from the room's movie state.
    const film = new Film(this, { key: filmKey({ drive: server ? drive : null, size, fp: server ? null : FP_RE.test(fp || '') ? fp : null }), size, server, fp: server ? null : FP_RE.test(fp || '') ? fp : null });
    const rf = new RemoteFile({ maxParallel: 4, ...rest, name, size, nativeUrl, request: film.request });
    film.bind(rf);
    rf.swarm = film;
    rf.peerOnly = film.peerOnly;
    if (drive) rf.drive = drive;
    return rf;
  }

  /** Does a friend advertise a whole copy of a file of this film's size (with or without a fingerprint)? */
  _hasSizeCandidate(film) {
    const k = `s:${film.size}`;
    for (const h of this.have.values()) if (h.local && (h.key === k || h.key.startsWith(`${k}:`))) return true;
    return false;
  }

  /**
   * A Drive film learns its fingerprint from our server (three small reads), once and only when it is needed:
   * when a friend has a copy of that size, which would be compared with it. After a failure it tries again
   * at most every 15 s. Local copies match the film only once it is known.
   */
  _ensureFp(film) {
    if (!film.server || !this._hasSizeCandidate(film) || film.fpTask || film.fpDone || film.closed || this.now() < film.fpRetryAt) return;
    const ctrl = new AbortController();
    film.fpCtrl = ctrl;
    film.fpTask = computeFingerprint(film.size, async (a, b) => {
      const res = await film.server(a, b - 1, ctrl.signal);
      if (res.status !== 206 && !(res.status === 200 && a === 0 && b === film.size)) throw new Error('The server did not give the bytes for the fingerprint.');
      return new Uint8Array(await res.arrayBuffer());
    }).then(
      (fp) => {
        film.fpTask = null;
        if (film.closed) return;
        film.fpDone = true;
        film.setFp(fp);
        this._changed();
        this._emit('change');
      },
      () => {
        film.fpTask = null;
        film.fpRetryAt = this.now() + 15000;
      },
    );
  }

  _activate(film) {
    if (film.closed || this.film === film) return;
    const prev = this.film;
    this.film = film;
    film.active = true;
    this._ensureFp(film);
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
    film.fpCtrl?.abort();
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
    // The open film may know more names for this movie (a Drive film that has its fingerprint).
    if (this.film && !this.film.closed && keys.has(this.film.key)) for (const k of this.film.keys) keys.add(k);
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
      if (!this.share || f.fpPending) return none;
      return { type: 'film-have', key: f.key, local: true, ranges: [[0, f.nPieces - 1]], via: 'file', subs: this._subList() };
    }
    const ranges = f.store?.cachedPieces ? mergeRanges(f.store.cachedPieces(this.pieceSize), this.maxRanges) : [];
    return { type: 'film-have', key: f.key, local: false, ranges, via: f.server ? 'drive' : 'peers', subs: this._subList() };
  }

  // ---- embedded subtitle cues ----------------------------------------------------------------------------------------
  /**
   * `src` tells the swarm about the player's embedded subtitle tracks: { list(): ids of tracks fully extracted,
   * get(id): their cues, accepts(id): is this an embedded track of the open film }.
   */
  setSubSource(src) {
    this.subSrc = src;
    this._changed();
  }

  /** The player's set of extracted tracks changed. */
  subsChanged() {
    this._changed();
  }

  _subList() {
    try {
      return (this.subSrc?.list() || []).filter((t) => TRACK_RE.test(t)).slice(0, 64);
    } catch {
      return [];
    }
  }

  /** Peers that advertise this track for the open film: local holders first, then the others, sorted by id. */
  _cueHolders(track) {
    const f = this.film;
    if (!f || f.closed) return [];
    const ids = [...this.have].filter(([id, h]) => h.subs?.includes(track) && f.keys.has(h.key) && this._usable(id));
    const rank = (h) => (h.local ? 0 : 1);
    return ids.sort((x, y) => rank(x[1]) - rank(y[1]) || (x[0] < y[0] ? -1 : 1)).map(([id, h]) => ({ id, key: h.key }));
  }

  /** Is anybody known to have this track? */
  hasCueHolder(track) {
    return this._cueHolders(track).length > 0;
  }

  /**
   * Ask the room for an embedded subtitle track, one peer at a time (5 s each). Resolves to validated cues, or
   * null when nobody has it or nobody answered. Calls for the same track share one request.
   */
  fetchCues(track) {
    if (!TRACK_RE.test(track)) return Promise.resolve(null);
    let p = this.cueFetches.get(track);
    if (p) return p;
    const film = this.film;
    p = (async () => {
      const asked = new Set();
      for (;;) {
        if (this.film !== film || film.closed) return null;
        const h = this._cueHolders(track).find((x) => !asked.has(x.id));
        if (!h) return null;
        asked.add(h.id);
        const cues = await new Promise((resolve) => {
          const k = `${h.id}|${track}`;
          const timer = setTimeout(() => { this.cueReqs.delete(k); resolve(null); }, this.cueTimeoutMs);
          this.cueReqs.set(k, { resolve: (v) => { clearTimeout(timer); this.cueReqs.delete(k); resolve(v); } });
          if (!this.mesh.send(h.id, { type: 'sub-cues-req', key: h.key, track })) this.cueReqs.get(k).resolve(null);
        });
        if (cues) return cues;
      }
    })().finally(() => this.cueFetches.delete(track));
    this.cueFetches.set(track, p);
    return p;
  }

  _onCueReq(peer, msg) {
    const f = this.film;
    if (!f || f.closed || typeof msg.key !== 'string' || !f.keys.has(msg.key) || typeof msg.track !== 'string' || !TRACK_RE.test(msg.track)) return;
    if (f.local && !this.share) return;
    let cues = null;
    try {
      if (this._subList().includes(msg.track)) cues = this.subSrc.get(msg.track);
    } catch {
      cues = null;
    }
    if (!cues) return;
    this.mesh.send(peer.id, { type: 'sub-cues', key: msg.key, track: msg.track, cues });
  }

  _onCues(peer, msg) {
    const f = this.film;
    const pending = this.cueReqs.get(`${peer.id}|${msg.track}`);
    if (!f || f.closed || !pending || typeof msg.key !== 'string' || !f.keys.has(msg.key)) return; // not asked for
    if (this.subSrc?.accepts && !this.subSrc.accepts(msg.track)) return;
    const cues = sanitizeCues(msg.cues);
    if (!cues) {
      this.stats.dropped++;
      return;
    }
    pending.resolve(cues);
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
      if (this.film?.fpPending) return; // not known yet what to advertise: setFp() asks again
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
    else {
      this.have.set(peer.id, h);
      if (h.local && this.film?.server) this._ensureFp(this.film); // a copy to compare with: start early
    }
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
  /** Peers that hold the whole film, usable now, sorted by id and rotated so that locals[0] is `p mod count`. */
  _locals(film, p) {
    const now = this.now();
    const ids = [...this.have]
      .filter(([id, h]) => h.local && film.keys.has(h.key) && this._usable(id) && !(this.bad.get(id) > now))
      .map(([id]) => id)
      .sort();
    return ids.map((_, i) => ids[(p + i) % ids.length]);
  }

  /**
   * { peers: friends to ask first, origin: whether the film's origin is reachable } for piece p.
   * The origin is the local holders (their copy of the file), or our server for a Drive film.
   * Viewers that only stream relay: a streamer that already has p cached is asked first; otherwise the
   * assigned fetcher streamers[p mod N] (me plus the streamers of this film) is, and if that is me,
   * I go to the origin myself (so `peers` is empty).
   */
  _plan(film, p) {
    const now = this.now();
    const streamers = [...this.have]
      .filter(([id, h]) => !h.local && film.keys.has(h.key) && this._usable(id) && !(this.bad.get(id) > now))
      .map(([id]) => id);
    const origin = !!film.server || this._locals(film, p).length > 0;
    const cached = streamers.filter((id) => inRanges(this.have.get(id).ranges, p)).sort();
    if (cached.length) return { peers: [cached[p % cached.length]], origin };
    if (!origin) return { peers: [], origin: false };
    const fetcher = assignFetcher(p, [this.selfId, ...streamers]);
    return { peers: fetcher === this.selfId ? [] : [fetcher], origin };
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
    if (film.server && !film.fpDone) {
      // A friend has a copy of this size: find out first whether it is this film, so its pieces can be used.
      this._ensureFp(film);
      if (film.fpTask) await film.fpTask; // never rejects
      if (signal?.aborted) throw abortError();
    }
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
    // Ask a friend (a streamer that has the piece, or the assigned fetcher); when it fails it is marked bad, so
    // planning again (without it) picks the next one: the same one the other viewers pick, so a lost fetcher
    // still costs the origin about one fetch of the piece. After two failed friends: the origin directly.
    const tried = new Set();
    let plan = this._plan(film, p);
    for (;;) {
      const id = plan.peers.find((x) => !tried.has(x));
      if (!id || tried.size >= 2) break;
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
    if (!plan.origin) throw this._noOrigin();
    if (tried.size) this.stats.fallbacks++;
    return this._fromOrigin(film, p, sig);
  }

  _noOrigin() {
    return new RemoteError(this.have.size ? 'Could not get this part of the movie from your friends.' : 'Nobody is sharing this movie right now.');
  }

  /**
   * Piece p from the origin: a local holder (spread by `p mod count`, the next one when it fails; for a Drive
   * film at most two, then the server), or our server. Shared between my own reads and friends' requests; it
   * never asks a streamer, so a relay chain is one hop deep and cannot loop.
   */
  _fromOrigin(film, p, signal) {
    return shared(film.serverInflight, p, signal, async (sig) => {
      const tried = new Set();
      for (;;) {
        const id = this._locals(film, p).find((x) => !tried.has(x));
        if (!id || (film.server && tried.size >= 2)) break;
        tried.add(id);
        const data = await this._fromPeer(film, id, p, sig);
        if (sig.aborted || film.closed) throw abortError();
        if (data) {
          this._stored(film, p, data);
          this.stats.peers += data.length;
          return data;
        }
      }
      if (!film.server) throw this._noOrigin();
      if (tried.size) this.stats.fallbacks++;
      return this._fetchServer(film, p, sig);
    });
  }

  _stored(film, p, data) {
    film.store?.inject?.(p * this.pieceSize, data);
    this._changed();
  }

  /** Piece p from our server. */
  _fetchServer(film, p, sig) {
    return (async () => {
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
    })();
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
    // Waiting for a slot can take a while: the peer may have failed other pieces (or left) meanwhile, and then
    // every piece queued behind it must not pay the timeout again.
    if (!h || !this._usable(id) || this.bad.get(id) > this.now() || film.closed) {
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
      // A streamer answers after fetching from the origin itself: allow the extra hop.
      const hop = h.local ? 1 : 2;
      acq.first = setTimeout(() => acq.finish(null), this.firstByteMs * hop);
      acq.total = setTimeout(() => acq.finish(null), hop * (this.firstByteMs + (len / this.minRate) * 1000));
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
    if (film.server || this._locals(film, p).length) return this._fromOrigin(film, p, sig); // as the assigned fetcher or not, only ever from the origin
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
