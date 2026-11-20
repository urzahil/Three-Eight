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
const { limiterKeys, forwardedAddress } = require('./ip');
const { GoogleDrive, DriveError, ID_RE: DRIVE_ID_RE, FOLDER, kindOf, loadServiceAccount, parseRange, MiB } = require('./drive');
const { ConfigError, intSetting, trustedHops, driveCacheMb, adminPassword } = require('./config');

// Settings that are set but unusable stop the server (see config.js) rather than silently change its behaviour.
let PORT, MAX_ROOM_SIZE, TRUSTED_HOPS, DRIVE_CACHE_SETTING_MB, ADMIN_PASSWORD;
try {
  ADMIN_PASSWORD = adminPassword(process.env);
  PORT = intSetting(process.env, 'PORT', 4567, 1, 65535);
  // Each person sends video to everyone else, so the mesh gets heavy well before this upper bound. The bound also keeps
  // the relay limits below sound (see RELAY_FAIR_BYTES).
  MAX_ROOM_SIZE = intSetting(process.env, 'MAX_ROOM_SIZE', 12, 1, 50);
  // Number of trusted reverse proxies in front of the server (0 = none, use the socket's address).
  // TRUST_PROXY=true/1/yes means one hop; a larger number (e.g. 2 for CDN + proxy) means that many.
  TRUSTED_HOPS = trustedHops(process.env);
  DRIVE_CACHE_SETTING_MB = driveCacheMb(process.env, 256);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
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
// Test knobs, honoured only together with DRIVE_DEBUG=1: how old a member's Drive token may get before a new one is
// pushed, and how often the housekeeping tick (which does that) runs. Production uses 45 min (a token lives 1 h) and 30 s.
const TOKEN_REFRESH_MS = (DRIVE_DEBUG && parseInt(process.env.DRIVE_TOKEN_REFRESH_MS, 10)) || 45 * 60 * 1000;
const HEARTBEAT_MS = (DRIVE_DEBUG && parseInt(process.env.HEARTBEAT_MS, 10)) || 30000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_WS_BUFFERED = 4 * 1024 * 1024; // bytes queued for one client before it counts as gone
// Per-socket message budget (token bucket): room for ICE candidate bursts and clock-sync pings.
// A newcomer in a full room sends an offer plus a dozen ICE candidates to each peer, so the burst is generous.
const MSG_BURST = 1000;
const MSG_REFILL_PER_SEC = 100;
const ADMIN_SESSION_MS = 12 * 3600 * 1000;

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
const GOOGLE_API_BASE = 'https://www.googleapis.com';
{
  const keyFile = (process.env.GOOGLE_SERVICE_ACCOUNT || '').trim();
  if (keyFile) {
    try {
      // A fake Google (other token and API endpoints) is for tests only: in production the signed JWT and the
      // bearer tokens must only ever go to Google.
      const account = loadServiceAccount(keyFile, { testEndpoints: DRIVE_DEBUG });
      const apiBase = (process.env.GOOGLE_API_BASE || '').trim().replace(/\/+$/, '') || GOOGLE_API_BASE;
      if (apiBase !== GOOGLE_API_BASE && !DRIVE_DEBUG) throw new Error('GOOGLE_API_BASE is a test setting (it needs DRIVE_DEBUG=1)');
      let mb = DRIVE_CACHE_SETTING_MB;
      // The reader assumes blocks it just fetched stay cached for a moment: a tiny cache makes it refetch the same bytes.
      if (mb < MIN_DRIVE_CACHE_MB) {
        console.warn(`DRIVE_CACHE_MB=${process.env.DRIVE_CACHE_MB.trim()} is too small: using the minimum of ${MIN_DRIVE_CACHE_MB} MB.`);
        mb = MIN_DRIVE_CACHE_MB;
      }
      driveApi = new GoogleDrive({
        account,
        apiBase,
        cacheBytes: mb * MiB,
        maxListItems: (DRIVE_DEBUG && parseInt(process.env.DRIVE_MAX_LIST_ITEMS, 10)) || undefined, // a test knob
      });
      console.log(`Google Drive enabled (service account ${account.email})`);
    } catch (err) {
      console.error(`GOOGLE_SERVICE_ACCOUNT is set but cannot be used: ${err.message}. Google Drive folders are disabled.`);
    }
  }
}

// ---- Room tokens for the Drive endpoints -----------------------------------------
// A token proves that its holder joined a room as a given member: each member gets its own, only over its WebSocket,
// after the password check (in the welcome message, and again before it expires or when the room's access changes).
// Format: base64url(JSON {r: room key, m: member id, i: issued ms, e: expiry ms, v: room version}) + '.' +
// base64url(HMAC-SHA256 of the first part). The secret is random per process, so tokens do not survive a restart
// (clients get a fresh one when they reconnect, and every TOKEN_REFRESH_MS while connected). The version is a hash of
// the room's creation time, password hash and Drive folder: changing the password or the folder invalidates every
// token issued before. Removing one member (admin page) invalidates the tokens issued to that member before the
// removal (see revokeMember); if it joins again, its new token works.
const TOKEN_SECRET = crypto.randomBytes(32);
// Short-lived, so that someone who left the room loses access soon; members get a new one every TOKEN_REFRESH_MS.
const TOKEN_TTL_MS = 3600 * 1000;
/** room key + '\0' + member id -> when the admin removed that member. Kept for TOKEN_TTL_MS (older tokens have expired). */
const revokedMembers = new Map();

const revocationKey = (roomKey, id) => `${roomKey}\0${id}`;

function roomVersion(r) {
  return crypto.createHash('sha256').update(`${r.createdAt}\0${r.passwordHash || ''}\0${r.drive?.folderId || ''}`).digest('base64url').slice(0, 16);
}

function tokenSignature(body) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
}

function issueToken(r, memberId) {
  const now = Date.now();
  const body = Buffer.from(JSON.stringify({ r: RoomStore.key(r.name), m: memberId, i: now, e: now + TOKEN_TTL_MS, v: roomVersion(r) })).toString('base64url');
  return `${body}.${tokenSignature(body)}`;
}

/** Was this token issued to a member before the admin removed it? */
function revoked(claim) {
  const at = revokedMembers.get(revocationKey(claim.r, claim.m));
  return at !== undefined && claim.i <= at;
}

/** A valid token's room, expiry and claims ({ room, exp, claim }), or null. */
function checkToken(token) {
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
  if (!claim || typeof claim.r !== 'string' || typeof claim.m !== 'string' || typeof claim.i !== 'number'
    || typeof claim.e !== 'number' || claim.e < Date.now() || revoked(claim)) return null;
  const room = store.get(claim.r);
  if (!room || !room.drive || claim.v !== roomVersion(room)) return null;
  return { room, exp: claim.e, claim };
}

/** Does a token checkToken() accepted still hold (room unchanged, member not removed)? For after an await. */
function stillValid(checked) {
  const now = store.get(checked.room.name);
  return !!now && roomVersion(now) === roomVersion(checked.room) && !revoked(checked.claim);
}

// ---- ICE (STUN/TURN) configuration ---------------------------------------
// STUN lets browsers discover their public address so they can connect
// directly. TURN is only needed when two peers cannot reach each other
// (symmetric NAT, strict firewalls); it relays media, so it is opt-in.
// TURN credentials let their holder relay traffic through the operator's TURN server: they are only handed to room
// members, after the password check (in the welcome message, and again before they expire). The public /api/config
// lists STUN only.
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TURN_TTL_S = 12 * 3600;
// Members get fresh TURN credentials when theirs are this old (they expire after TURN_TTL_S). DRIVE_DEBUG=1 lets tests shorten it.
const ICE_REFRESH_MS = (DRIVE_DEBUG && parseInt(process.env.ICE_REFRESH_MS, 10)) || 10 * 3600 * 1000;

function stunServers() {
  const stun = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return stun.length ? [{ urls: stun }] : [];
}

/** STUN and, when configured, TURN with credentials. For room members only. */
function iceServers() {
  const servers = stunServers();
  const turn = TURN_URLS;
  if (turn.length) {
    if (process.env.TURN_SECRET) {
      // coturn "use-auth-secret" ephemeral credentials (valid 12 h).
      const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_S;
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
//  - style-src has no 'unsafe-inline': keep style="" attributes and <style> out of the HTML (use a class).
//    Setting element.style.x = ... from scripts is not affected by CSP.
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
    "style-src 'self'",
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
  return TRUSTED_HOPS > 0 && forwardedValue(req, 'x-forwarded-proto').toLowerCase() === 'https';
}

// Errors caused by bad client input: answered with 400 and their message. Everything else is a 500.
function clientError(message) {
  return Object.assign(new Error(message), { clientError: true });
}

// After a body turned out too large, this much more of it is read (and thrown away) so the 413 reaches the client:
// closing a socket with unread data resets the connection, and the client may then never see the answer.
const DRAIN_AFTER_LIMIT = 1024 * 1024;

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          reject(Object.assign(clientError('Body too large'), { status: 413 }));
        }
        if (size > limit + DRAIN_AFTER_LIMIT) req.destroy(); // not worth reading any further
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
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
  /** Failures counted for this key in its current window (0 when none). */
  failures(key) {
    const e = this.map.get(key);
    return e && Date.now() - e.first <= this.windowMs ? e.count : 0;
  }
  sweep() {
    const now = Date.now();
    for (const [k, e] of this.map) if (now - e.first > this.windowMs) this.map.delete(k);
  }
}

// A client is counted under each of its limiter keys (ip.js limiterKeys): an IPv4 address, or an IPv6 address's /64, /56
// and /48. A wider prefix may use this many times the allowance of one client (several households or phones can share
// it), but not 256 or 65,536 times: otherwise one person with a /48 gets a fresh allowance for every /64 in it.
const PREFIX_SCALE = [1, 2, 4];

/** A FailLimiter per prefix length (see PREFIX_SCALE), with the same methods taking a client's keys: blocked when any key is. */
class TieredLimiter {
  constructor(max, windowMs) {
    this.tiers = PREFIX_SCALE.map((scale) => new FailLimiter(max * scale, windowMs));
  }
  blocked(keys) {
    return keys.some((key, i) => this.tiers[i].blocked(key));
  }
  reserve(keys) {
    if (this.blocked(keys)) return false;
    this.fail(keys);
    return true;
  }
  release(keys) {
    keys.forEach((key, i) => this.tiers[i].release(key));
  }
  fail(keys) {
    keys.forEach((key, i) => this.tiers[i].fail(key));
  }
  /** Has this client (or its wider prefix) failed at all in the current window? */
  failed(keys) {
    return keys.some((key, i) => this.tiers[i].failures(key) > 0);
  }
  sweep() {
    for (const t of this.tiers) t.sweep();
  }
}

/** The limiter keys of the client that sent this request. */
const clientKeys = (req) => limiterKeys(clientIp(req));

const adminLimiter = new TieredLimiter(10, 15 * 60 * 1000);
// Failed admin logins from every client together. With enough addresses (a botnet) the per-client limit alone would
// allow 10 guesses from each. Past this many in the window, a client that has failed at all in its window gets no more
// attempts until it ends: one guess per address. Refusing everyone instead would let an attacker with a dozen addresses
// keep the admin from logging in for as long as it likes; this way the admin, typing the password right, still gets in.
const adminGlobalLimiter = new FailLimiter(100, 15 * 60 * 1000);
const EVERYONE = '*'; // adminGlobalLimiter's only key
let adminGlobalNoted = false; // logged that adminGlobalLimiter is blocking (reset by the heartbeat once it no longer is)
const roomLimiter = new TieredLimiter(20, 10 * 60 * 1000);
// Lookups of rooms that do not exist (the lobby's GET /api/rooms/:room, or a join): room names are often guessable, and
// a room without a password is open to whoever finds it, so finding names by trying many must be slow. While a client
// is over the limit every lookup is refused, existing rooms included: the answer must not tell the two apart.
const lookupLimiter = new TieredLimiter(30, 10 * 60 * 1000);
const LOOKUP_LIMITED = 'Too many rooms that do not exist were tried. Try again in a few minutes.';

class GateBusy extends Error {}

/** Runs at most `max` tasks at once; up to `queue` more wait for a slot, and beyond that run() rejects with GateBusy. */
class Gate {
  constructor(max, queue) {
    this.max = max;
    this.queue = queue;
    this.active = 0;
    this.waiting = [];
  }
  async run(fn) {
    if (this.active < this.max) this.active++;
    else if (this.waiting.length >= this.queue) throw new GateBusy('busy');
    else await new Promise((resolve) => this.waiting.push(resolve)); // the slot is handed over by the task that frees it
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

// A room password check (scrypt) keeps a thread of libuv's pool busy for tens of milliseconds, and that pool (4 threads
// by default) also reads the static files and resolves host names. At most this many checks run at once, so guesses
// from many addresses cannot stall the rest of the server; a few more wait, and beyond that a join is asked to retry.
const passwordChecks = new Gate(2, 32);

// ---- Admin sessions -----------------------------------------------------------
const adminSessions = new Map(); // token -> expiry
const MAX_ADMIN_SESSIONS = 256;

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
// folder's ID. null when the room has no folder or the server has no service account. In a room without a password
// that is anyone who knows the room's name: the admin page warns about it.
function driveInfo(r, memberId) {
  if (!r || !r.drive || !driveApi) return null;
  return { token: issueToken(r, memberId), folder: r.drive.folderId };
}

function pushDrive(name) {
  const members = roomMembers(name);
  if (!members) return;
  const room = store.get(name);
  for (const [id, m] of members) {
    send(m.ws, { type: 'drive', drive: driveInfo(room, id) });
    m.driveAt = Date.now();
  }
}

/** Hand a fresh token to the members whose last one is older than TOKEN_REFRESH_MS (a token lives TOKEN_TTL_MS). */
function refreshDriveTokens() {
  if (!driveApi) return;
  const now = Date.now();
  for (const [key, members] of live) {
    let room; // looked up once per room and tick
    for (const [id, m] of members) {
      if (now - m.driveAt < TOKEN_REFRESH_MS) continue;
      room ??= store.get(key) || null;
      const info = driveInfo(room, id);
      if (!info) break; // no folder (any more): nothing to refresh
      send(m.ws, { type: 'drive', drive: info });
      m.driveAt = now;
    }
  }
}

/** The admin removed a member: the tokens issued to it until now stop working, and its open Drive file responses are cut. */
function revokeMember(roomKey, id) {
  revokedMembers.set(revocationKey(roomKey, id), Date.now());
  const set = driveStreams.get(roomKey);
  if (set) for (const entry of [...set]) if (entry.member === id) entry.abort();
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
// Open Drive file responses per room (roomKey -> Set of { version, member, abort }). A token is checked once, before a
// response starts; when the room's access changes (deleted, password, folder) the responses still streaming under the
// old version are cut, and so are a member's when the admin removes it, so a client that asked for a whole film in
// one request cannot keep downloading it.
/** @type {Map<string, Set<{version: string, member: string, abort: () => void}>>} */
const driveStreams = new Map();

// At most this many file responses are open per room at once (a viewer has a few in flight; members x 3 is generous).
// More would be one room using the server's whole upstream budget, e.g. a client that opens requests without reading.
const MAX_DRIVE_STREAMS_PER_ROOM = 3 * MAX_ROOM_SIZE;
// ... and per member, so that one member cannot hold all of the room's: the app reads at most 4 parts of a film at once,
// plus a few small reads and what the browser's own player asks for.
const MAX_DRIVE_STREAMS_PER_MEMBER = 8;

/**
 * Register a streaming response under a token checkToken() accepted. Returns the function that unregisters it, null
 * when the token no longer holds (room gone or changed, member removed: nothing is registered then), 'busy' when
 * the room already has too many open file responses, or 'member-busy' when this member has.
 */
function trackDriveStream(checked, abort) {
  if (!stillValid(checked)) return null;
  const { room } = checked;
  const version = roomVersion(room);
  const key = RoomStore.key(room.name);
  let set = driveStreams.get(key);
  if ((set?.size || 0) >= MAX_DRIVE_STREAMS_PER_ROOM) return 'busy';
  let mine = 0;
  for (const e of set || []) if (e.member === checked.claim.m) mine++;
  if (mine >= MAX_DRIVE_STREAMS_PER_MEMBER) return 'member-busy';
  if (!set) driveStreams.set(key, (set = new Set()));
  const entry = { version, member: checked.claim.m, abort };
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

// Drive requests for IDs that are not in the room's folder: finding that out costs a Drive API call (a walk up the
// folder tree) that no cache answers when the IDs are made up, and the API quota is shared by every room. The app only
// asks for what a folder listing showed, so a client rarely misses; past the limit, every Drive request it makes gets 429
// for a while. (drive.js also caps the rate of metadata calls for all clients together.)
const driveMissLimiter = new TieredLimiter(60, 10 * 60 * 1000);
const DRIVE_MISSES_LIMITED = 'Too many requests for files that are not in this room\'s folder. Try again in a few minutes.';

/** After the admin attaches a folder: can the service account read it? */
async function checkFolder(folderId) {
  try {
    driveApi.forget(folderId);
    const info = await driveApi.folderInfo(folderId);
    if (info.mimeType !== FOLDER) return { error: 'That link points to a file, not a folder.' };
    const { items, truncated } = await driveApi.listing(folderId);
    return { name: info.name, items: items.length, ...(truncated && { truncated: true }) };
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

// A <video> element cannot send an Authorization header, and a token in the URL would end up in access logs, so native
// playback uses a cookie instead: POST .../drive/session sets it from the Bearer token. One cookie per room (its name
// carries a hash of the room key), because the cookie path covers all rooms.
const DRIVE_COOKIE_PREFIX = 't8d_';
const MAX_COOKIE_HEADER = 8192; // browsers send far less; anything longer is not parsed

function driveCookieName(roomKey) {
  return DRIVE_COOKIE_PREFIX + crypto.createHash('sha256').update(roomKey).digest('base64url').slice(0, 16);
}

/** The Drive token cookie of this room, or ''. Only that one cookie is looked at, in a bounded header. */
function driveCookie(req, roomKey) {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > MAX_COOKIE_HEADER) return '';
  const name = driveCookieName(roomKey);
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// POST   /api/rooms/:room/drive/session   Authorization: Bearer <room token>  ->  204 + the room's token cookie
// DELETE /api/rooms/:room/drive/session   (no authentication)                 ->  204 + the cookie cleared
// The cookie outlives the page (up to the token's hour), so a member who leaves clears it: on a shared computer the next
// user must not inherit it. Clearing needs no token (it only removes the caller's own cookie), works for rooms that no
// longer exist and does not depend on Drive being set up.
function handleDriveSession(req, res, parts) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return sendJson(res, 405, { error: 'Method not allowed' }, { ...DRIVE_HEADERS, Allow: 'POST, DELETE' });
  const del = req.method === 'DELETE';
  if (!del && !driveApi) return sendJson(res, 503, { error: 'Google Drive is not set up on this server.' }, DRIVE_HEADERS);
  // There is no body to read; refuse a large one instead of draining it.
  if (Number(req.headers['content-length'] || 0) > 1024) return sendJson(res, 413, { error: 'Body too large' }, DRIVE_HEADERS);
  req.resume();
  if (del) {
    const cleared = `${driveCookieName(RoomStore.key(parts[2]))}=; Path=/api/rooms/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;
    res.writeHead(204, { ...SECURITY_HEADERS, ...DRIVE_HEADERS, 'Set-Cookie': cleared });
    return res.end();
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  const checked = bearer && checkToken(bearer[1]);
  if (!checked || RoomStore.key(parts[2]) !== RoomStore.key(checked.room.name)) {
    return sendJson(res, 401, { error: 'Your Drive session is missing or has expired. Rejoin the room.' }, DRIVE_HEADERS);
  }
  const maxAge = Math.max(0, Math.floor((checked.exp - Date.now()) / 1000));
  const cookie = `${driveCookieName(RoomStore.key(checked.room.name))}=${bearer[1]}; Path=/api/rooms/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  res.writeHead(204, { ...SECURITY_HEADERS, ...DRIVE_HEADERS, 'Set-Cookie': cookie });
  res.end();
}

// GET /api/rooms/:room/drive/folders/:id      (id may be "root": the room's folder)
// GET|HEAD /api/rooms/:room/drive/files/:id
// Authorization: Bearer <room token>, or else the room's token cookie (see handleDriveSession). Never the URL.
async function handleDrive(req, res, url, parts) {
  const what = parts[4];
  if (what === 'session' && parts.length === 5) return handleDriveSession(req, res, parts);
  const isFiles = what === 'files';
  if (parts.length !== 6 || (what !== 'folders' && !isFiles)) return sendJson(res, 404, { error: 'Not found' }, DRIVE_HEADERS);
  if (req.method !== 'GET' && !(req.method === 'HEAD' && isFiles)) return sendJson(res, 405, { error: 'Method not allowed' }, { ...DRIVE_HEADERS, Allow: isFiles ? 'GET, HEAD' : 'GET' });
  if (!driveApi) return sendJson(res, 503, { error: 'Google Drive is not set up on this server.' }, DRIVE_HEADERS);

  const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  const checked = checkToken(bearer ? bearer[1] : driveCookie(req, RoomStore.key(parts[2])));
  const room = checked?.room;
  if (!room || RoomStore.key(parts[2]) !== RoomStore.key(room.name)) {
    return sendJson(res, 401, { error: 'Your Drive session is missing or has expired. Rejoin the room.' }, DRIVE_HEADERS);
  }
  const root = room.drive.folderId;
  let id = parts[5];
  if (id === 'root' && !isFiles) id = root;
  if (!DRIVE_ID_RE.test(id)) return sendJson(res, 404, { error: 'Not found' }, DRIVE_HEADERS);
  // Counted as a miss until the ID turns out to be in the folder (see driveMissLimiter). Reserved before the walk, so a
  // burst of requests cannot all start one before the first misses are counted.
  const keys = clientKeys(req);
  if (!driveMissLimiter.reserve(keys)) return sendJson(res, 429, { error: DRIVE_MISSES_LIMITED }, { ...DRIVE_HEADERS, 'Retry-After': '600' });

  try {
    // Only the room's folder and what is below it: the service account may be able to read much more.
    let inside;
    try {
      inside = await driveApi.inTree(root, id);
    } catch (err) {
      driveMissLimiter.release(keys); // Google failed (or was busy): not the client's miss
      throw err;
    }
    if (!inside) return sendJson(res, 404, { error: 'Not found in this room\'s folder.' }, DRIVE_HEADERS);
    driveMissLimiter.release(keys);
    // The room may have changed (password, folder, deleted), or its member been removed, while Drive was asked: the
    // token only counts for the room and member it was issued to.
    if (res.destroyed) return; // the client went away while Drive was asked: nothing to do
    if (!stillValid(checked)) return sendJson(res, 401, { error: 'Your Drive session is missing or has expired. Rejoin the room.' }, DRIVE_HEADERS);
    if (!isFiles) {
      const [info, { items, truncated }] = await Promise.all([driveApi.folderInfo(id), driveApi.listing(id)]);
      if (!stillValid(checked)) return sendJson(res, 401, { error: 'Your Drive session is missing or has expired. Rejoin the room.' }, DRIVE_HEADERS);
      if (info.mimeType !== FOLDER) return sendJson(res, 404, { error: 'That is not a folder.' }, DRIVE_HEADERS);
      driveApi.markInTree(root, items.map((f) => f.id));
      // `truncated`: the folder is larger than the server lists (the rest is not shown).
      return sendJson(res, 200, { id, name: info.name, items, ...(truncated && { truncated: true }) }, DRIVE_HEADERS);
    }
    await serveFile(req, res, id, checked);
  } catch (err) {
    driveFail(res, err);
  }
}

async function serveFile(req, res, id, checked) {
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
  const untrack = trackDriveStream(checked, () => {
    ctrl.abort();
    res.destroy(); // the client sees the connection cut, not a clean end
  });
  if (untrack === 'busy') return sendJson(res, 429, { error: 'Too many movie streams are open in this room right now. Wait a moment and try again.' }, { ...DRIVE_HEADERS, 'Retry-After': '5' });
  if (untrack === 'member-busy') return sendJson(res, 429, { error: 'You have too many movie streams open right now. Wait a moment and try again.' }, { ...DRIVE_HEADERS, 'Retry-After': '5' });
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
    const keys = clientKeys(req);
    if (lookupLimiter.blocked(keys)) return sendJson(res, 429, { error: LOOKUP_LIMITED }, { 'Retry-After': '600' });
    const r = store.get(parts[2]);
    if (!r) {
      lookupLimiter.fail(keys);
      return sendJson(res, 404, { error: 'Room not found' });
    }
    return sendJson(res, 200, { name: r.name, passwordRequired: !!r.passwordHash });
  }

  if (parts[1] === 'config' && parts.length === 2 && req.method === 'GET') {
    // STUN only: TURN credentials go to room members over the WebSocket (see iceServers()).
    return sendJson(res, 200, { iceServers: stunServers(), maxRoomSize: MAX_ROOM_SIZE });
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

  // Every admin route matches its exact path: /api/admin/rooms/x/anything must not act on room x.
  const action = parts.length === 3 ? parts[2] : '';

  if (action === 'login' && req.method === 'POST') {
    const keys = clientKeys(req);
    const limited = () => (adminLimiter.blocked(keys) ? 'Too many attempts. Try again later.'
      : adminGlobalLimiter.blocked(EVERYONE) && adminLimiter.failed(keys) ? 'Too many failed logins on this server. Try again later.' : '');
    if (limited()) return sendJson(res, 429, { error: limited() });
    const body = await readJson(req);
    // Check again: other attempts may have failed while this body was arriving. From here to fail() nothing awaits,
    // so concurrent requests cannot all slip past the limits.
    if (limited()) return sendJson(res, 429, { error: limited() });
    if (!safeEqual(typeof body.password === 'string' ? body.password : '', ADMIN_PASSWORD)) {
      adminLimiter.fail(keys);
      adminGlobalLimiter.fail(EVERYONE);
      if (adminGlobalLimiter.blocked(EVERYONE) && !adminGlobalNoted) {
        adminGlobalNoted = true;
        console.warn('Too many failed admin logins from all clients together: for up to 15 minutes, an address that fails once gets no more attempts.');
      }
      return sendJson(res, 401, { error: 'Wrong password' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    // Logging in again and again (a script) must not grow the map without bound: the oldest sessions go first.
    while (adminSessions.size >= MAX_ADMIN_SESSIONS) adminSessions.delete(adminSessions.keys().next().value);
    adminSessions.set(token, Date.now() + ADMIN_SESSION_MS);
    const cookie = `te_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}`;
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (action === 'logout' && req.method === 'POST') {
    req.resume(); // the body is not needed
    adminSessions.delete(parseCookies(req).te_admin);
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': `te_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isHttps(req) ? '; Secure' : ''}`,
    });
  }

  if (!adminAuthed(req)) return sendJson(res, 401, { error: 'Not logged in' });

  if (action === 'session' && req.method === 'GET') return sendJson(res, 200, { ok: true });

  if (parts[2] === 'rooms') {
    const name = parts[3];
    if (parts.length === 3 && req.method === 'GET') {
      const rooms = store.list().map((r) => {
        const m = roomMembers(r.name);
        // online: the names (as before); members: who is in the room, with the ids the admin can remove them by.
        return { ...r, online: m ? [...m.values()].map((x) => x.name) : [], members: m ? [...m].map(([id, x]) => ({ id, name: x.name })) : [] };
      });
      return sendJson(res, 200, { rooms, serviceAccount: driveApi ? driveApi.account.email : '' });
    }
    if (parts.length === 3 && req.method === 'POST') {
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
    if (parts.length === 5 && parts[4] === 'drive' && req.method === 'PUT') {
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
        return sendJson(res, err.status, { error: err.message });
      }
      pushDrive(name); // the fresh token is on its way before the old responses are cut
      dropDriveStreams(name);
      const out = { ok: true, drive };
      if (drive && driveApi) out.check = await checkFolder(drive.folderId);
      return sendJson(res, 200, out);
    }
    if (parts.length === 4 && req.method === 'PUT') {
      const body = await readJson(req);
      const password = body.password == null ? '' : body.password;
      if (typeof password !== 'string') return sendJson(res, 400, { error: 'The password must be text.' });
      try {
        await store.setPassword(name, password);
      } catch (err) {
        if (!(err instanceof RoomError)) throw err;
        return sendJson(res, err.status, { error: err.message });
      }
      if (body.kick === true) kickRoom(name, 'kicked', 'The room password was changed. Please rejoin.');
      else pushDrive(name); // everyone's old Drive token just stopped working: hand out the new one
      dropDriveStreams(name);
      return sendJson(res, 200, { ok: true });
    }
    if (parts.length === 6 && parts[4] === 'members' && req.method === 'DELETE') {
      req.resume(); // the body is not needed
      // Remove one person from the room now. They can join again with the password: to keep them out, change it.
      const entry = roomMembers(name)?.get(parts[5]);
      if (!entry) return sendJson(res, 404, { error: 'That person is not in the room (any more).' });
      const { ws } = entry;
      revokeMember(RoomStore.key(name), parts[5]); // its Drive token and downloads stop working first
      send(ws, { type: 'error', code: 'kicked', message: 'The administrator removed you from the room.' });
      leave(ws); // the others get peer-left now, not when the socket has closed
      ws.close(4001, 'kicked');
      return sendJson(res, 200, { ok: true });
    }
    if (parts.length === 4 && req.method === 'DELETE') {
      try {
        store.delete(name);
      } catch (err) {
        if (!(err instanceof RoomError)) throw err;
        return sendJson(res, err.status, { error: err.message });
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
      // A body that is too large: the connection closes after the answer (readJson drains a bounded part of the rest).
      if (err && err.clientError) return sendJson(res, err.status || 400, { error: err.message || 'Bad request' }, err.status === 413 ? { Connection: 'close' } : {});
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

  // Installable app: the service worker must sit at the root so that its scope covers every room.
  if (rel === '/sw.js' || rel === '/manifest.webmanifest') {
    sendFile(req, res, path.join(PUBLIC_DIR, rel.slice(1)));
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
// A participant id is not secret: every member sees everyone's. What lets a join take over the live entry of an id (a
// reconnect, or the same tab after a reload) is the secret the client generated with it, which only that tab knows.
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

function secretHash(secret) {
  return secret ? crypto.createHash('sha256').update(secret).digest() : null;
}

/** May a join with this secret take over a live entry? Only with the secret that entry was created with. */
function sameSecret(a, b) {
  return !!a && !!b && crypto.timingSafeEqual(a, b);
}

// A socket that has not joined a room within this time (after connecting, or after leaving one) is closed: an open
// socket costs memory, and only members need one. DRIVE_DEBUG=1 lets tests shorten it.
const JOIN_DEADLINE_MS = (DRIVE_DEBUG && parseInt(process.env.JOIN_DEADLINE_MS, 10)) || 30 * 1000;
// Open sockets per client (under each of its limiter keys: an IPv6 /56 or /48 may hold PREFIX_SCALE times as many as
// one /64). Everybody on one network (a household, a party on one Wi-Fi) shares an address, hence the generous floor.
const MAX_SOCKETS_PER_CLIENT = Math.max(64, 2 * MAX_ROOM_SIZE);
/** @type {Map<string, number>} limiter key -> open sockets */
const socketsPerClient = new Map();
let lastSocketCapLog = 0;

// Relayed signals: one is at most MAX_SIGNAL_BYTES (a Chromium offer is about 6 KB, 10 KB while sharing a screen), and
// each socket has a byte budget for what it makes the server send to others (a token bucket: a burst, then a steady
// rate). Without it, a member with a fast uplink could fill another member's send buffer until that member counts as
// stalled and is dropped. A newcomer sends about 9 KB per member (an offer and its candidates), and so does starting a
// screen share: the burst covers that for a full room of MAX_ROOM_SIZE. A signal over the budget is not relayed, but
// its sender stays connected: what a member sends is not always its own doing, since it answers every offer it gets
// (the app answers at most MAX_OFFERS_PER_PEER a minute from each peer, see mesh.js).
const MAX_SIGNAL_BYTES = 32 * 1024;
const SIGNAL_BYTES_BURST = Math.max(512 * 1024, MAX_ROOM_SIZE * 16 * 1024);
const SIGNAL_BYTES_PER_SEC = 64 * 1024;

// Several members together can still send one member more than its link carries, each within its own budget. So the
// relayed bytes are also counted per receiver and sender (in windows of RELAY_WINDOW_MS); while a receiver's send buffer
// is past RELAY_BACKLOG, the signals of a member that sent it more than RELAY_FAIR_BYTES in the window are not delivered
// to it, rather than the receiver being dropped as stalled for what others sent it. The sender is not disconnected for
// that: the receiver may be the one at fault, by not reading (a member can fill its own buffer on purpose) while asking
// an honest member for answers. An honest member sends one peer an offer and its candidates (about 9 KB), a few times
// at most in a window. While a receiver is behind its window does not start over, so until it has caught up each
// sender adds at most RELAY_FAIR_BYTES: with at most 49 others in a room (MAX_ROOM_SIZE <= 50), about 3.4 MB in all,
// under the 4 MB at which send() drops a receiver. A receiver that really stopped reading is still dropped: by the
// heartbeat, or by that guard in send().
const RELAY_WINDOW_MS = 10 * 1000;
const RELAY_BACKLOG = 1024 * 1024;
const RELAY_FAIR_BYTES = 48 * 1024;

/**
 * Count a relay of `bytes` from socket `from` to socket `to`. False (the signal is not delivered) when `to` is behind
 * and `from` has sent it more than a fair share in this window.
 */
function relayAllowed(from, to, bytes, now) {
  const behind = to.bufferedAmount > RELAY_BACKLOG;
  let inbound = to.inbound;
  // Keyed by socket, weakly: senders that have gone are not kept alive by a receiver that stays behind.
  if (!inbound || (now - inbound.since > RELAY_WINDOW_MS && !behind)) inbound = to.inbound = { since: now, bytes: new WeakMap() };
  const sent = (inbound.bytes.get(from) || 0) + bytes;
  inbound.bytes.set(from, sent);
  return !behind || sent <= RELAY_FAIR_BYTES;
}

function armJoinDeadline(ws) {
  clearTimeout(ws.joinDeadline);
  ws.joinDeadline = setTimeout(() => {
    if (registered(ws)) return;
    if (ws.joining) return armJoinDeadline(ws); // a join is being evaluated: give it its answer first
    ws.close(4002, 'join-timeout');
    setTimeout(() => ws.terminate(), 2000).unref();
  }, JOIN_DEADLINE_MS);
  ws.joinDeadline.unref();
}

function send(ws, msg) {
  if (ws.readyState !== ws.OPEN) return;
  // A client that stopped reading (stalled connection) would otherwise collect everything its room sends until the
  // heartbeat notices: drop it instead. Signaling needs every message in order, so skipping some is no option.
  if (ws.bufferedAmount > MAX_WS_BUFFERED) {
    ws.terminate();
    return;
  }
  ws.send(JSON.stringify(msg));
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
  armJoinDeadline(ws); // a socket without a room may stay open only briefly (cleared when it closes)
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
  if (typeof msg.room !== 'string' || typeof msg.id !== 'string' || (msg.password != null && typeof msg.password !== 'string')
    || (msg.secret != null && (typeof msg.secret !== 'string' || !SECRET_RE.test(msg.secret)))) {
    send(ws, { type: 'error', code: 'bad-request', message: 'Invalid join request' });
    return;
  }
  const roomName = msg.room;
  const id = msg.id;
  const password = msg.password == null ? '' : msg.password;
  // Without a secret (a client from before secrets existed) a join can use a free id, but never take over a live one.
  const secret = secretHash(msg.secret);
  if (lookupLimiter.blocked(ws.keys)) {
    send(ws, { type: 'error', code: 'rate-limited', message: LOOKUP_LIMITED });
    return;
  }
  const r = store.get(roomName);
  if (!r) {
    lookupLimiter.fail(ws.keys);
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
  if (reserved && !roomLimiter.reserve(ws.keys)) {
    send(ws, { type: 'error', code: 'rate-limited', message: 'Too many wrong passwords. Try again in a few minutes.' });
    return;
  }
  let ok = false;
  try {
    ok = reserved ? await passwordChecks.run(() => store.check(roomName, password)) : await store.check(roomName, password);
  } catch (err) {
    if (!(err instanceof GateBusy)) throw err;
    // Not checked at all: the attempt does not count. 'busy' is not final for the client, which tries again shortly.
    roomLimiter.release(ws.keys);
    send(ws, { type: 'error', code: 'busy', message: 'The server is busy. Trying again shortly.' });
    return;
  } finally {
    if (reserved && ok) roomLimiter.release(ws.keys);
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
  if (existing && !sameSecret(existing.secret, secret)) {
    // Someone else's id (every member can see it): taking it over would disconnect that person and let the newcomer
    // sign as them.
    send(ws, { type: 'error', code: 'id-taken', message: 'Someone in this room is already connected with your connection id. Reload the page to join again.' });
    return;
  }
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
  // driveAt / iceAt: when this socket last got a Drive token / TURN credentials. secret: hash of the id's secret.
  const member = { ws, name, driveAt: 0, iceAt: Date.now(), secret };
  members.set(id, member);
  ws.room = key;
  ws.id = id;
  clearTimeout(ws.joinDeadline);
  try {
    // resumed: this join took over the live entry of the same participant (a reconnect).
    const welcome = { type: 'welcome', id, room: room.name, peers, resumed: !!existing, iceServers: iceServers() };
    const drive = driveInfo(room, id);
    if (drive) {
      welcome.drive = drive;
      member.driveAt = Date.now();
    }
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

/** Is this client below its socket limit under each of its keys? Says so in the log (at most once a minute) when it is not. */
function socketAllowed(keys) {
  const full = keys.findIndex((key, i) => (socketsPerClient.get(key) || 0) >= MAX_SOCKETS_PER_CLIENT * PREFIX_SCALE[i]);
  if (full < 0) return true;
  const now = Date.now();
  if (now - lastSocketCapLog > 60 * 1000) {
    lastSocketCapLog = now;
    console.warn(`Refused a WebSocket: ${socketsPerClient.get(keys[full])} are already open from one client address (${keys[full]}). `
      + 'If every visitor shows the same address, the server runs behind a proxy without TRUST_PROXY.');
  }
  return false;
}

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_MESSAGE_BYTES,
  verifyClient: ({ req }, done) => {
    if (!originAllowed(req)) return done(false, 403, 'Forbidden origin');
    if (!socketAllowed(clientKeys(req))) return done(false, 429, 'Too many connections');
    return done(true);
  },
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.keys = clientKeys(req);
  for (const key of ws.keys) socketsPerClient.set(key, (socketsPerClient.get(key) || 0) + 1);
  armJoinDeadline(ws);
  ws.on('pong', () => { ws.isAlive = true; });
  let tokens = MSG_BURST;
  let refilled = Date.now();
  let signalBytes = SIGNAL_BYTES_BURST;
  let signalRefilled = refilled;
  ws.limited = false;
  // For a socket that sends more messages than MSG_BURST / MSG_REFILL_PER_SEC allow.
  ws.cutOff = () => {
    if (ws.limited) return;
    ws.limited = true;
    ws.close(1008, 'rate-limited');
    // A flooding peer will not finish the close handshake: drop the connection shortly after the close frame went out.
    setTimeout(() => ws.terminate(), 200).unref();
  };

  ws.on('message', (raw, isBinary) => {
    if (ws.limited) return; // already cut off: ignore whatever is still in flight
    const now = Date.now();
    tokens = Math.min(MSG_BURST, tokens + ((now - refilled) / 1000) * MSG_REFILL_PER_SEC);
    refilled = now;
    if (--tokens < 0) {
      ws.cutOff();
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
          // Clock sync: echo the client's timestamp with server time. Only a number: otherwise a client could make the
          // server queue replies of up to 64 KB each for it, e.g. to fill its own send buffer on purpose (see relayAllowed).
          if (typeof msg.c === 'number' && Number.isFinite(msg.c)) send(ws, { type: 'time', c: msg.c, s: Date.now() });
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
          if (raw.length > MAX_SIGNAL_BYTES) {
            logBadMessage(ws, 'signal', new Error(`signal of ${raw.length} bytes is over the ${MAX_SIGNAL_BYTES}-byte limit`));
            return;
          }
          signalBytes = Math.min(SIGNAL_BYTES_BURST, signalBytes + ((now - signalRefilled) / 1000) * SIGNAL_BYTES_PER_SEC);
          signalRefilled = now;
          if (signalBytes < raw.length) {
            // Over the budget: not relayed (and not charged), the sender stays (see SIGNAL_BYTES_BURST).
            logBadMessage(ws, 'signal', new Error('over the signal byte budget, not relayed'));
            return;
          }
          signalBytes -= raw.length;
          const target = live.get(ws.room)?.get(msg.to);
          if (target && relayAllowed(ws, target.ws, raw.length, now)) send(target.ws, { type: 'signal', from: ws.id, data: msg.data });
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

  ws.on('close', () => {
    leave(ws);
    clearTimeout(ws.joinDeadline);
    for (const key of ws.keys) {
      const open = (socketsPerClient.get(key) || 1) - 1;
      if (open > 0) socketsPerClient.set(key, open);
      else socketsPerClient.delete(key);
    }
  });
  ws.on('error', () => leave(ws));
});

/** Fresh TURN credentials for the members whose last ones are older than ICE_REFRESH_MS (they are valid 12 h). */
function refreshIce() {
  if (!TURN_URLS.length || !process.env.TURN_SECRET) return; // nothing that expires: STUN, or static TURN credentials
  const now = Date.now();
  let servers; // one set per tick
  for (const members of live.values()) {
    for (const m of members.values()) {
      if (now - m.iceAt < ICE_REFRESH_MS) continue;
      servers ??= iceServers();
      send(m.ws, { type: 'ice', iceServers: servers });
      m.iceAt = now;
    }
  }
}

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
  adminGlobalLimiter.sweep();
  if (!adminGlobalLimiter.blocked(EVERYONE)) adminGlobalNoted = false;
  roomLimiter.sweep();
  lookupLimiter.sweep();
  driveMissLimiter.sweep();
  const now = Date.now();
  for (const [t, exp] of adminSessions) if (exp < now) adminSessions.delete(t);
  for (const [k, at] of revokedMembers) if (now - at > TOKEN_TTL_MS) revokedMembers.delete(k); // older tokens have expired
  refreshDriveTokens();
  refreshIce();
}, HEARTBEAT_MS);
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
