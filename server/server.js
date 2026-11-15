// Three-Eight server.
//
// The server only does a few small things:
//   1. serves the static web app (and the admin page),
//   2. keeps the list of rooms and their (hashed) passwords,
//   3. relays WebRTC signaling messages (SDP offers/answers, ICE candidates)
//      between authenticated participants of the same room,
//   4. answers clock-sync pings so every browser agrees on a common clock,
//   5. optionally reads a Google Drive folder per room as a service account and
//      streams its movies and subtitles to the members of that room.
//
// Audio, video, chat and movie-sync messages flow directly between browsers
// (WebRTC peer connections + data channels). Only Drive movies pass through
// the server (streamed, with a short-lived memory cache; nothing is stored).

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const { RoomStore, RoomError, parseDriveFolder } = require('./store');
const { limiterKey, forwardedAddress } = require('./ip');
const { GoogleDrive, DriveError, ID_RE: DRIVE_ID_RE, FOLDER, kindOf, loadServiceAccount, parseRange, MiB } = require('./drive');

const PORT = parseInt(process.env.PORT || '4567', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const MAX_ROOM_SIZE = parseInt(process.env.MAX_ROOM_SIZE || '12', 10);
// Number of trusted reverse proxies in front of the server (0 = none, use the socket's address).
// TRUST_PROXY=true/1/yes means one hop; a larger number (e.g. 2 for CDN + proxy) means that many.
const TRUSTED_HOPS = (() => {
  const v = (process.env.TRUST_PROXY || '').trim();
  if (/^(true|yes)$/i.test(v)) return 1;
  return /^\d{1,2}$/.test(v) ? parseInt(v, 10) : 0;
})();
// Origins (besides the request's own host) that may open a WebSocket, e.g. "https://calls.example.com".
// Entries are normalised like a browser's Origin (default port and trailing slash dropped); unparseable ones are ignored.
const ALLOWED_ORIGINS = new Set();
for (const entry of (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean)) {
  try {
    const origin = new URL(entry).origin;
    if (origin === 'null') throw new Error('no origin');
    ALLOWED_ORIGINS.add(origin);
  } catch {
    console.warn(`ALLOWED_ORIGINS: ignoring "${entry}" (not a valid origin like https://calls.example.com).`);
  }
}
const DRIVE_DEBUG = process.env.DRIVE_DEBUG === '1';
const MAX_MESSAGE_BYTES = 64 * 1024;
// Per-socket message budget (token bucket): room for ICE candidate bursts and clock-sync pings.
// A newcomer in a full room sends an offer plus a dozen ICE candidates to each peer, so the burst is generous.
const MSG_BURST = 1000;
const MSG_REFILL_PER_SEC = 100;
const ADMIN_SESSION_MS = 12 * 3600 * 1000;

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(12).toString('base64url');
  console.warn(`ADMIN_PASSWORD is not set. Generated a temporary admin password for this run: ${ADMIN_PASSWORD}`);
}

let store;
try {
  store = new RoomStore(DATA_DIR);
} catch (err) {
  // E.g. rooms.json exists but cannot be read: stop rather than risk overwriting it.
  console.error(err.message);
  process.exit(1);
}

// ---- Google Drive (service account) ----------------------------------------
// GOOGLE_SERVICE_ACCOUNT: path to the service account's JSON key. If it is set but unusable,
// the server runs with Drive disabled (and says why, without printing anything secret).
/** @type {GoogleDrive|null} */
let driveApi = null;
const MIN_DRIVE_CACHE_MB = 32;
{
  const keyFile = (process.env.GOOGLE_SERVICE_ACCOUNT || '').trim();
  if (keyFile) {
    try {
      const account = loadServiceAccount(keyFile);
      const mbSetting = (process.env.DRIVE_CACHE_MB || '').trim();
      let mb = mbSetting === '' ? 256 : Number(mbSetting);
      if (!Number.isFinite(mb) || mb < 0) mb = 256;
      // The reader assumes blocks it just fetched stay cached for a moment: a tiny cache makes it refetch the same bytes.
      if (mb < MIN_DRIVE_CACHE_MB) {
        console.warn(`DRIVE_CACHE_MB=${mbSetting} is too small: using the minimum of ${MIN_DRIVE_CACHE_MB} MB.`);
        mb = MIN_DRIVE_CACHE_MB;
      }
      driveApi = new GoogleDrive({
        account,
        apiBase: (process.env.GOOGLE_API_BASE || 'https://www.googleapis.com').trim(),
        cacheBytes: mb * MiB,
      });
      console.log(`Google Drive enabled (service account ${account.email})`);
    } catch (err) {
      console.error(`GOOGLE_SERVICE_ACCOUNT is set but cannot be used: ${err.message}. Google Drive folders are disabled.`);
    }
  }
}

// ---- Room tokens for the Drive endpoints -----------------------------------------
// A token proves that its holder joined a room (it is only sent in the welcome message, after the
// password check). Format: base64url(JSON {r: room key, e: expiry ms, v: room version}) + '.' +
// base64url(HMAC-SHA256 of the first part). The secret is random per process, so tokens do not
// survive a restart (clients get a fresh one when they reconnect). The version is a hash of the
// room's creation time, password hash and Drive folder: changing the password or the folder
// invalidates every token issued before.
const TOKEN_SECRET = crypto.randomBytes(32);
const TOKEN_TTL_MS = 12 * 3600 * 1000;

function roomVersion(r) {
  return crypto.createHash('sha256').update(`${r.createdAt}\0${r.passwordHash || ''}\0${r.drive?.folderId || ''}`).digest('base64url').slice(0, 16);
}

function tokenSignature(body) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
}

function issueToken(r) {
  const body = Buffer.from(JSON.stringify({ r: RoomStore.key(r.name), e: Date.now() + TOKEN_TTL_MS, v: roomVersion(r) })).toString('base64url');
  return `${body}.${tokenSignature(body)}`;
}

/** The room a valid token belongs to, or null. */
function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 600) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(tokenSignature(body));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  let claim;
  try {
    claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claim || typeof claim.r !== 'string' || typeof claim.e !== 'number' || claim.e < Date.now()) return null;
  const room = store.get(claim.r);
  if (!room || !room.drive || claim.v !== roomVersion(room)) return null;
  return room;
}

// ---- ICE (STUN/TURN) configuration ---------------------------------------
// STUN lets browsers discover their public address so they can connect
// directly. TURN is only needed when two peers cannot reach each other
// (symmetric NAT, strict firewalls); it relays media, so it is opt-in.
function iceServers() {
  const servers = [];
  const stun = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (stun.length) servers.push({ urls: stun });

  const turn = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (turn.length) {
    if (process.env.TURN_SECRET) {
      // coturn "use-auth-secret" ephemeral credentials (valid 12 h).
      const expiry = Math.floor(Date.now() / 1000) + 12 * 3600;
      const username = `${expiry}:three-eight`;
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
      servers.push({ urls: turn, username, credential });
    } else {
      servers.push({ urls: turn, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_PASSWORD || '' });
    }
  }
  return servers;
}

// ---- Helpers ---------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(self), fullscreen=(self), display-capture=(self)',
};

// Content-Security-Policy for the HTML pages. They load only same-origin ES modules and stylesheets.
//  - style-src needs 'unsafe-inline': index.html has an inline style="" attribute (on the SVG sprite).
//    (element.style.x = ... from scripts is not affected by CSP.)
//  - media-src blob: and img-src blob:/data: are for MediaSource / object URLs of local movie files and subtitles.
//  - worker-src blob: is for the Picture-in-Picture worker, which is created from a Blob.
//  - connect-src lists the WebSocket explicitly (older Safari does not match ws: to 'self').
function contentSecurityPolicy(req) {
  const host = String(req.headers.host || '');
  let ws = /^[A-Za-z0-9.:\[\]-]{1,255}$/.test(host) ? ` ws://${host} wss://${host}` : '';
  // The public address may differ from Host (a proxy that rewrites it): it is then listed in ALLOWED_ORIGINS.
  for (const origin of ALLOWED_ORIGINS) if (/^https?:\/\//.test(origin)) ws += ' ' + origin.replace(/^http/, 'ws');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self'${ws}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest']);
const MIN_COMPRESS_BYTES = 256;
const ENCODE_CACHE_BYTES = 32 * 1024 * 1024;
/** `${file}\0${size}\0${mtimeMs}\0${encoding}` -> compressed Buffer (insertion order = age) */
const encodeCache = new Map();
let encodeCacheBytes = 0;
/** same key -> Promise of the compressed Buffer, while it is being produced */
const encodeInFlight = new Map();

/** The best encoding the client accepts and we can produce: 'br', 'gzip' or ''. */
function pickEncoding(req) {
  const accepted = new Map();
  for (const part of String(req.headers['accept-encoding'] || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map((x) => /^\s*q=([\d.]+)\s*$/.exec(x)).find(Boolean);
    accepted.set(name, q ? parseFloat(q[1]) : 1);
  }
  const ok = (n) => (accepted.has(n) ? accepted.get(n) : accepted.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return '';
}

/** Remembers a finished body; the byte count stays exact when it replaces an entry, and the oldest entries go first. */
function cacheEncoded(key, out) {
  const old = encodeCache.get(key);
  if (old) {
    encodeCache.delete(key);
    encodeCacheBytes -= old.length;
  }
  encodeCache.set(key, out);
  encodeCacheBytes += out.length;
  while (encodeCacheBytes > ENCODE_CACHE_BYTES && encodeCache.size > 1) {
    const [oldKey, evicted] = encodeCache.entries().next().value;
    encodeCache.delete(oldKey);
    encodeCacheBytes -= evicted.length;
  }
}

function encodeFile(file, st, encoding) {
  const key = `${file}\0${st.size}\0${st.mtimeMs}\0${encoding}`;
  const hit = encodeCache.get(key);
  if (hit) return Promise.resolve(hit);
  // Concurrent misses share one compression run.
  const running = encodeInFlight.get(key);
  if (running) return running;
  const job = fs.promises.readFile(file).then((raw) => new Promise((resolve, reject) => {
    const done = (err, out) => {
      if (err) return reject(err);
      cacheEncoded(key, out);
      resolve(out);
    };
    if (encoding === 'br') zlib.brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 7, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }, done);
    else zlib.gzip(raw, { level: 9 }, done);
  })).finally(() => encodeInFlight.delete(key));
  encodeInFlight.set(key, job);
  return job;
}

/** Does an If-None-Match header match this ETag (weak comparison, "*" matches anything)? */
function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => bare(t) === etag);
}

/** Answer 500 (if nothing was sent yet) and log the failure; the details stay on the server. */
function internalError(req, res, err) {
  console.error('request failed:', req.method, String(req.url).slice(0, 200), err);
  if (res.headersSent) return res.destroy();
  try {
    sendJson(res, 500, { error: 'Something went wrong on the server.' });
  } catch {
    res.destroy();
  }
}

function sendFile(req, res, file) {
  // fs.stat throws (instead of calling back) for a path with a NUL byte: refuse it, and never let a throw escape.
  if (file.includes('\0')) return sendJson(res, 400, { error: 'Bad request' });
  try {
    fs.stat(file, (err, st) => {
      try {
        if (err || !st.isFile()) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
        const ext = path.extname(file);
        const compressible = COMPRESSIBLE.has(ext);
        const encoding = compressible && st.size >= MIN_COMPRESS_BYTES ? pickEncoding(req) : '';
        // The validator differs per representation (a strong ETag must not be shared by gzip and identity bodies).
        const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}${encoding ? '-' + encoding : ''}"`;
        const headers = {
          ...SECURITY_HEADERS,
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache', // cacheable, but always revalidated (the validators below make that cheap)
          ETag: etag,
          'Last-Modified': new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString(),
        };
        if (ext === '.html') headers['Content-Security-Policy'] = contentSecurityPolicy(req);
        if (compressible) headers.Vary = 'Accept-Encoding';

        const inm = req.headers['if-none-match'];
        const ims = Date.parse(req.headers['if-modified-since'] || '');
        if (inm ? etagMatches(inm, etag) : Number.isFinite(ims) && Math.floor(st.mtimeMs / 1000) * 1000 <= ims) {
          res.writeHead(304, headers);
          res.end();
          return;
        }

        const fail = (e) => {
          if (res.headersSent) return res.destroy();
          if (e && e.code !== 'ENOENT') console.error('static file failed:', e.message);
          sendJson(res, e && e.code === 'ENOENT' ? 404 : 500, { error: e && e.code === 'ENOENT' ? 'Not found' : 'Something went wrong on the server.' });
        };
        if (encoding) {
          encodeFile(file, st, encoding).then((body) => {
            res.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': body.length });
            res.end(req.method === 'HEAD' ? undefined : body);
          }).catch(fail);
          return;
        }
        res.writeHead(200, { ...headers, 'Content-Length': st.size });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const stream = fs.createReadStream(file);
        stream.on('error', fail);
        stream.pipe(res);
      } catch (e) {
        internalError(req, res, e);
      }
    });
  } catch (e) {
    internalError(req, res, e);
  }
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * The value a trusted proxy appended to a comma-separated forwarding header. Each trusted proxy appends the
 * address it saw, so the client's own entry is the TRUSTED_HOPS-th from the right; anything to its left was
 * supplied by the client and must not be believed. With fewer entries than hops, the first one is used.
 */
function forwardedValue(req, header) {
  const raw = req.headers[header];
  if (!raw) return '';
  const parts = String(raw).split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return '';
  return parts[Math.max(0, parts.length - TRUSTED_HOPS)];
}

function clientIp(req) {
  if (TRUSTED_HOPS > 0) {
    // Only a real IP address counts (a forged header can hold any text, which would make unbounded limiter keys).
    const fwd = forwardedAddress(forwardedValue(req, 'x-forwarded-for'));
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  return TRUSTED_HOPS > 0 && forwardedValue(req, 'x-forwarded-proto') === 'https';
}

// Errors caused by bad client input: answered with 400 and their message. Everything else is a 500.
function clientError(message) {
  return Object.assign(new Error(message), { clientError: true });
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(clientError('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        // Handlers read fields from the body: null, numbers, strings and arrays are not a request they can work with.
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(clientError('Invalid JSON'));
      }
    });
    req.on('error', (err) => reject(Object.assign(err, { clientError: true }))); // e.g. the client went away
  });
}

function parseCookies(req) {
  const out = Object.create(null);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Not ours (another app on the same domain may set odd cookies): skip it rather than fail the request.
    }
  }
  return out;
}

// Simple sliding-window limiter for failed password attempts.
// At most MAX_LIMITER_KEYS clients are remembered per limiter: when it is full, expired entries go first, then the oldest one that is not blocked (the oldest overall only if all are).
const MAX_LIMITER_KEYS = 10000;
class FailLimiter {
  constructor(max, windowMs, maxKeys = MAX_LIMITER_KEYS) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.map = new Map(); // key -> {first, count}; insertion order = order of `first`
  }
  blocked(key) {
    const e = this.map.get(key);
    if (!e) return false;
    if (Date.now() - e.first > this.windowMs) {
      this.map.delete(key);
      return false;
    }
    return e.count >= this.max;
  }
  /** Count an attempt before its outcome is known. False (and not counted) when the limit is already reached. */
  reserve(key) {
    if (this.blocked(key)) return false;
    this.fail(key);
    return true;
  }
  /** Give back a reserved attempt that turned out fine. */
  release(key) {
    const e = this.map.get(key);
    if (!e) return;
    if (--e.count <= 0) this.map.delete(key);
  }
  fail(key) {
    const now = Date.now();
    const e = this.map.get(key);
    if (e && now - e.first <= this.windowMs) {
      e.count++;
      return;
    }
    this.map.delete(key); // a new window: re-insert at the end, so the map stays ordered oldest first
    if (this.map.size >= this.maxKeys) this.sweep();
    if (this.map.size >= this.maxKeys) {
      // Still full: drop the oldest entry that is not blocked, so flooding with other keys cannot reset a blocked
      // client's count. Only when every entry is blocked does the oldest one go.
      let victim;
      for (const [k, e] of this.map) {
        if (e.count < this.max) { victim = k; break; }
      }
      this.map.delete(victim === undefined ? this.map.keys().next().value : victim);
    }
    this.map.set(key, { first: now, count: 1 });
  }
  sweep() {
    const now = Date.now();
    for (const [k, e] of this.map) if (now - e.first > this.windowMs) this.map.delete(k);
  }
}
const adminLimiter = new FailLimiter(10, 15 * 60 * 1000);
const roomLimiter = new FailLimiter(20, 10 * 60 * 1000);

// ---- Admin sessions -----------------------------------------------------------
const adminSessions = new Map(); // token -> expiry

function adminAuthed(req) {
  const token = parseCookies(req).te_admin;
  if (!token) return false;
  const exp = adminSessions.get(token);
  if (!exp || exp < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- Live room state ------------------------------------------------------------
/** @type {Map<string, Map<string, {ws: import('ws'), name: string}>>} roomKey -> members */
const live = new Map();

function roomMembers(name) {
  return live.get(RoomStore.key(name));
}

// What room members need to browse the room's Google Drive folder: a token for our endpoints and the
// folder's ID. null when the room has no folder or the server has no service account.
function driveInfo(r) {
  if (!r || !r.drive || !driveApi) return null;
  return { token: issueToken(r), folder: r.drive.folderId };
}

function pushDrive(name) {
  const members = roomMembers(name);
  if (!members) return;
  const info = driveInfo(store.get(name));
  for (const m of members.values()) send(m.ws, { type: 'drive', drive: info });
}

function kickRoom(name, code, message) {
  const members = roomMembers(name);
  if (!members) return;
  for (const m of members.values()) {
    send(m.ws, { type: 'error', code, message });
    m.ws.room = null;
    m.ws.close(4001, code);
  }
  live.delete(RoomStore.key(name));
}

// ---- Google Drive endpoints --------------------------------------------------------
// Open Drive file responses per room (roomKey -> Set of { version, abort }). A token is checked once, before a
// response starts; when the room's access changes (deleted, password, folder) the responses still streaming under the
// old version are cut, so a client that asked for a whole film in one request cannot keep downloading it.
/** @type {Map<string, Set<{version: string, abort: () => void}>>} */
const driveStreams = new Map();

/**
 * Register a streaming response of `room` (the room object its token was verified against). Returns the function that
 * unregisters it, or null when the room is gone or changed since the token was checked (nothing is registered then).
 */
function trackDriveStream(room, abort) {
  const now = store.get(room.name);
  const version = roomVersion(room);
  if (!now || roomVersion(now) !== version) return null;
  const key = RoomStore.key(room.name);
  let set = driveStreams.get(key);
  if (!set) driveStreams.set(key, (set = new Set()));
  const entry = { version, abort };
  set.add(entry);
  return () => {
    set.delete(entry);
    if (set.size === 0 && driveStreams.get(key) === set) driveStreams.delete(key);
  };
}

/** Cut the room's open Drive file responses whose token is no longer valid. Call after the room changed or was removed. */
function dropDriveStreams(name) {
  const set = driveStreams.get(RoomStore.key(name));
  if (!set) return;
  const now = store.get(name);
  const version = now ? roomVersion(now) : null;
  for (const entry of [...set]) if (entry.version !== version) entry.abort();
}

const DRIVE_HEADERS = { 'Cache-Control': 'private, no-store' };

/** After the admin attaches a folder: can the service account read it? */
async function checkFolder(folderId) {
  try {
    driveApi.forget(folderId);
    const info = await driveApi.folderInfo(folderId);
    if (info.mimeType !== FOLDER) return { error: 'That link points to a file, not a folder.' };
    const items = await driveApi.list(folderId);
    return { name: info.name, items: items.length };
  } catch (err) {
    return { error: err instanceof DriveError ? err.message : 'The folder could not be read.' };
  }
}

function driveFail(res, err) {
  if (err instanceof DriveError) {
    if (err.aborted) return res.destroy();
    if (res.headersSent) return res.destroy();
    const body = { error: err.message };
    if (err.permanent) body.permanent = true;
    return sendJson(res, err.status, body, DRIVE_HEADERS);
  }
  console.error('drive request failed:', err && err.message);
  if (res.headersSent) return res.destroy();
  return sendJson(res, 500, { error: 'Something went wrong on the server.' }, DRIVE_HEADERS);
}

const waitDrain = (res) => new Promise((resolve) => {
  // A response that is already gone never emits 'drain' or 'close' again: do not wait for it.
  if (res.destroyed || res.writableEnded) return resolve();
  const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
  res.once('drain', done);
  res.once('close', done);
});

// GET /api/rooms/:room/drive/folders/:id      (id may be "root": the room's folder)
// GET|HEAD /api/rooms/:room/drive/files/:id
// Authorization: Bearer <room token>, or ?t=<room token> (a <video> element cannot send headers).
async function handleDrive(req, res, url, parts) {
  const what = parts[4];
  const isFiles = what === 'files';
  if (parts.length !== 6 || (what !== 'folders' && !isFiles)) return sendJson(res, 404, { error: 'Not found' }, DRIVE_HEADERS);
  if (req.method !== 'GET' && !(req.method === 'HEAD' && isFiles)) return sendJson(res, 405, { error: 'Method not allowed' }, { ...DRIVE_HEADERS, Allow: isFiles ? 'GET, HEAD' : 'GET' });
  if (!driveApi) return sendJson(res, 503, { error: 'Google Drive is not set up on this server.' }, DRIVE_HEADERS);

  const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  const room = verifyToken(bearer ? bearer[1] : url.searchParams.get('t') || '');
  if (!room || RoomStore.key(parts[2]) !== RoomStore.key(room.name)) {
    return sendJson(res, 401, { error: 'Your Drive session is missing or has expired. Rejoin the room.' }, DRIVE_HEADERS);
  }
  const root = room.drive.folderId;
  let id = parts[5];
  if (id === 'root' && !isFiles) id = root;
  if (!DRIVE_ID_RE.test(id)) return sendJson(res, 404, { error: 'Not found' }, DRIVE_HEADERS);

  try {
    // Only the room's folder and what is below it: the service account may be able to read much more.
    if (!(await driveApi.inTree(root, id))) return sendJson(res, 404, { error: 'Not found in this room\'s folder.' }, DRIVE_HEADERS);
    // The room may have changed (password, folder, deleted) while Drive was asked: the token only counts for the room it was issued for.
    if (res.destroyed) return; // the client went away while Drive was asked: nothing to do
    const now = store.get(room.name);
    if (!now || roomVersion(now) !== roomVersion(room)) return sendJson(res, 401, { error: 'Your Drive session is missing or has expired. Rejoin the room.' }, DRIVE_HEADERS);
    if (!isFiles) {
      const [info, items] = await Promise.all([driveApi.folderInfo(id), driveApi.list(id)]);
      if (info.mimeType !== FOLDER) return sendJson(res, 404, { error: 'That is not a folder.' }, DRIVE_HEADERS);
      driveApi.markInTree(root, items.map((f) => f.id));
      return sendJson(res, 200, { id, name: info.name, items }, DRIVE_HEADERS);
    }
    await serveFile(req, res, id, room);
  } catch (err) {
    driveFail(res, err);
  }
}

async function serveFile(req, res, id, room) {
  const meta = await driveApi.fileMeta(id);
  const kind = kindOf(meta);
  if (meta.trashed || (kind !== 'video' && kind !== 'subtitle') || !Number.isSafeInteger(meta.size) || meta.size < 0) {
    return sendJson(res, 404, { error: 'Not found' }, DRIVE_HEADERS);
  }
  const size = meta.size;
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') return sendJson(res, 416, { error: 'Invalid byte range.' }, { ...DRIVE_HEADERS, 'Content-Range': `bytes */${size}` });
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = size ? end - start + 1 : 0;
  const headers = {
    ...SECURITY_HEADERS,
    ...DRIVE_HEADERS,
    // Never let a browser treat a file from the folder as a page of ours.
    'Content-Type': /^video\/[A-Za-z0-9.+-]+$/.test(meta.mimeType) ? meta.mimeType : 'application/octet-stream',
    'Content-Security-Policy': 'sandbox',
    'Accept-Ranges': 'bytes',
    'Content-Length': length,
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const status = range ? 206 : 200;
  if (req.method === 'HEAD' || length === 0) {
    res.writeHead(status, headers);
    return res.end();
  }

  // The client may have gone away while the metadata was fetched: its 'close' has fired and a listener added now would never run.
  if (res.destroyed) return;
  // Stop upstream work when the client goes away.
  const ctrl = new AbortController();
  // Registered once streaming is about to start; fileMeta above was awaited, so the room may have changed since handleDrive checked the token.
  const untrack = trackDriveStream(room, () => {
    ctrl.abort();
    res.destroy(); // the client sees the connection cut, not a clean end
  });
  if (!untrack) return sendJson(res, 401, { error: 'Your Drive session is missing or has expired. Rejoin the room.' }, DRIVE_HEADERS);
  res.on('close', () => {
    untrack();
    ctrl.abort();
  });
  const gen = driveApi.read(id, size, start, end, ctrl.signal);
  try {
    // The first block is fetched before any header is sent, so a Google error still becomes a proper error response.
    let next = await gen.next();
    if (ctrl.signal.aborted) return;
    res.writeHead(status, headers);
    while (!next.done) {
      if (!res.write(next.value)) await waitDrain(res);
      if (ctrl.signal.aborted) return;
      next = await gen.next();
    }
    res.end();
  } finally {
    untrack();
    await gen.return().catch(() => {});
  }
}

// ---- HTTP routing -----------------------------------------------------------------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // Room members: browse and stream the room's Google Drive folder (authorized by a room token).
  if (parts[1] === 'rooms' && parts[3] === 'drive') return handleDrive(req, res, url, parts);

  // Public: does a room exist / need a password?
  if (parts[1] === 'rooms' && parts.length === 3 && req.method === 'GET') {
    const r = store.get(parts[2]);
    if (!r) return sendJson(res, 404, { error: 'Room not found' });
    return sendJson(res, 200, { name: r.name, passwordRequired: !!r.passwordHash });
  }

  if (parts[1] === 'config' && req.method === 'GET') {
    return sendJson(res, 200, { iceServers: iceServers(), maxRoomSize: MAX_ROOM_SIZE });
  }

  // Tests only (needs DRIVE_DEBUG=1): how many Drive file responses the server still tracks.
  if (DRIVE_DEBUG && parts[1] === 'debug' && parts[2] === 'drive-streams' && req.method === 'GET') {
    let streams = 0;
    for (const set of driveStreams.values()) streams += set.size;
    return sendJson(res, 200, { rooms: driveStreams.size, streams });
  }

  if (parts[1] !== 'admin') return sendJson(res, 404, { error: 'Not found' });

  // Admin API. State-changing requests must be JSON (blocks simple cross-site forms)
  // and the session cookie is SameSite=Strict.
  if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return sendJson(res, 415, { error: 'Expected application/json' });
  }

  if (parts[2] === 'login' && req.method === 'POST') {
    const ip = limiterKey(clientIp(req));
    if (adminLimiter.blocked(ip)) return sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
    const body = await readJson(req);
    if (!safeEqual(typeof body.password === 'string' ? body.password : '', ADMIN_PASSWORD)) {
      adminLimiter.fail(ip);
      return sendJson(res, 401, { error: 'Wrong password' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    adminSessions.set(token, Date.now() + ADMIN_SESSION_MS);
    const cookie = `te_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}`;
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (parts[2] === 'logout' && req.method === 'POST') {
    adminSessions.delete(parseCookies(req).te_admin);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'te_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (!adminAuthed(req)) return sendJson(res, 401, { error: 'Not logged in' });

  if (parts[2] === 'session' && req.method === 'GET') return sendJson(res, 200, { ok: true });

  if (parts[2] === 'rooms') {
    const name = parts[3];
    if (!name && req.method === 'GET') {
      const rooms = store.list().map((r) => {
        const m = roomMembers(r.name);
        return { ...r, online: m ? [...m.values()].map((x) => x.name) : [] };
      });
      return sendJson(res, 200, { rooms, serviceAccount: driveApi ? driveApi.account.email : '' });
    }
    if (!name && req.method === 'POST') {
      const body = await readJson(req);
      const password = body.password == null ? '' : body.password;
      if (typeof password !== 'string') return sendJson(res, 400, { error: 'The password must be text.' });
      try {
        await store.create(typeof body.name === 'string' ? body.name.trim() : '', password);
      } catch (err) {
        if (!(err instanceof RoomError)) throw err;
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 201, { ok: true });
    }
    if (name && parts[4] === 'drive' && parts.length === 5 && req.method === 'PUT') {
      const body = await readJson(req);
      let drive;
      try {
        drive = parseDriveFolder(body.link == null ? '' : body.link);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      try {
        store.setDrive(name, drive);
      } catch (err) {
        if (!(err instanceof RoomError)) throw err;
        return sendJson(res, 404, { error: err.message });
      }
      pushDrive(name); // the fresh token is on its way before the old responses are cut
      dropDriveStreams(name);
      const out = { ok: true, drive };
      if (drive && driveApi) out.check = await checkFolder(drive.folderId);
      return sendJson(res, 200, out);
    }
    if (name && parts.length === 4 && req.method === 'PUT') {
      const body = await readJson(req);
      const password = body.password == null ? '' : body.password;
      if (typeof password !== 'string') return sendJson(res, 400, { error: 'The password must be text.' });
      try {
        await store.setPassword(name, password);
      } catch (err) {
        if (!(err instanceof RoomError)) throw err;
        return sendJson(res, 400, { error: err.message });
      }
      if (body.kick === true) kickRoom(name, 'kicked', 'The room password was changed. Please rejoin.');
      else pushDrive(name); // everyone's old Drive token just stopped working: hand out the new one
      dropDriveStreams(name);
      return sendJson(res, 200, { ok: true });
    }
    if (name && req.method === 'DELETE') {
      try {
        store.delete(name);
      } catch (err) {
        if (!(err instanceof RoomError)) throw err;
        return sendJson(res, 404, { error: err.message });
      }
      kickRoom(name, 'room-deleted', 'This room has been deleted.');
      dropDriveStreams(name);
      return sendJson(res, 200, { ok: true });
    }
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// A throw anywhere while routing must become a 500 and a log line, never an uncaught exception.
function handleHttp(req, res) {
  try {
    route(req, res);
  } catch (err) {
    internalError(req, res, err);
  }
}

function route(req, res) {
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (res.headersSent) return res.destroy();
      if (err && err.clientError) return sendJson(res, 400, { error: err.message || 'Bad request' });
      // Internal failure: log it here, but do not tell the client (messages can contain file paths).
      console.error('request failed:', req.method, url.pathname, err);
      sendJson(res, 500, { error: 'Something went wrong on the server.' });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (rel.includes('\0')) {
    res.writeHead(400);
    res.end();
    return;
  }

  if (rel.startsWith('/assets/')) {
    const file = path.resolve(PUBLIC_DIR, '.' + rel);
    if (!file.startsWith(path.join(PUBLIC_DIR, 'assets') + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    sendFile(req, res, file);
    return;
  }

  if (rel === '/admin' || rel === '/admin/') {
    sendFile(req, res, path.join(PUBLIC_DIR, 'admin.html'));
    return;
  }

  if (rel === '/favicon.ico') {
    sendFile(req, res, path.join(PUBLIC_DIR, 'assets', 'icon.svg'));
    return;
  }

  // "/" and "/<ROOM_NAME>" both serve the single-page app.
  const seg = rel.replace(/^\/+|\/+$/g, '');
  if (seg === '' || /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(seg)) {
    sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

const server = process.env.TLS_CERT && process.env.TLS_KEY
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handleHttp)
  : http.createServer(handleHttp);

// ---- Signaling -------------------------------------------------------------
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** True when this socket is the live member registered under its room and id (not merely a socket with those fields set). */
function registered(ws) {
  return !!ws.room && live.get(ws.room)?.get(ws.id)?.ws === ws;
}

// Only text is a name: any other JSON value (an object whose toString is a number, an array, ...) becomes "Guest".
function cleanName(name) {
  if (typeof name !== 'string') return 'Guest';
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Guest';
}

function leave(ws) {
  const { room, id } = ws;
  if (!room) return;
  ws.room = null;
  const members = live.get(room);
  if (!members) return;
  const entry = members.get(id);
  if (entry && entry.ws === ws) {
    members.delete(id);
    for (const m of members.values()) send(m.ws, { type: 'peer-left', id });
  }
  if (members.size === 0) live.delete(room);
}

async function handleJoin(ws, msg) {
  // Every field comes from the client's JSON: only text is usable (ID_RE.test would also accept an array of one string).
  if (typeof msg.room !== 'string' || typeof msg.id !== 'string' || (msg.password != null && typeof msg.password !== 'string')) {
    send(ws, { type: 'error', code: 'bad-request', message: 'Invalid join request' });
    return;
  }
  const roomName = msg.room;
  const id = msg.id;
  const password = msg.password == null ? '' : msg.password;
  const r = store.get(roomName);
  if (!r) {
    send(ws, { type: 'error', code: 'no-room', message: 'This room does not exist.' });
    return;
  }
  if (!ID_RE.test(id)) {
    send(ws, { type: 'error', code: 'bad-request', message: 'Invalid participant id' });
    return;
  }
  const name = cleanName(msg.name);
  // Count the attempt before the (slow) password check, so a burst cannot get past the limit while earlier
  // attempts are still being evaluated. A correct password gives the attempt back. Open rooms cost nothing.
  const reserved = !!r.passwordHash;
  if (reserved && !roomLimiter.reserve(ws.ip)) {
    send(ws, { type: 'error', code: 'rate-limited', message: 'Too many wrong passwords. Try again in a few minutes.' });
    return;
  }
  let ok = false;
  try {
    ok = await store.check(roomName, password);
  } finally {
    if (reserved && ok) roomLimiter.release(ws.ip);
  }
  if (!ok) {
    send(ws, { type: 'error', code: 'bad-password', message: 'Wrong room password.' });
    return;
  }
  if (ws.readyState !== ws.OPEN) return;
  // The store replaces room objects when an admin changes them: look again instead of trusting the copy from before the check.
  const room = store.get(roomName);
  if (!room) {
    send(ws, { type: 'error', code: 'no-room', message: 'This room does not exist.' });
    return;
  }
  if (room.passwordHash !== r.passwordHash) {
    // The password changed while it was being checked: the answer was for the old one.
    send(ws, { type: 'error', code: 'bad-password', message: 'Wrong room password.' });
    return;
  }

  // Everything that could fail is done: from here on the socket is moved into the room in one go.
  const key = RoomStore.key(roomName);
  leave(ws);
  let members = live.get(key);
  const existing = members?.get(id);
  if (!existing && (members ? members.size : 0) >= MAX_ROOM_SIZE) {
    send(ws, { type: 'error', code: 'room-full', message: `Room is full (max ${MAX_ROOM_SIZE}).` });
    return;
  }
  if (!members) {
    members = new Map();
    live.set(key, members);
  }
  if (existing && existing.ws !== ws) {
    // Same participant reconnecting (e.g. after a network blip): replace the old socket.
    existing.ws.room = null;
    try {
      existing.ws.close(4000, 'replaced');
    } catch { /* already gone */ }
  }
  const peers = [...members.entries()].filter(([pid]) => pid !== id).map(([pid, m]) => ({ id: pid, name: m.name }));
  members.set(id, { ws, name });
  ws.room = key;
  ws.id = id;
  try {
    // resumed: this join took over the live entry of the same participant (a reconnect).
    const welcome = { type: 'welcome', id, room: room.name, peers, resumed: !!existing };
    const drive = driveInfo(room);
    if (drive) welcome.drive = drive;
    send(ws, welcome);
    if (!existing) {
      for (const [pid, m] of members) if (pid !== id) send(m.ws, { type: 'peer-joined', id, name });
    }
  } catch (err) {
    leave(ws); // never stay half joined
    throw err;
  }
}

// A Host header as hostname and port; null for anything that is not plainly "name", "name:port", "1.2.3.4:port"
// or "[v6]:port" (no "@", "/", whitespace and the like: such a value is a trick, not a host).
function parseHost(host) {
  const m = /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/.exec(host);
  return m ? { hostname: m[1], port: m[2] || '' } : null;
}

// One log line per failing message, at most once per socket per 10 seconds: a client must not be able to flood the log.
const BAD_MESSAGE_LOG_MS = 10 * 1000;
function logBadMessage(ws, type, err) {
  const now = Date.now();
  if (ws.lastBadLog && now - ws.lastBadLog < BAD_MESSAGE_LOG_MS) return;
  ws.lastBadLog = now;
  console.error(`message failed${type ? ` (${String(type).slice(0, 32)})` : ''}: ${String(err && err.message).slice(0, 200)}`);
}

// Browsers always send Origin on WebSocket handshakes: refuse pages from other sites (cross-site WebSocket
// hijacking). A missing Origin (non-browser clients) is allowed.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let o;
  try {
    o = new URL(String(origin));
  } catch {
    return false; // includes "null"
  }
  if (ALLOWED_ORIGINS.has(o.origin)) return true;
  const host = String(req.headers.host || '').toLowerCase();
  if (host && o.host === host) return true;
  if (TRUSTED_HOPS > 0) {
    // nginx's "proxy_set_header Host $host" drops the port, so behind a trusted proxy the hostname alone may have to
    // match. Not any scheme or port, though: the scheme must be the one the proxy says it received (https <-> forwarded
    // proto), and the port the default one for it or the one in Host. Anything else belongs in ALLOWED_ORIGINS.
    const h = parseHost(host);
    if (!h || o.hostname !== h.hostname) return false;
    const https = isHttps(req);
    if (o.protocol !== (https ? 'https:' : 'http:')) return false;
    const port = o.port || (https ? '443' : '80'); // URL leaves out a default port
    return port === (https ? '443' : '80') || port === h.port;
  }
  return false;
}

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_MESSAGE_BYTES,
  verifyClient: ({ req }, done) => (originAllowed(req) ? done(true) : done(false, 403, 'Forbidden origin')),
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.ip = limiterKey(clientIp(req));
  ws.on('pong', () => { ws.isAlive = true; });
  let tokens = MSG_BURST;
  let refilled = Date.now();
  let limited = false;

  ws.on('message', (raw, isBinary) => {
    if (limited) return; // already cut off: ignore whatever is still in flight
    const now = Date.now();
    tokens = Math.min(MSG_BURST, tokens + ((now - refilled) / 1000) * MSG_REFILL_PER_SEC);
    refilled = now;
    if (--tokens < 0) {
      limited = true;
      ws.close(1008, 'rate-limited');
      // A flooding peer will not finish the close handshake: drop the connection shortly after the close frame went out.
      setTimeout(() => ws.terminate(), 200).unref();
      return;
    }
    if (isBinary) return;
    // Nothing a client sends may take the process down: log it and carry on.
    let msg;
    try {
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'time':
          // Clock sync: echo client timestamp with server time.
          send(ws, { type: 'time', c: msg.c, s: Date.now() });
          break;

        case 'join':
          // One join at a time per socket: otherwise a burst of password guesses is evaluated in parallel.
          if (ws.joining) {
            send(ws, { type: 'error', code: 'busy', message: 'A join is already in progress.' });
            break;
          }
          ws.joining = true;
          handleJoin(ws, msg).catch((err) => {
            // Always answer: a client waiting for its welcome would otherwise wait forever.
            logBadMessage(ws, 'join', err);
            if (!registered(ws)) ws.room = null;
            send(ws, { type: 'error', code: 'server-error', message: 'The server could not add you to the room. Please try again.' });
          }).finally(() => { ws.joining = false; });
          break;

        case 'signal': {
          // Relay WebRTC signaling to one peer in the same room, but only from a socket that really is a member.
          if (!registered(ws) || typeof msg.to !== 'string') return;
          const target = live.get(ws.room)?.get(msg.to);
          if (target) send(target.ws, { type: 'signal', from: ws.id, data: msg.data });
          break;
        }

        case 'rename': {
          if (!registered(ws)) return;
          live.get(ws.room).get(ws.id).name = cleanName(msg.name);
          break;
        }

        case 'leave':
          leave(ws);
          break;

        default:
          break;
      }
    } catch (err) {
      logBadMessage(ws, typeof msg?.type === 'string' ? msg.type : undefined, err);
      if (!registered(ws)) ws.room = null;
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// Drop dead connections so rooms don't keep ghosts; expire old state.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  adminLimiter.sweep();
  roomLimiter.sweep();
  const now = Date.now();
  for (const [t, exp] of adminSessions) if (exp < now) adminSessions.delete(t);
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`Three-Eight listening on ${server instanceof https.Server ? 'https' : 'http'}://${HOST}:${PORT} (data: ${DATA_DIR})`);
});

function shutdown() {
  for (const ws of wss.clients) ws.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
