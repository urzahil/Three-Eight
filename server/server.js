// Three-Eight server.
//
// The server only does a few small things:
//   1. serves the static web app (and the admin page),
//   2. keeps the list of rooms and their (hashed) passwords,
//   3. relays WebRTC signaling messages (SDP offers/answers, ICE candidates)
//      between authenticated participants of the same room,
//   4. answers clock-sync pings so every browser agrees on a common clock.
//
// Audio, video, chat and movie-sync messages flow directly between browsers
// (WebRTC peer connections + data channels). No media ever touches the server.

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomStore, parseDriveFolder } = require('./store');

const PORT = parseInt(process.env.PORT || '4567', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const MAX_ROOM_SIZE = parseInt(process.env.MAX_ROOM_SIZE || '12', 10);
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
const MAX_MESSAGE_BYTES = 64 * 1024;
const GOOGLE_API_KEY = (process.env.GOOGLE_API_KEY || '').trim();
const ADMIN_SESSION_MS = 12 * 3600 * 1000;

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(12).toString('base64url');
  console.warn(`ADMIN_PASSWORD is not set. Generated a temporary admin password for this run: ${ADMIN_PASSWORD}`);
}

const store = new RoomStore(DATA_DIR);

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

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
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

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  return TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Simple sliding-window limiter for failed password attempts.
class FailLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.map = new Map();
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
  fail(key) {
    const now = Date.now();
    const e = this.map.get(key);
    if (!e || now - e.first > this.windowMs) this.map.set(key, { first: now, count: 1 });
    else e.count++;
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

// What room members need to browse the room's Google Drive folder, or null.
function driveInfo(r) {
  if (!r || !r.drive || !GOOGLE_API_KEY) return null;
  return { apiKey: GOOGLE_API_KEY, folderId: r.drive.folderId, resourceKey: r.drive.resourceKey || '' };
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

// ---- HTTP routing -----------------------------------------------------------------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // Public: does a room exist / need a password?
  if (parts[1] === 'rooms' && parts.length === 3 && req.method === 'GET') {
    const r = store.get(parts[2]);
    if (!r) return sendJson(res, 404, { error: 'Room not found' });
    return sendJson(res, 200, { name: r.name, passwordRequired: !!r.passwordHash });
  }

  if (parts[1] === 'config' && req.method === 'GET') {
    return sendJson(res, 200, { iceServers: iceServers(), maxRoomSize: MAX_ROOM_SIZE });
  }

  if (parts[1] !== 'admin') return sendJson(res, 404, { error: 'Not found' });

  // Admin API. State-changing requests must be JSON (blocks simple cross-site forms)
  // and the session cookie is SameSite=Strict.
  if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return sendJson(res, 415, { error: 'Expected application/json' });
  }

  if (parts[2] === 'login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (adminLimiter.blocked(ip)) return sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
    const body = await readJson(req);
    if (!safeEqual(body.password || '', ADMIN_PASSWORD)) {
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
      return sendJson(res, 200, { rooms, googleApiKey: GOOGLE_API_KEY });
    }
    if (!name && req.method === 'POST') {
      const body = await readJson(req);
      try {
        await store.create(String(body.name || '').trim(), String(body.password || ''));
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 201, { ok: true });
    }
    if (name && parts[4] === 'drive' && parts.length === 5 && req.method === 'PUT') {
      const body = await readJson(req);
      let drive;
      try {
        drive = parseDriveFolder(typeof body.link === 'string' ? body.link : '');
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      try {
        store.setDrive(name, drive);
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }
      const info = driveInfo(store.get(name));
      const members = roomMembers(name);
      if (members) for (const m of members.values()) send(m.ws, { type: 'drive', drive: info });
      return sendJson(res, 200, { ok: true, drive });
    }
    if (name && parts.length === 4 && req.method === 'PUT') {
      const body = await readJson(req);
      try {
        await store.setPassword(name, String(body.password || ''));
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      if (body.kick) kickRoom(name, 'kicked', 'The room password was changed. Please rejoin.');
      return sendJson(res, 200, { ok: true });
    }
    if (name && req.method === 'DELETE') {
      try {
        store.delete(name);
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }
      kickRoom(name, 'room-deleted', 'This room has been deleted.');
      return sendJson(res, 200, { ok: true });
    }
  }
  return sendJson(res, 404, { error: 'Not found' });
}

function handleHttp(req, res) {
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
      if (!res.headersSent) sendJson(res, 400, { error: err.message || 'Bad request' });
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

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Guest';
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
  const roomName = String(msg.room || '');
  const r = store.get(roomName);
  if (!r) {
    send(ws, { type: 'error', code: 'no-room', message: 'This room does not exist.' });
    return;
  }
  if (!ID_RE.test(msg.id || '')) {
    send(ws, { type: 'error', code: 'bad-request', message: 'Invalid participant id' });
    return;
  }
  if (roomLimiter.blocked(ws.ip)) {
    send(ws, { type: 'error', code: 'rate-limited', message: 'Too many wrong passwords. Try again in a few minutes.' });
    return;
  }
  const ok = await store.check(roomName, msg.password);
  if (!ok) {
    roomLimiter.fail(ws.ip);
    send(ws, { type: 'error', code: 'bad-password', message: 'Wrong room password.' });
    return;
  }
  if (ws.readyState !== ws.OPEN) return;

  const key = RoomStore.key(roomName);
  leave(ws);
  let members = live.get(key);
  if (!members) {
    members = new Map();
    live.set(key, members);
  }
  const existing = members.get(msg.id);
  if (!existing && members.size >= MAX_ROOM_SIZE) {
    send(ws, { type: 'error', code: 'room-full', message: `Room is full (max ${MAX_ROOM_SIZE}).` });
    return;
  }
  if (existing && existing.ws !== ws) {
    // Same participant reconnecting (e.g. after a network blip): replace the old socket.
    existing.ws.room = null;
    existing.ws.close(4000, 'replaced');
  }
  ws.room = key;
  ws.id = msg.id;
  const name = cleanName(msg.name);
  const peers = [...members.entries()].filter(([pid]) => pid !== msg.id).map(([pid, m]) => ({ id: pid, name: m.name }));
  members.set(msg.id, { ws, name });
  const welcome = { type: 'welcome', id: msg.id, room: r.name, peers };
  const drive = driveInfo(r);
  if (drive) welcome.drive = drive;
  send(ws, welcome);
  if (!existing) {
    for (const [pid, m] of members) if (pid !== msg.id) send(m.ws, { type: 'peer-joined', id: msg.id, name });
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.ip = clientIp(req);
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'time':
        // Clock sync: echo client timestamp with server time.
        send(ws, { type: 'time', c: msg.c, s: Date.now() });
        break;

      case 'join':
        handleJoin(ws, msg).catch((err) => console.error('join failed', err));
        break;

      case 'signal': {
        // Relay WebRTC signaling to one peer in the same room.
        if (!ws.room || typeof msg.to !== 'string') return;
        const target = live.get(ws.room)?.get(msg.to);
        if (target) send(target.ws, { type: 'signal', from: ws.id, data: msg.data });
        break;
      }

      case 'rename': {
        if (!ws.room) return;
        const members = live.get(ws.room);
        const me = members?.get(ws.id);
        if (me && me.ws === ws) me.name = cleanName(msg.name);
        break;
      }

      case 'leave':
        leave(ws);
        break;

      default:
        break;
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
