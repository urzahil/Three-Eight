// Server tests: admin API, room passwords, routing, signaling relay, and the Google Drive endpoints
// (against a fake Google, see fake-google.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const http = require('node:http');
const net = require('node:net');
const { RoomStore, parseDriveFolder } = require('../server/store');
const { limiterKey } = require('../server/ip');
const { startFakeGoogle } = require('./fake-google');

// Ports come from the OS (see freePort): a guessed number can already be taken, e.g. by an outgoing connection.
let PORT = 0;
let BASE = '';
let proc, dataDir, cookie = '', google, keyDir;
const extraProcs = [];

/** A port nobody is listening on right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitUp(base) {
  for (let i = 0; i < 150; i++) { // up to 15 s: a loaded CI machine starts slowly
    try {
      if ((await fetch(base + '/healthz')).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

/** Another server instance (own data dir), e.g. without a service account. Returns { base, log, stop }. */
async function spawnServer(env) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-x-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_PASSWORD: 'admin-pw-for-tests', DATA_DIR: dir, GOOGLE_SERVICE_ACCOUNT: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { log: '' };
  child.stdout.on('data', (d) => { out.log += d; });
  child.stderr.on('data', (d) => { out.log += d; });
  const base = `http://127.0.0.1:${port}`;
  await waitUp(base);
  const stop = () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); };
  extraProcs.push(stop);
  return { base, out, stop, dir, child };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-'));
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-key-'));
  google = await startFakeGoogle();
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_PASSWORD: 'admin-pw-for-tests', DATA_DIR: dataDir,
      GOOGLE_SERVICE_ACCOUNT: google.writeAccount(keyDir), GOOGLE_API_BASE: google.url, DRIVE_DEBUG: '1',
    },
    stdio: 'ignore',
  });
  await waitUp(BASE);
});

after(async () => {
  proc.kill();
  for (const stop of extraProcs) stop();
  await google.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(keyDir, { recursive: true, force: true });
});

const json = (method, p, body, headers = {}) => fetch(BASE + p, {
  method,
  headers: { 'Content-Type': 'application/json', cookie, ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function wsClient() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const queue = [];
  let waiter = null;
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    if (waiter) { const w = waiter; waiter = null; w(msg); } else queue.push(msg);
  });
  ws.next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => { waiter = r; }));
  ws.sendJson = (o) => ws.send(JSON.stringify(o));
  return new Promise((resolve) => ws.on('open', () => resolve(ws)));
}

test('admin endpoints require login', async () => {
  assert.strictEqual((await json('GET', '/api/admin/rooms')).status, 401);
  assert.strictEqual((await json('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  const res = await json('POST', '/api/admin/login', { password: 'admin-pw-for-tests' });
  assert.strictEqual(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
  assert.match(res.headers.get('set-cookie'), /HttpOnly/);
  assert.match(res.headers.get('set-cookie'), /SameSite=Strict/);
});

test('admin rejects non-JSON writes (CSRF guard)', async () => {
  const res = await fetch(BASE + '/api/admin/rooms', { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
  assert.strictEqual(res.status, 415);
});

test('create, list, validate rooms', async () => {
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'MovieNight', password: 'pw1' })).status, 201);
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'movienight', password: 'x' })).status, 400, 'duplicate (case-insensitive)');
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'admin' })).status, 400, 'reserved');
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'bad name!' })).status, 400, 'invalid chars');
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'open-room', password: '' })).status, 201);
  const { rooms } = await (await json('GET', '/api/admin/rooms')).json();
  assert.deepStrictEqual(rooms.map((r) => [r.name, r.hasPassword, r.drive]), [['MovieNight', true, null], ['open-room', false, null]]);
  const stored = fs.readFileSync(path.join(dataDir, 'rooms.json'), 'utf8');
  assert(!stored.includes('pw1'), 'password must not be stored in clear text');
  assert.match(stored, /scrypt\$/);
});

test('public room lookup and routing', async () => {
  const r = await (await fetch(BASE + '/api/rooms/movienight')).json();
  assert.deepStrictEqual(r, { name: 'MovieNight', passwordRequired: true });
  assert.strictEqual((await fetch(BASE + '/api/rooms/nope')).status, 404);
  const page = await fetch(BASE + '/MovieNight');
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /<title>Three-Eight<\/title>/);
  assert.match(await (await fetch(BASE + '/admin')).text(), /admin/i);
  assert.strictEqual((await fetch(BASE + '/assets/../server/store.js')).status, 404);
  assert.notStrictEqual((await fetch(BASE + '/assets/%2e%2e/%2e%2e/package.json')).status, 200);
  const cfg = await (await fetch(BASE + '/api/config')).json();
  assert(Array.isArray(cfg.iceServers));
});

test('installable app: manifest, service worker and icons', async () => {
  const man = await fetch(BASE + '/manifest.webmanifest');
  assert.strictEqual(man.status, 200);
  assert.match(man.headers.get('content-type'), /^application\/manifest\+json/);
  const m = await man.json();
  assert.strictEqual(m.start_url, '/');
  assert.strictEqual(m.display, 'standalone');
  for (const icon of m.icons) assert.strictEqual((await fetch(BASE + icon.src)).status, 200, icon.src);
  assert(m.icons.some((i) => i.sizes === '512x512' && i.type === 'image/png'));
  const sw = await fetch(BASE + '/sw.js');
  assert.strictEqual(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /^text\/javascript/);
  assert.match(await (await fetch(BASE + '/')).text(), /<link rel="manifest" href="\/manifest.webmanifest">/);
});

test('joining requires the right password; signaling is relayed', async () => {
  const a = await wsClient();
  a.sendJson({ type: 'join', room: 'movienight', id: 'aaaaaaaa1', name: 'Alice', password: 'wrong' });
  assert.strictEqual((await a.next()).code, 'bad-password');
  a.sendJson({ type: 'join', room: 'nope', id: 'aaaaaaaa1', name: 'Alice' });
  assert.strictEqual((await a.next()).code, 'no-room');
  a.sendJson({ type: 'join', room: 'movienight', id: 'aaaaaaaa1', name: 'Alice', password: 'pw1' });
  const w = await a.next();
  assert.strictEqual(w.type, 'welcome');
  assert.deepStrictEqual(w.peers, []);

  const b = await wsClient();
  b.sendJson({ type: 'join', room: 'MOVIENIGHT', id: 'bbbbbbbb2', name: 'Bob', password: 'pw1' });
  const wb = await b.next();
  assert.deepStrictEqual(wb.peers, [{ id: 'aaaaaaaa1', name: 'Alice' }]);
  assert.deepStrictEqual(await a.next(), { type: 'peer-joined', id: 'bbbbbbbb2', name: 'Bob' });

  b.sendJson({ type: 'signal', to: 'aaaaaaaa1', data: { hello: 1 } });
  assert.deepStrictEqual(await a.next(), { type: 'signal', from: 'bbbbbbbb2', data: { hello: 1 } });

  // An outsider who isn't in the room can't inject signals.
  const c = await wsClient();
  c.sendJson({ type: 'signal', to: 'aaaaaaaa1', data: { evil: 1 } });

  // Clock sync
  b.sendJson({ type: 'time', c: 123 });
  const t = await b.next();
  assert.strictEqual(t.c, 123);
  assert(Math.abs(t.s - Date.now()) < 5000);

  const { rooms } = await (await json('GET', '/api/admin/rooms')).json();
  assert.deepStrictEqual(rooms.find((r) => r.name === 'MovieNight').online.sort(), ['Alice', 'Bob']);

  b.close();
  assert.deepStrictEqual(await a.next(), { type: 'peer-left', id: 'bbbbbbbb2' });

  // Deleting the room disconnects members.
  assert.strictEqual((await json('DELETE', '/api/admin/rooms/movienight', {})).status, 200);
  assert.strictEqual((await a.next()).code, 'room-deleted');
  a.close();
  c.close();
});

test('password change', async () => {
  assert.strictEqual((await json('PUT', '/api/admin/rooms/open-room', { password: 'new' })).status, 200);
  const r = await (await fetch(BASE + '/api/rooms/open-room')).json();
  assert.strictEqual(r.passwordRequired, true);
});


// ---- Google Drive ------------------------------------------------------------------------------
const FID = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123';

test('parseDriveFolder accepts folder links and IDs, and ignores resource keys', () => {
  const ok = { folderId: FID };
  assert.deepStrictEqual(parseDriveFolder(`https://drive.google.com/drive/folders/${FID}`), ok);
  assert.deepStrictEqual(parseDriveFolder(`  https://drive.google.com/drive/folders/${FID}?usp=sharing `), ok);
  assert.deepStrictEqual(parseDriveFolder(`https://drive.google.com/drive/u/0/folders/${FID}`), ok);
  assert.deepStrictEqual(parseDriveFolder(`https://drive.google.com/drive/folders/${FID}?usp=sharing&resourcekey=0-abc_DEF`), ok);
  assert.deepStrictEqual(parseDriveFolder(`https://drive.google.com/open?id=${FID}`), ok);
  assert.deepStrictEqual(parseDriveFolder(`https://drive.google.com/open?id=${FID}&resourcekey=0-k`), ok);
  assert.deepStrictEqual(parseDriveFolder(FID), ok);
  assert.strictEqual(parseDriveFolder(''), null);
  assert.strictEqual(parseDriveFolder('   '), null);
});

test('parseDriveFolder rejects everything else', () => {
  for (const bad of [
    `https://drive.google.com/file/d/${FID}/view`,
    `https://example.com/drive/folders/${FID}`,
    'https://drive.google.com/drive/my-drive',
    'https://drive.google.com/drive/folders/short',
    'short', 'has spaces in it 12345', `${FID}/extra`, 'x'.repeat(201),
  ]) assert.throws(() => parseDriveFolder(bad), /./, bad);
  assert.throws(() => parseDriveFolder(`https://drive.google.com/file/d/${FID}/view`), /file/);
});

// The fake Drive: room A's folder (with a subfolder), room B's folder, and a folder nobody attached.
const D = {
  rootA: 'ROOT_A_FOLDER_01', subA: 'SUB_A_FOLDER_002', rootB: 'ROOT_B_FOLDER_03', stray: 'STRAY_FOLDER_004',
  movie: 'MOVIE_FILE_00005', movie2: 'MOVIE_FILE_00006', inSub: 'SUB_MOVIE_000007', srt: 'SUBTITLE_FILE_08', notes: 'NOTES_FILE_00009',
  movieB: 'MOVIE_B_FILE_010', strayMovie: 'STRAY_MOVIE_0011', quota: 'QUOTA_FILE_00012', flaky: 'FLAKY_FILE_00013', slow: 'SLOW_FILE_000014', fresh: 'FRESH_FILE_00015',
};
const bytes = (n) => crypto.randomBytes(n);
const MiB = 1024 * 1024;
const DATA = { movie: bytes(3 * MiB + 12345), movie2: bytes(2 * MiB + 777), inSub: bytes(5000), srt: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi\n'), movieB: bytes(4000), strayMovie: bytes(4000), quota: bytes(2000), flaky: bytes(2000), slow: bytes(3 * MiB), fresh: bytes(2 * MiB) };
let tokA, tokB; // room tokens from the welcome messages

const api = (p, token, extra = {}) => fetch(BASE + p, { headers: token ? { Authorization: `Bearer ${token}` } : {}, ...extra });
const files = (room, id) => `/api/rooms/${room}/drive/files/${id}`;
const mediaCalls = (id) => google.entries('media', id);

/** The secret a test client sends with this id: the same id always comes with the same secret, like one browser tab. */
const secretOf = (id) => `${id}-test-secret`;

async function join(room, password, id, name = 'Tester') {
  const ws = await wsClient();
  ws.sendJson({ type: 'join', room, id, name, password, secret: secretOf(id) });
  const welcome = await ws.next();
  return { ws, welcome };
}

test('drive: set up the fake Google, two rooms and their folders', async () => {
  google.addFolder(D.rootA, 'Room A movies');
  google.addFolder(D.subA, 'Season 1', D.rootA);
  google.addFolder(D.rootB, 'Room B movies');
  google.addFolder(D.stray, 'Somebody else\'s folder');
  google.addFile(D.movie, 'film.mkv', D.rootA, DATA.movie, 'video/x-matroska', 6000);
  google.addFile(D.movie2, 'film2.mp4', D.rootA, DATA.movie2, 'video/mp4');
  google.addFile(D.srt, 'film.srt', D.rootA, DATA.srt, 'application/x-subrip');
  google.addFile(D.notes, 'notes.txt', D.rootA, Buffer.from('hello'), 'text/plain');
  google.addFile(D.inSub, 'episode.mp4', D.subA, DATA.inSub, 'video/mp4');
  google.addFile(D.quota, 'quota.mp4', D.rootA, DATA.quota, 'video/mp4');
  google.addFile(D.flaky, 'flaky.mp4', D.rootA, DATA.flaky, 'video/mp4');
  google.addFile(D.slow, 'slow.mp4', D.rootA, DATA.slow, 'video/mp4');
  google.addFile(D.fresh, 'fresh.mp4', D.rootA, DATA.fresh, 'video/mp4');
  google.addFile(D.movieB, 'b.mp4', D.rootB, DATA.movieB, 'video/mp4');
  google.addFile(D.strayMovie, 'stray.mp4', D.stray, DATA.strayMovie, 'video/mp4');
  google.mode.pageLimit = 4; // the room folder's listing needs several pages

  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'drive-a', password: 'pa' })).status, 201);
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'drive-b', password: 'pb' })).status, 201);
  const url = (room) => `/api/admin/rooms/${room}/drive`;
  assert.strictEqual((await json('PUT', url('drive-a'), { link: FID }, { cookie: '' })).status, 401);
  assert.strictEqual((await json('PUT', '/api/admin/rooms/nope/drive', { link: FID })).status, 404);
  assert.strictEqual((await json('PUT', url('drive-a'), { link: 'https://drive.google.com/file/d/' + FID })).status, 400);
  assert.strictEqual((await json('PUT', url('drive-a'), { link: 'nonsense' })).status, 400);

  const a = await json('PUT', url('drive-a'), { link: `https://drive.google.com/drive/folders/${D.rootA}?resourcekey=0-ignored` });
  assert.strictEqual(a.status, 200);
  assert.deepStrictEqual(await a.json(), { ok: true, drive: { folderId: D.rootA }, check: { name: 'Room A movies', items: 8 } });
  assert.strictEqual((await json('PUT', url('drive-b'), { link: D.rootB })).status, 200);

  const { rooms, serviceAccount } = await (await json('GET', '/api/admin/rooms')).json();
  assert.strictEqual(serviceAccount, google.email);
  assert.deepStrictEqual(rooms.find((r) => r.name === 'drive-a').drive, { folderId: D.rootA });
  assert(!JSON.stringify(rooms).includes('resourceKey'));
});

test('drive: the welcome message carries { token, folder } after the password check, and only then', async () => {
  const bad = await join('drive-a', 'wrong', 'eeeeeeee1');
  assert.strictEqual(bad.welcome.code, 'bad-password');
  assert(!JSON.stringify(bad.welcome).includes(D.rootA));

  const a = await join('drive-a', 'pa', 'eeeeeeee2', 'Alice');
  assert.strictEqual(a.welcome.type, 'welcome');
  assert.deepStrictEqual(Object.keys(a.welcome.drive).sort(), ['folder', 'token']);
  assert.strictEqual(a.welcome.drive.folder, D.rootA);
  tokA = a.welcome.drive.token;
  const [body, sig] = tokA.split('.');
  assert(/^[A-Za-z0-9_-]+$/.test(body) && /^[A-Za-z0-9_-]{43}$/.test(sig), 'base64url(payload).base64url(HMAC-SHA256)');
  const claims = JSON.parse(Buffer.from(body, 'base64url'));
  assert.deepStrictEqual(Object.keys(claims).sort(), ['e', 'i', 'm', 'r', 'v']);
  assert.strictEqual(claims.r, 'drive-a');
  assert.strictEqual(claims.m, 'eeeeeeee2', 'issued to this member');
  assert(Math.abs(claims.e - (Date.now() + 3600 * 1000)) < 60000, 'expires in 1 hour');
  assert(Math.abs(claims.i - Date.now()) < 60000);

  const b = await join('drive-b', 'pb', 'eeeeeeee3', 'Bob');
  tokB = b.welcome.drive.token;
  assert.notStrictEqual(tokA, tokB);

  // A reconnect of the same participant gets a fresh, working token.
  const again = await join('drive-a', 'pa', 'eeeeeeee2', 'Alice');
  assert(again.welcome.drive.token);
  assert.strictEqual((await api(`/api/rooms/drive-a/drive/folders/root`, again.welcome.drive.token)).status, 200);

  // Public info and config never expose the folder.
  const pub = await (await fetch(BASE + '/api/rooms/drive-a')).json();
  assert.deepStrictEqual(pub, { name: 'drive-a', passwordRequired: true });
  assert(!JSON.stringify(await (await fetch(BASE + '/api/config')).json()).includes(D.rootA));
  for (const c of [a, b, again]) c.ws.close();
});

test('drive: a token is required, and it only works for its own room', async () => {
  const folders = '/api/rooms/drive-a/drive/folders/root';
  assert.strictEqual((await api(folders)).status, 401);
  assert.strictEqual((await api(files('drive-a', D.movie))).status, 401);
  assert.strictEqual((await api(folders, 'garbage')).status, 401);
  assert.strictEqual((await api(folders, 'a.b')).status, 401);
  const [body, sig] = tokA.split('.');
  const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  assert.strictEqual((await api(folders, `${body}.${flipped}`)).status, 401, 'tampered signature');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), r: 'drive-b' })).toString('base64url');
  assert.strictEqual((await api(folders, `${forged}.${sig}`)).status, 401, 'payload changed');
  const res = await api(folders);
  assert.match((await res.json()).error, /./);

  assert.strictEqual((await api(folders, tokA)).status, 200);
  assert.strictEqual((await fetch(`${BASE}${folders}?t=${encodeURIComponent(tokA)}`)).status, 401, 'the token in the URL is not accepted any more');
  // Room A's token on room B's URLs, and the other way round.
  assert.strictEqual((await api('/api/rooms/drive-b/drive/folders/root', tokA)).status, 401);
  assert.strictEqual((await api(files('drive-b', D.movieB), tokA)).status, 401);
  assert.strictEqual((await api(files('drive-a', D.movie), tokB)).status, 401);
  assert.strictEqual((await api('/api/rooms/drive-b/drive/folders/root', tokB)).status, 200);
  // Other methods
  assert.strictEqual((await api(folders, tokA, { method: 'POST' })).status, 405);
  assert.strictEqual((await api('/api/rooms/drive-a/drive/nothing/x1234567890', tokA)).status, 404);
});

/** The "name=value" pair of a Set-Cookie header, to send back as a Cookie header. */
const cookiePair = (res) => res.headers.get('set-cookie').split(';')[0];

test('drive: POST .../drive/session sets a per-room, HttpOnly, SameSite=Strict cookie that expires with the token', async () => {
  const url = '/api/rooms/drive-a/drive/session';
  const res = await api(url, tokA, { method: 'POST' });
  assert.strictEqual(res.status, 204);
  assert.strictEqual(await res.text(), '');
  const set = res.headers.get('set-cookie');
  const id = crypto.createHash('sha256').update('drive-a').digest('base64url').slice(0, 16);
  assert(set.startsWith(`t8d_${id}=${tokA};`), set);
  assert.match(set, /; Path=\/api\/rooms\/(;|$)/);
  assert.match(set, /; HttpOnly/);
  assert.match(set, /; SameSite=Strict/);
  assert.doesNotMatch(set, /Secure/, 'plain http');
  const maxAge = Number(/Max-Age=(\d+)/.exec(set)[1]);
  assert(maxAge > 0.9 * 3600 && maxAge <= 3600, `Max-Age ${maxAge}`); // the token lives 1 h
  assert.strictEqual(res.headers.get('cache-control'), 'private, no-store');
  // The room's name in another case: the same room, the same cookie.
  assert.strictEqual(cookiePair(await api('/api/rooms/Drive-A/drive/session', tokA, { method: 'POST' })), cookiePair(res));
  // Behind a TLS-terminating proxy the cookie is Secure too (same rule as the admin cookie): see the TRUST_PROXY test.
  // Refused: no token, a wrong token, a token of another room, other methods.
  assert.strictEqual((await api(url, undefined, { method: 'POST' })).status, 401);
  assert.strictEqual((await api(url, 'garbage', { method: 'POST' })).status, 401);
  assert.strictEqual((await api(url, tokB, { method: 'POST' })).status, 401);
  assert.strictEqual((await fetch(BASE + url + `?t=${encodeURIComponent(tokA)}`, { method: 'POST' })).status, 401);
  assert.strictEqual((await cookieReq(url, cookiePair(res), { method: 'POST' })).status, 401, 'the cookie cannot renew itself');
  for (const method of ['GET', 'HEAD', 'PUT']) {
    const r = await api(url, tokA, { method });
    assert.strictEqual(r.status, 405, method);
    assert.strictEqual(r.headers.get('allow'), 'POST, DELETE');
  }
  assert.strictEqual((await api(url, tokA, { method: 'POST', headers: { Authorization: `Bearer ${tokA}`, 'Content-Length': '5000' }, body: 'x'.repeat(5000) })).status, 413);
});

test('drive: DELETE .../drive/session clears the room cookie, without a token and for any room', async () => {
  const id = (room) => crypto.createHash('sha256').update(room).digest('base64url').slice(0, 16);
  const url = '/api/rooms/drive-a/drive/session';
  const res = await fetch(BASE + url, { method: 'DELETE' }); // no token: clearing one's own cookie grants nothing
  assert.strictEqual(res.status, 204);
  assert.strictEqual(await res.text(), '');
  assert.strictEqual(res.headers.get('set-cookie'), `t8d_${id('drive-a')}=; Path=/api/rooms/; HttpOnly; SameSite=Strict; Max-Age=0`);
  assert.strictEqual(res.headers.get('cache-control'), 'private, no-store');
  // With a token it is the same; the room's name in another case names the same cookie.
  assert.strictEqual((await api(url, tokA, { method: 'DELETE' })).status, 204);
  assert.strictEqual((await fetch(BASE + '/api/rooms/Drive-A/drive/session', { method: 'DELETE' })).headers.get('set-cookie'), res.headers.get('set-cookie'));
  // A room that does not exist (any more) can still be cleared.
  const gone = await fetch(BASE + '/api/rooms/no-such-room/drive/session', { method: 'DELETE' });
  assert.strictEqual(gone.status, 204);
  assert.match(gone.headers.get('set-cookie'), new RegExp(`^t8d_${id('no-such-room')}=; .*Max-Age=0`));
  assert.strictEqual((await fetch(BASE + url, { method: 'DELETE', headers: { 'Content-Length': '5000' }, body: 'x'.repeat(5000) })).status, 413);
});

const cookieReq = (p, cookieHeader, extra = {}) => fetch(BASE + p, { ...extra, headers: { Cookie: cookieHeader, ...(extra.headers || {}) } });

test('drive: files and folders open with the room cookie and no header; a cookie opens only its own room', async () => {
  const ck = cookiePair(await api('/api/rooms/drive-a/drive/session', tokA, { method: 'POST' }));
  const ckB = cookiePair(await api('/api/rooms/drive-b/drive/session', tokB, { method: 'POST' }));
  assert.notStrictEqual(ck.split('=')[0], ckB.split('=')[0], 'one cookie per room');
  const r = await cookieReq(files('drive-a', D.movie), ck, { headers: { Range: 'bytes=10-19' } });
  assert.strictEqual(r.status, 206);
  assert.deepStrictEqual(Buffer.from(await r.arrayBuffer()), DATA.movie.subarray(10, 20));
  assert.strictEqual((await cookieReq('/api/rooms/drive-a/drive/folders/root', ck)).status, 200);
  assert.strictEqual((await cookieReq(files('drive-a', D.movie), ck, { method: 'HEAD' })).status, 200);
  // A cookie of room A on room B's URLs (the browser sends every cookie under /api/rooms/), alone or among others.
  assert.strictEqual((await cookieReq(files('drive-b', D.movieB), ck)).status, 401);
  assert.strictEqual((await cookieReq('/api/rooms/drive-b/drive/folders/root', ck)).status, 401);
  assert.strictEqual((await cookieReq('/api/rooms/drive-b/drive/folders/root', `${ck}; ${ckB}`)).status, 200);
  assert.strictEqual((await cookieReq('/api/rooms/drive-a/drive/folders/root', `x=1; ${ckB}; ${ck}; y=2`)).status, 200);
  // Room A's token under room B's cookie name does not work either.
  assert.strictEqual((await cookieReq('/api/rooms/drive-b/drive/folders/root', `${ckB.split('=')[0]}=${tokA}`)).status, 401);
  // Bearer comes first: a bad header is not rescued by a good cookie.
  assert.strictEqual((await cookieReq('/api/rooms/drive-a/drive/folders/root', ck, { headers: { Authorization: 'Bearer nope' } })).status, 401);
  assert.strictEqual((await cookieReq('/api/rooms/drive-a/drive/folders/root', ck, { headers: { Authorization: `Bearer ${tokA}` } })).status, 200);
  // Defensive parsing: junk and an over-long header are just "no cookie".
  assert.strictEqual((await cookieReq('/api/rooms/drive-a/drive/folders/root', '%%;;=;===')).status, 401);
  assert.strictEqual((await cookieReq('/api/rooms/drive-a/drive/folders/root', `pad=${'x'.repeat(9000)}; ${ck}`)).status, 401);
});

test('drive: folders are listed with kinds, sizes and durations; only the room folder tree is reachable', async () => {
  const root = await (await api('/api/rooms/drive-a/drive/folders/root', tokA)).json();
  assert.strictEqual(root.id, D.rootA);
  assert.strictEqual(root.name, 'Room A movies');
  assert.deepStrictEqual(root.items.map((f) => f.name), ['Season 1', 'film.mkv', 'film.srt', 'film2.mp4', 'flaky.mp4', 'fresh.mp4', 'quota.mp4', 'slow.mp4'], 'folders first, then natural order; notes.txt skipped; all pages merged');
  assert.deepStrictEqual(root.items.find((f) => f.name === 'film.mkv'), { id: D.movie, name: 'film.mkv', kind: 'video', size: DATA.movie.length, durationMs: 6000 });
  assert.strictEqual(root.items.find((f) => f.name === 'film.srt').kind, 'subtitle');
  assert.strictEqual(root.items[0].kind, 'folder');

  const sub = await api(`/api/rooms/drive-a/drive/folders/${D.subA}`, tokA);
  assert.strictEqual(sub.status, 200);
  assert.deepStrictEqual((await sub.json()).items.map((f) => f.name), ['episode.mp4']);
  assert.strictEqual((await api(`/api/rooms/drive-a/drive/folders/${D.rootA}`, tokA)).status, 200, 'the root by its ID');

  // A file in a subfolder works; things outside the folder do not, whatever the service account can read.
  assert.deepStrictEqual(Buffer.from(await (await api(files('drive-a', D.inSub), tokA)).arrayBuffer()), DATA.inSub);
  for (const [what, p] of [
    ['a folder of another room', `/api/rooms/drive-a/drive/folders/${D.rootB}`],
    ['an unattached folder', `/api/rooms/drive-a/drive/folders/${D.stray}`],
    ['a file of another room', files('drive-a', D.movieB)],
    ['an unattached file', files('drive-a', D.strayMovie)],
    ['a file that does not exist', files('drive-a', 'DOES_NOT_EXIST_01')],
    ['a document in the folder', files('drive-a', D.notes)],
    ['a folder asked for as a file', files('drive-a', D.subA)],
    ['a file asked for as a folder', `/api/rooms/drive-a/drive/folders/${D.movie}`],
    ['a malformed id', files('drive-a', 'x')],
    ['root as a file', files('drive-a', 'root')],
  ]) {
    const res = await api(p, tokA);
    assert.strictEqual(res.status, 404, what);
    assert.match((await res.json()).error, /./);
  }
  // Ask again: negative answers are cached, so Google is not asked once more about the stray file.
  const before = google.log.length;
  assert.strictEqual((await api(files('drive-a', D.strayMovie), tokA)).status, 404);
  assert.strictEqual(google.log.length, before, 'cached negative result');
});

test('drive: file responses follow range semantics', async () => {
  const data = DATA.movie;
  const f = files('drive-a', D.movie);
  const get = (range, token = tokA) => api(f, token, { headers: { Authorization: `Bearer ${token}`, ...(range ? { Range: range } : {}) } });
  const expectSlice = async (range, a, b) => {
    const res = await get(range);
    assert.strictEqual(res.status, 206, range);
    assert.strictEqual(res.headers.get('content-range'), `bytes ${a}-${b}/${data.length}`);
    assert.strictEqual(res.headers.get('content-length'), String(b - a + 1));
    assert.strictEqual(res.headers.get('accept-ranges'), 'bytes');
    assert.strictEqual(res.headers.get('content-type'), 'video/x-matroska');
    assert.strictEqual(res.headers.get('cache-control'), 'private, no-store');
    assert(Buffer.from(await res.arrayBuffer()).equals(data.subarray(a, b + 1)), `${range}: body is the slice`);
  };
  await expectSlice('bytes=0-99', 0, 99);
  await expectSlice(`bytes=${MiB - 10}-${MiB + 20}`, MiB - 10, MiB + 20); // across a block boundary
  await expectSlice(`bytes=${2 * MiB - 1}-${2 * MiB}`, 2 * MiB - 1, 2 * MiB);
  await expectSlice(`bytes=${data.length - 1000}-`, data.length - 1000, data.length - 1);
  await expectSlice('bytes=-500', data.length - 500, data.length - 1);
  await expectSlice(`bytes=100-${data.length + 5000}`, 100, data.length - 1); // clamped
  await expectSlice(`bytes=${MiB / 2}-${3 * MiB}`, MiB / 2, 3 * MiB); // several blocks

  // Invalid ranges
  for (const range of [`bytes=${data.length}-`, `bytes=${data.length + 99}-${data.length + 200}`, 'bytes=5-1', 'bytes=abc', 'bytes=-', 'bytes=-0', 'bytes=0-1,5-6']) {
    const res = await get(range);
    assert.strictEqual(res.status, 416, range);
    assert.strictEqual(res.headers.get('content-range'), `bytes */${data.length}`);
    await res.arrayBuffer();
  }

  // HEAD: headers only
  const head = await api(f, tokA, { method: 'HEAD' });
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.headers.get('content-length'), String(data.length));
  assert.strictEqual(head.headers.get('accept-ranges'), 'bytes');
  assert.strictEqual((await head.arrayBuffer()).byteLength, 0);
  const headRange = await api(f, tokA, { method: 'HEAD', headers: { Authorization: `Bearer ${tokA}`, Range: 'bytes=10-19' } });
  assert.strictEqual(headRange.status, 206);
  assert.strictEqual(headRange.headers.get('content-length'), '10');
  assert.strictEqual((await api(f, undefined, { method: 'HEAD' })).status, 401);

  // No Range: the whole file, streamed
  const whole = await get(null);
  assert.strictEqual(whole.status, 200);
  assert.strictEqual(whole.headers.get('content-length'), String(data.length));
  assert(Buffer.from(await whole.arrayBuffer()).equals(data), 'whole file');
  // ... and never a page of ours: a sandboxed, nosniff download
  assert.strictEqual(whole.headers.get('x-content-type-options'), 'nosniff');
  assert.match(whole.headers.get('content-security-policy'), /sandbox/);
  // A subtitle file is not served under its own content type
  const srt = await api(files('drive-a', D.srt), tokA);
  assert.strictEqual(srt.headers.get('content-type'), 'application/octet-stream');
  assert(Buffer.from(await srt.arrayBuffer()).equals(DATA.srt));
});

test('drive: concurrent identical range requests cost one upstream fetch (then the cache serves them)', async () => {
  google.mode.slowMs = 300;
  try {
    const f = files('drive-a', D.movie2);
    const get = () => api(f, tokA, { headers: { Authorization: `Bearer ${tokA}`, Range: `bytes=${MiB + 100}-${MiB + 5099}` } }).then((r) => r.arrayBuffer());
    const [x, y, z] = await Promise.all([get(), get(), get()]);
    for (const body of [x, y, z]) assert(Buffer.from(body).equals(DATA.movie2.subarray(MiB + 100, MiB + 5100)));
    const calls = mediaCalls(D.movie2);
    assert.strictEqual(calls.length, 1, `one upstream request, got ${JSON.stringify(calls.map((c) => c.range))}`);
    assert.deepStrictEqual(calls[0].range, [MiB, 2 * MiB - 1], 'whole 1 MiB block');
    await get();
    assert.strictEqual(mediaCalls(D.movie2).length, 1, 'now served from the cache');
  } finally {
    google.mode.slowMs = 0;
  }
});

test('drive: a long read is fetched in runs of at most 8 MiB, each byte once, and later reads hit the cache', async () => {
  const before = mediaCalls(D.movie2).length;
  const res = await api(files('drive-a', D.movie2), tokA);
  assert(Buffer.from(await res.arrayBuffer()).equals(DATA.movie2));
  const calls = mediaCalls(D.movie2).slice(before);
  const total = calls.reduce((n, c) => n + (c.end ?? DATA.movie2.length - 1) - c.range[0] + 1, 0);
  assert(total <= DATA.movie2.length - MiB, 'the block fetched earlier is not fetched again');
  assert(calls.every((c) => c.range[0] % MiB === 0 && (c.end - c.range[0] + 1) <= 8 * MiB));
  const after = mediaCalls(D.movie2).length;
  await (await api(files('drive-a', D.movie2), tokA)).arrayBuffer();
  assert.strictEqual(mediaCalls(D.movie2).length, after, 'second pass costs nothing');
});

test('drive: a client that goes away stops the upstream request', async () => {
  google.mode.slowMs = 600;
  try {
    const ctrl = new AbortController();
    const p = api(files('drive-a', D.slow), tokA, { signal: ctrl.signal, headers: { Authorization: `Bearer ${tokA}`, Range: 'bytes=0-1000' } }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    ctrl.abort();
    await p;
    await new Promise((r) => setTimeout(r, 900));
    const calls = mediaCalls(D.slow);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].aborted, true, 'the upstream request was cancelled');
  } finally {
    google.mode.slowMs = 0;
  }
});

test('drive: the access token is reused, refreshed when it expires, and renewed after a 401', async () => {
  assert.strictEqual(google.entries('token').length, 1, 'one sign-in served everything so far');
  assert(google.entries('token').every((t) => t.ok));
  assert(new Set(google.log.filter((e) => e.bearer).map((e) => e.bearer)).size === 1, 'one access token');

  // Google revokes it: the next call gets a 401, signs in again and retries.
  google.revokeTokens();
  google.mode.tokenTtl = 62; // the new one is good for 62 s, and renewed 60 s before the end
  const fresh = files('drive-a', D.fresh);
  const r1 = await api(fresh, tokA, { headers: { Authorization: `Bearer ${tokA}`, Range: 'bytes=0-9' } });
  assert.strictEqual(r1.status, 206);
  assert(Buffer.from(await r1.arrayBuffer()).equals(DATA.fresh.subarray(0, 10)));
  assert.strictEqual(google.entries('token').length, 2);
  const used1 = mediaCalls(D.fresh).at(-1).bearer;

  await new Promise((r) => setTimeout(r, 2300));
  const r2 = await api(fresh, tokA, { headers: { Authorization: `Bearer ${tokA}`, Range: `bytes=${MiB}-${MiB + 9}` } });
  assert.strictEqual(r2.status, 206);
  assert(Buffer.from(await r2.arrayBuffer()).equals(DATA.fresh.subarray(MiB, MiB + 10)));
  assert.strictEqual(google.entries('token').length, 3, 'signed in again before the old token ran out');
  assert.notStrictEqual(mediaCalls(D.fresh).at(-1).bearer, used1);
  google.mode.tokenTtl = 3600;
});

test('drive: Google errors become readable messages; transient ones are retried', async () => {
  // download quota: 503 with the reason, not retried
  google.mode.quotaIds.add(D.quota);
  const q = await api(files('drive-a', D.quota), tokA, { headers: { Authorization: `Bearer ${tokA}`, Range: 'bytes=0-9' } });
  assert.strictEqual(q.status, 503);
  const qb = await q.json();
  assert.match(qb.error, /temporarily blocked downloads/);
  assert.strictEqual(qb.permanent, true);
  assert.strictEqual(mediaCalls(D.quota).length, 1, 'no retries for a quota error');
  assert(!JSON.stringify(qb).includes('ya29'), 'no access token in errors');

  // two 500s, then it works
  google.mode.failMedia = 2;
  const ok = await api(files('drive-a', D.flaky), tokA, { headers: { Authorization: `Bearer ${tokA}`, Range: 'bytes=0-9' } });
  assert.strictEqual(ok.status, 206);
  assert(Buffer.from(await ok.arrayBuffer()).equals(DATA.flaky.subarray(0, 10)));
  assert.deepStrictEqual(mediaCalls(D.flaky).map((c) => c.status), [500, 500, 206]);

  // Google keeps failing: 502 after the retries
  google.mode.failMedia = 100;
  const bad2 = await api(files('drive-a', D.slow), tokA, { headers: { Authorization: `Bearer ${tokA}`, Range: `bytes=${2 * MiB}-${2 * MiB + 9}` } });
  google.mode.failMedia = 0;
  assert.strictEqual(bad2.status, 502);
  assert.match((await bad2.json()).error, /Google Drive had a problem/);
  assert.strictEqual(mediaCalls(D.slow).filter((c) => c.status === 500).length, 4, 'initial try + 3 retries');
});

test('drive: a folder the service account cannot read gives a clear message', async () => {
  const r = await json('PUT', '/api/admin/rooms/drive-b/drive', { link: 'NOT_SHARED_FOLDER1' });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.match(body.check.error, new RegExp(`isn't shared with the service account ${google.email.replace(/\./g, '\\.')}`));
  // a file instead of a folder
  const f = await json('PUT', '/api/admin/rooms/drive-b/drive', { link: D.movie });
  assert.match((await f.json()).check.error, /file, not a folder/);
  // back to the real one
  const ok = await json('PUT', '/api/admin/rooms/drive-b/drive', { link: D.rootB });
  assert.deepStrictEqual((await ok.json()).check, { name: 'Room B movies', items: 1 });
});

test('drive: changing the folder or the password invalidates old tokens and pushes new ones', async () => {
  // Folder change (drive-b): the old token stops working, members get a new one.
  const b = await join('drive-b', 'pb', 'ffffffff1', 'Bob');
  const old = b.welcome.drive.token;
  assert.strictEqual((await api('/api/rooms/drive-b/drive/folders/root', old)).status, 200);
  const put = await json('PUT', '/api/admin/rooms/drive-b/drive', { link: D.subA });
  assert.strictEqual(put.status, 200);
  const push = await b.ws.next();
  assert.strictEqual(push.type, 'drive');
  assert.strictEqual(push.drive.folder, D.subA);
  assert.strictEqual((await api('/api/rooms/drive-b/drive/folders/root', old)).status, 401, 'old token, new folder');
  const res = await api('/api/rooms/drive-b/drive/folders/root', push.drive.token);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).items.map((x) => x.name), ['episode.mp4']);
  assert.strictEqual((await api(files('drive-b', D.movieB), push.drive.token)).status, 404, 'the old folder is not reachable any more');

  // Removing the folder: members are told, nothing works.
  assert.deepStrictEqual(await (await json('PUT', '/api/admin/rooms/drive-b/drive', { link: '' })).json(), { ok: true, drive: null });
  assert.deepStrictEqual(await b.ws.next(), { type: 'drive', drive: null });
  assert.strictEqual((await api('/api/rooms/drive-b/drive/folders/root', push.drive.token)).status, 401);
  b.ws.close();

  // Password change (drive-a), without kicking: old token dead, members get a new one.
  const a = await join('drive-a', 'pa', 'ffffffff2', 'Alice');
  const oldA = a.welcome.drive.token;
  assert.strictEqual((await api('/api/rooms/drive-a/drive/folders/root', oldA)).status, 200);
  assert.strictEqual((await json('PUT', '/api/admin/rooms/drive-a', { password: 'pa2' })).status, 200);
  const pushA = await a.ws.next();
  assert.strictEqual(pushA.type, 'drive');
  assert.strictEqual((await api('/api/rooms/drive-a/drive/folders/root', oldA)).status, 401, 'old token after a password change');
  assert.strictEqual((await api('/api/rooms/drive-a/drive/folders/root', tokA)).status, 401);
  assert.strictEqual((await api('/api/rooms/drive-a/drive/folders/root', pushA.drive.token)).status, 200);
  // Deleting the room ends it for good.
  const rd = await json('DELETE', '/api/admin/rooms/drive-a', {});
  assert.strictEqual(rd.status, 200);
  assert.strictEqual((await api('/api/rooms/drive-a/drive/folders/root', pushA.drive.token)).status, 401);
  a.ws.close();
});

// A whole-file download that is still streaming when the room's access changes must be cut. The client stops reading
// right after the headers, so the server is held up by backpressure (the file is far bigger than the socket buffers).
function slowDownload(room, id, token) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + files(room, id), { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      res.pause();
      let got = 0;
      let finish;
      const done = new Promise((r) => { finish = r; });
      res.on('data', (c) => { got += c.length; });
      res.on('end', () => finish({ clean: true, got }));
      for (const ev of ['error', 'aborted', 'close']) res.on(ev, () => finish({ clean: res.complete, got }));
      resolve({ status: res.statusCode, total: Number(res.headers['content-length']), resume: () => res.resume(), done });
    });
    req.on('error', reject);
  });
}

test('drive: a file response still streaming is cut when the room is deleted, its password or its folder changes', async () => {
  const F1 = 'CUT_FOLDER_000001', F2 = 'CUT_FOLDER_000002', BIG1 = 'CUT_BIG_FILE_0001', BIG2 = 'CUT_BIG_FILE_0002';
  const big = bytes(48 * MiB);
  google.addFolder(F1, 'Cut folder 1');
  google.addFolder(F2, 'Cut folder 2');
  google.addFile(BIG1, 'big1.mp4', F1, big, 'video/mp4');
  google.addFile(BIG2, 'big2.mp4', F2, big, 'video/mp4');
  const setup = async (room, folder) => {
    assert.strictEqual((await json('POST', '/api/admin/rooms', { name: room, password: 'pw' })).status, 201);
    assert.strictEqual((await json('PUT', `/api/admin/rooms/${room}/drive`, { link: folder })).status, 200);
    return join(room, 'pw', 'cccccccc' + room.slice(-1), 'Carol');
  };
  const keep = await setup('cut-keep', F2);
  const cases = [
    ['room deleted', 'cut-1', (r) => json('DELETE', `/api/admin/rooms/${r}`, {})],
    ['password changed', 'cut-2', (r) => json('PUT', `/api/admin/rooms/${r}`, { password: 'new' })],
    ['password changed, members kicked', 'cut-3', (r) => json('PUT', `/api/admin/rooms/${r}`, { password: 'new', kick: true })],
    ['folder removed', 'cut-4', (r) => json('PUT', `/api/admin/rooms/${r}/drive`, { link: '' })],
    ['folder changed', 'cut-5', (r) => json('PUT', `/api/admin/rooms/${r}/drive`, { link: F2 })],
  ];
  for (const [label, room, change] of cases) {
    const m = await setup(room, F1);
    const victim = await slowDownload(room, BIG1, m.welcome.drive.token);
    const other = await slowDownload('cut-keep', BIG2, keep.welcome.drive.token);
    assert.deepStrictEqual([victim.status, other.status, victim.total, other.total], [200, 200, big.length, big.length], label);
    await new Promise((r) => setTimeout(r, 300)); // streaming is under way, held up by the paused clients
    assert.strictEqual((await change(room)).status, 200, label);
    victim.resume();
    const cut = await Promise.race([victim.done, new Promise((r) => setTimeout(() => r({ timeout: true }), 5000))]);
    assert(!cut.timeout, `${label}: the response ended promptly`);
    assert(!cut.clean && cut.got < victim.total, `${label}: cut short (${cut.got} of ${victim.total} bytes), not a clean end`);
    other.resume();
    const kept = await other.done;
    assert(kept.clean && kept.got === other.total, `${label}: the other room's download is not affected`);
    m.ws.close();
  }
  keep.ws.close();
  // Nothing is left behind: the server keeps serving new downloads (and a new one starts and ends normally).
  const again = await api(files('cut-keep', BIG2), keep.welcome.drive.token, { headers: { Authorization: `Bearer ${keep.welcome.drive.token}`, Range: 'bytes=0-99' } });
  assert.strictEqual((await again.arrayBuffer()).byteLength, 100);
});

test('drive: clients that disconnect right after sending a file request leave nothing behind', async () => {
  const F = 'LEAK_FOLDER_00001', FILE = 'LEAK_FILE_0000001';
  google.addFolder(F, 'Leak folder');
  google.addFile(FILE, 'leak.mp4', F, bytes(3 * MiB), 'video/mp4');
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'leak-room', password: 'pw' })).status, 201);
  assert.strictEqual((await json('PUT', '/api/admin/rooms/leak-room/drive', { link: F })).status, 200);
  const m = await join('leak-room', 'pw', 'llllllll1', 'Lena');
  const token = m.welcome.drive.token;
  const registry = async () => (await fetch(BASE + '/api/debug/drive-streams')).json(); // DRIVE_DEBUG=1 test hook
  const request = `GET ${files('leak-room', FILE)} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\n\r\n`;
  await Promise.all(Array.from({ length: 50 }, (_, i) => new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(request);
      // gone before the first byte; some right away, some while the server is still asking Google
      setTimeout(() => sock.destroy(), i % 5);
    });
    sock.on('error', () => {});
    sock.on('close', resolve);
  })));
  let left;
  for (let i = 0; i < 50; i++) {
    left = await registry();
    if (left.streams === 0 && left.rooms === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepStrictEqual(left, { rooms: 0, streams: 0 }, 'no stream stays registered');
  assert(mediaCalls(FILE).length <= 1, 'one shared upstream fetch at most, not one per client: ' + mediaCalls(FILE).length);
  // The room still works: an admin change and a normal download.
  assert.strictEqual((await json('PUT', '/api/admin/rooms/leak-room', { password: 'pw2' })).status, 200);
  const fresh = (await m.ws.next()).drive.token;
  assert((await (await api(files('leak-room', FILE), fresh)).arrayBuffer()).byteLength === 3 * MiB);
  assert.deepStrictEqual(await registry(), { rooms: 0, streams: 0 });
  m.ws.close();
});

test('drive: without a service account there is no drive field and no endpoint', async () => {
  const s = await spawnServer({});
  const login = await fetch(s.base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'admin-pw-for-tests' }) });
  const ck = login.headers.get('set-cookie').split(';')[0];
  const call = (method, p, body) => fetch(s.base + p, { method, headers: { 'content-type': 'application/json', cookie: ck }, body: body ? JSON.stringify(body) : undefined });
  assert.strictEqual((await call('POST', '/api/admin/rooms', { name: 'nodrive', password: '' })).status, 201);
  const put = await (await call('PUT', '/api/admin/rooms/nodrive/drive', { link: D.rootA })).json();
  assert.deepStrictEqual(put, { ok: true, drive: { folderId: D.rootA } }, 'saved, but no check without a service account');
  assert.strictEqual((await (await call('GET', '/api/admin/rooms')).json()).serviceAccount, '');
  const ws = new WebSocket(s.base.replace('http', 'ws') + '/ws');
  const msg = await new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room: 'nodrive', id: 'gggggggg1', name: 'X', password: '' })));
    ws.on('message', (m) => resolve(JSON.parse(m.toString())));
  });
  assert.strictEqual(msg.type, 'welcome');
  assert(!('drive' in msg), 'the room has a folder, but the server cannot read Drive');
  assert.strictEqual((await fetch(`${s.base}/api/rooms/nodrive/drive/folders/root`, { headers: { Authorization: 'Bearer x' } })).status, 503);
  ws.close();
  s.stop();
});

test('drive: an unusable key file disables Drive, with a clear log line that never shows the key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-badkey-'));
  try {
    const secretMarker = 'TOPSECRETKEYMATERIAL';
    const cases = {
      missing: path.join(dir, 'nope.json'),
      notJson: path.join(dir, 'a.json'),
      noKey: path.join(dir, 'b.json'),
      badPem: path.join(dir, 'c.json'),
    };
    fs.writeFileSync(cases.notJson, `{ "private_key": "${secretMarker}" `);
    fs.writeFileSync(cases.noKey, JSON.stringify({ client_email: 'x@y.z' }));
    fs.writeFileSync(cases.badPem, JSON.stringify({ client_email: 'x@y.z', private_key: `-----BEGIN PRIVATE KEY-----\n${secretMarker}\n-----END PRIVATE KEY-----\n` }));
    for (const [name, file] of Object.entries(cases)) {
      const s = await spawnServer({ GOOGLE_SERVICE_ACCOUNT: file });
      await new Promise((r) => setTimeout(r, 100));
      assert.match(s.out.log, /GOOGLE_SERVICE_ACCOUNT is set but cannot be used/, name);
      assert(!s.out.log.includes(secretMarker), `${name}: the key is not logged`);
      s.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('drive: outside tests the key must name Google\'s token endpoint, and GOOGLE_API_BASE needs DRIVE_DEBUG', async () => {
  const { loadServiceAccount } = require('../server/drive');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-tokenuri-'));
  try {
    const key = JSON.parse(fs.readFileSync(google.writeAccount(dir), 'utf8'));
    let n = 0;
    const write = (tokenUri) => {
      const file = path.join(dir, `k${n++}.json`);
      const k = { ...key };
      if (tokenUri === undefined) delete k.token_uri; else k.token_uri = tokenUri;
      fs.writeFileSync(file, JSON.stringify(k));
      return file;
    };
    for (const ok of [undefined, 'https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token']) {
      assert.strictEqual(loadServiceAccount(write(ok)).tokenUri, ok || 'https://oauth2.googleapis.com/token', String(ok));
    }
    for (const bad of [
      `${google.url}/token`, 'http://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com.evil.example/token',
      'https://oauth2.googleapis.com:8443/token', 'https://user:pw@oauth2.googleapis.com/token',
      'https://oauth2.googleapis.com/token?x=1', 'https://oauth2.googleapis.com/token#x', 'https://169.254.169.254/token',
    ]) {
      assert.throws(() => loadServiceAccount(write(bad)), /not Google's token endpoint/, bad);
    }
    // Tests may point it at a fake Google.
    assert.strictEqual(loadServiceAccount(write(`${google.url}/token`), { testEndpoints: true }).tokenUri, `${google.url}/token`);

    // The server: a fake token endpoint, or a GOOGLE_API_BASE other than Google's, disables Drive unless DRIVE_DEBUG=1.
    for (const env of [
      { GOOGLE_SERVICE_ACCOUNT: write(`${google.url}/token`) },
      { GOOGLE_SERVICE_ACCOUNT: write(undefined), GOOGLE_API_BASE: google.url },
    ]) {
      const s = await spawnServer(env);
      await new Promise((r) => setTimeout(r, 100));
      assert.match(s.out.log, /GOOGLE_SERVICE_ACCOUNT is set but cannot be used: (token_uri|GOOGLE_API_BASE)/);
      assert.doesNotMatch(s.out.log, /Google Drive enabled/);
      s.stop();
    }
    const official = await spawnServer({ GOOGLE_SERVICE_ACCOUNT: write(undefined), GOOGLE_API_BASE: 'https://www.googleapis.com/' });
    await new Promise((r) => setTimeout(r, 100));
    assert.match(official.out.log, /Google Drive enabled/, "naming Google's own API base is fine");
    official.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Phantom rooms (inherited object properties) ---------------------------------------------------
const PHANTOMS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

test('names of Object.prototype properties are not rooms', async () => {
  for (const name of PHANTOMS) {
    assert.strictEqual((await fetch(`${BASE}/api/rooms/${name}`)).status, 404, name);
    const ws = await wsClient();
    ws.sendJson({ type: 'join', room: name, id: 'phantom01', name: 'X' });
    assert.strictEqual((await ws.next()).code, 'no-room', name);
    ws.close();
  }
  // The admin is not told a room "already exists" when it does not; the name is simply free (or invalid).
  const created = await json('POST', '/api/admin/rooms', { name: 'constructor', password: '' });
  assert.strictEqual(created.status, 201);
  assert.strictEqual((await fetch(`${BASE}/api/rooms/constructor`)).status, 200);
  const dup = await json('POST', '/api/admin/rooms', { name: 'constructor' });
  assert.strictEqual(dup.status, 400);
  assert.match((await dup.json()).error, /already exists/);
  assert.strictEqual((await json('DELETE', '/api/admin/rooms/constructor', {})).status, 200);
  assert.strictEqual((await fetch(`${BASE}/api/rooms/constructor`)).status, 404);
  const proto = await json('POST', '/api/admin/rooms', { name: '__proto__' });
  assert.strictEqual(proto.status, 400);
  assert.doesNotMatch((await proto.json()).error, /already exists/);
  const del = await json('DELETE', '/api/admin/rooms/toString', {});
  assert.strictEqual(del.status, 404);
  assert.match((await del.json()).error, /No such room/);
  const list = (await (await json('GET', '/api/admin/rooms')).json()).rooms.map((r) => r.name);
  assert(!list.includes('constructor'));
});

test('RoomStore: own properties only, also for names loaded from rooms.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-store-'));
  try {
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'rooms.json'), `{"version":1,"rooms":{"real":{"name":"Real","passwordHash":"","createdAt":${now},"updatedAt":${now}},"__proto__":{"name":"Evil","passwordHash":""}}}`);
    const store = new RoomStore(dir);
    for (const name of PHANTOMS.filter((n) => n !== '__proto__')) assert.strictEqual(store.get(name), null, name);
    assert.strictEqual(store.get('REAL').name, 'Real');
    assert.deepStrictEqual(store.list().map((r) => r.name).sort(), ['Evil', 'Real'].sort(), 'an own "__proto__" entry from the file is just data');
    assert.strictEqual(({}).name, undefined, 'Object.prototype was not polluted');
    assert.throws(() => store.delete('constructor'), /No such room/);
    assert.strictEqual(store.get('constructor'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- rooms.json problems --------------------------------------------------------------------------------
test('RoomStore: an unparseable rooms.json is moved aside, not overwritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-store-'));
  const origError = console.error;
  const logged = [];
  try {
    fs.writeFileSync(path.join(dir, 'rooms.json'), '{ "rooms": { "a": ');
    console.error = (...a) => logged.push(a.join(' '));
    const store = new RoomStore(dir);
    console.error = origError;
    assert.deepStrictEqual(store.list(), []);
    assert(logged.some((l) => /could not be parsed/.test(l) && /corrupt-/.test(l)), 'says what happened');
    const aside = fs.readdirSync(dir).filter((f) => f.startsWith('rooms.json.corrupt-'));
    assert.strictEqual(aside.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{ "rooms": { "a": ');
    assert(!fs.existsSync(path.join(dir, 'rooms.json')));
    await store.create('fresh', '');
    assert.strictEqual(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{ "rooms": { "a": ', 'saving does not touch the saved copy');
    assert(new RoomStore(dir).get('fresh'));
  } finally {
    console.error = origError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RoomStore: an unreadable rooms.json stops the server instead of risking an overwrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-store-'));
  try {
    fs.mkdirSync(path.join(dir, 'rooms.json')); // reading it fails with EISDIR (like EACCES: not ENOENT)
    assert.throws(() => new RoomStore(dir), /Cannot read .*rooms\.json/);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      env: { ...process.env, PORT: String(await freePort()), HOST: '127.0.0.1', ADMIN_PASSWORD: 'admin-pw-for-tests', DATA_DIR: dir, GOOGLE_SERVICE_ACCOUNT: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.strictEqual(code, 1);
    assert.match(log, /Cannot read .*rooms\.json/);
    assert.doesNotMatch(log, /\n\s+at /, 'a message, not a stack trace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Failed writes leave the store untouched ----------------------------------------------------------------------
test('RoomStore: a failed write of rooms.json changes nothing in memory, and the same call works once writing does', async () => {
  const { RoomError } = require('../server/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-store-'));
  const block = () => fs.mkdirSync(path.join(dir, 'rooms.json.tmp'));
  const unblock = () => fs.rmdirSync(path.join(dir, 'rooms.json.tmp'));
  const snapshot = (store) => JSON.stringify({ list: store.list(), rooms: store.rooms });
  const failsHard = async (fn) => {
    await assert.rejects(async () => fn(), (err) => !(err instanceof RoomError) && err.code === 'EISDIR');
  };
  try {
    const store = new RoomStore(dir);
    await store.create('keep', 'secret');
    store.setDrive('keep', { folderId: FID });
    const before = snapshot(store);
    assert.strictEqual(Object.getPrototypeOf(store.rooms), null);

    // create
    block();
    await failsHard(() => store.create('newroom', 'pw'));
    assert.strictEqual(store.get('newroom'), null);
    assert.strictEqual(snapshot(store), before);
    unblock();
    await store.create('newroom', 'pw');
    assert(new RoomStore(dir).get('newroom'));

    // setPassword
    const afterCreate = snapshot(store);
    block();
    await failsHard(() => store.setPassword('keep', 'changed'));
    assert.strictEqual(snapshot(store), afterCreate);
    assert.strictEqual(await store.check('keep', 'secret'), true);
    assert.strictEqual(await store.check('keep', 'changed'), false);
    unblock();
    await store.setPassword('keep', 'changed');
    const reloaded = new RoomStore(dir);
    assert.strictEqual(await reloaded.check('keep', 'changed'), true);
    assert.strictEqual(await reloaded.check('keep', 'secret'), false);

    // setDrive (set a new folder, and remove it)
    const afterPw = snapshot(store);
    block();
    await new Promise((r) => setTimeout(r, 5)); // so a leaked updatedAt would differ
    const OTHER = '9ZyXwVuTsRqPoNmLkJiHgFeDcBa_-0123';
    await failsHard(() => store.setDrive('keep', { folderId: OTHER }));
    assert.strictEqual(snapshot(store), afterPw);
    assert.strictEqual(store.get('keep').drive.folderId, FID);
    await failsHard(() => store.setDrive('keep', null));
    assert.strictEqual(snapshot(store), afterPw);
    unblock();
    store.setDrive('keep', { folderId: OTHER });
    assert.strictEqual(new RoomStore(dir).get('keep').drive.folderId, OTHER);
    store.setDrive('keep', null);
    assert.strictEqual(new RoomStore(dir).get('keep').drive, undefined);
    store.setDrive('keep', { folderId: FID });

    // delete
    const afterDrive = snapshot(store);
    block();
    await failsHard(() => store.delete('newroom'));
    assert.strictEqual(snapshot(store), afterDrive);
    assert(store.get('newroom'));
    assert(store.list().some((r) => r.name === 'newroom'));
    assert.strictEqual(await store.check('newroom', 'pw'), true);
    unblock();
    store.delete('newroom');
    assert.strictEqual(store.get('newroom'), null);
    assert.strictEqual(new RoomStore(dir).get('newroom'), null);
    assert(new RoomStore(dir).get('keep'));
    assert.strictEqual(Object.getPrototypeOf(store.rooms), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RoomStore: two concurrent creates of one name: one wins, the other is "already exists"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-store-'));
  try {
    const store = new RoomStore(dir);
    const results = await Promise.allSettled([store.create('Same', 'one'), store.create('same', 'two')]);
    assert.deepStrictEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const lost = results.find((r) => r.status === 'rejected');
    assert.match(lost.reason.message, /already exists/);
    const winnerPw = results[0].status === 'fulfilled' ? 'one' : 'two';
    const loserPw = winnerPw === 'one' ? 'two' : 'one';
    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(await store.check('same', winnerPw), true, 'the winner is not overwritten');
    assert.strictEqual(await store.check('same', loserPw), false);
    assert.strictEqual(await new RoomStore(dir).check('same', winnerPw), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Room password limiter ----------------------------------------------------------------------------
function wsAt(base, headers = {}, opts = {}) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers, ...opts });
  const queue = [];
  let waiter = null;
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    if (waiter) { const w = waiter; waiter = null; w(msg); } else queue.push(msg);
  });
  ws.next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => { waiter = r; }));
  ws.sendJson = (o) => ws.send(JSON.stringify(o));
  return new Promise((resolve, reject) => { ws.on('open', () => resolve(ws)); ws.on('error', reject); });
}

async function adminCookie(base) {
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'admin-pw-for-tests' }) });
  return login.headers.get('set-cookie').split(';')[0];
}

test('room password limit: a burst of wrong passwords cannot get past it, and open rooms cost nothing', async () => {
  const s = await spawnServer({ TRUST_PROXY: '1', MAX_ROOM_SIZE: '50' });
  const ck = await adminCookie(s.base);
  const post = (body) => fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify(body) });
  assert.strictEqual((await post({ name: 'locked', password: 'right' })).status, 201);
  assert.strictEqual((await post({ name: 'open', password: '' })).status, 201);

  // 60 sockets from one IP, all guessing at once.
  const sockets = await Promise.all(Array.from({ length: 60 }, () => wsAt(s.base, { 'X-Forwarded-For': '10.1.1.1' })));
  sockets.forEach((ws, i) => ws.sendJson({ type: 'join', room: 'locked', id: `burst${String(i).padStart(4, '0')}`, name: 'G', password: `guess${i}` }));
  const codes = (await Promise.all(sockets.map((ws) => ws.next()))).map((m) => m.code);
  assert.strictEqual(codes.filter((c) => c === 'bad-password').length, 20, 'only the allowed 20 were evaluated');
  assert.strictEqual(codes.filter((c) => c === 'rate-limited').length, 40);
  sockets.forEach((ws) => ws.close());

  // Even the right password is refused for that IP now, but a fresh IP works.
  const same = await wsAt(s.base, { 'X-Forwarded-For': '10.1.1.1' });
  same.sendJson({ type: 'join', room: 'locked', id: 'sameip001', name: 'A', password: 'right' });
  assert.strictEqual((await same.next()).code, 'rate-limited');
  const fresh = await wsAt(s.base, { 'X-Forwarded-For': '10.2.2.2' });
  fresh.sendJson({ type: 'join', room: 'locked', id: 'freship01', name: 'B', password: 'right' });
  assert.strictEqual((await fresh.next()).type, 'welcome');

  // One join in flight per socket: the others are answered (busy), not dropped or evaluated.
  const one = await wsAt(s.base, { 'X-Forwarded-For': '10.3.3.3' });
  for (let i = 0; i < 30; i++) one.sendJson({ type: 'join', room: 'locked', id: 'onesock001', name: 'C', password: `bad${i}` });
  const answers = [];
  for (let i = 0; i < 30; i++) answers.push((await one.next()).code);
  assert.strictEqual(answers.filter((c) => c === 'bad-password').length, 1, 'one evaluated');
  assert.strictEqual(answers.filter((c) => c === 'busy').length, 29);

  // Correct passwords give the attempt back, and open rooms never use any: 25 joins do not lock the IP out.
  const ip = { 'X-Forwarded-For': '10.4.4.4' };
  for (let i = 0; i < 25; i++) {
    const ws = await wsAt(s.base, ip);
    ws.sendJson({ type: 'join', room: i % 2 ? 'open' : 'locked', id: 'reuse00001', name: 'D', password: i % 2 ? '' : 'right' });
    assert.strictEqual((await ws.next()).type, 'welcome', `join ${i}`);
    ws.close();
  }
  for (const ws of [same, fresh, one]) ws.close();
  s.stop();
});

// ---- Client IP behind proxies ------------------------------------------------------------------------------
test('TRUST_PROXY counts X-Forwarded-For from the right (number of trusted hops)', async () => {
  const attempt = (base, xff) => fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Forwarded-For': xff }, body: JSON.stringify({ password: 'wrong' }) }).then((r) => r.status);
  // One hop (true): the last entry is the client; spoofed entries before it do not matter.
  const one = await spawnServer({ TRUST_PROXY: 'true' });
  for (let i = 0; i < 10; i++) assert.strictEqual(await attempt(one.base, `spoofed-${i}, 7.7.7.7`), 401);
  assert.strictEqual(await attempt(one.base, 'another-spoof, 7.7.7.7'), 429, 'same client, however the header starts');
  assert.strictEqual(await attempt(one.base, '7.7.7.7, 8.8.8.8'), 401, 'a different last entry is a different client');
  one.stop();
  // Two hops: the second entry from the right.
  const two = await spawnServer({ TRUST_PROXY: '2' });
  for (let i = 0; i < 10; i++) assert.strictEqual(await attempt(two.base, `spoofed-${i}, 9.9.9.9, 10.0.0.1`), 401);
  assert.strictEqual(await attempt(two.base, 'x, 9.9.9.9, 10.0.0.2'), 429);
  assert.strictEqual(await attempt(two.base, 'x, 6.6.6.6, 10.0.0.1'), 401);
  two.stop();
  // Off: the header is ignored altogether.
  const off = await spawnServer({ TRUST_PROXY: '' });
  for (let i = 0; i < 10; i++) assert.strictEqual(await attempt(off.base, `spoofed-${i}`), 401);
  assert.strictEqual(await attempt(off.base, 'yet-another'), 429);
  off.stop();
});

// ---- welcome.resumed, and who may take over an id -----------------------------------------------------------------
test('welcome says whether the join resumed the previous connection', async () => {
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'resume-room', password: '' })).status, 201);
  const secret = secretOf('resumer001');
  const a = await wsClient();
  a.sendJson({ type: 'join', room: 'resume-room', id: 'resumer001', name: 'A', secret });
  const first = await a.next();
  assert.strictEqual(first.resumed, false);
  const b = await wsClient();
  b.sendJson({ type: 'join', room: 'resume-room', id: 'resumer001', name: 'A', secret });
  const second = await b.next();
  assert.strictEqual(second.resumed, true, 'took over the live entry of the same id');
  const other = await wsClient();
  other.sendJson({ type: 'join', room: 'resume-room', id: 'resumer002', name: 'B', secret: secretOf('resumer002') });
  assert.strictEqual((await other.next()).resumed, false);
  // After a clean leave there is nothing to resume.
  b.sendJson({ type: 'leave' });
  await other.next(); // peer-left
  const c = await wsClient();
  c.sendJson({ type: 'join', room: 'resume-room', id: 'resumer001', name: 'A', secret });
  assert.strictEqual((await c.next()).resumed, false);
  for (const ws of [a, b, c, other]) ws.close();
});

test('an id seen in the room cannot be taken over without its secret: no eviction, no leave in its name', { timeout: 30000 }, async () => {
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'hijack-room', password: 'hp' })).status, 201);
  const online = async () => (await (await json('GET', '/api/admin/rooms')).json()).rooms.find((r) => r.name === 'hijack-room').online.sort();
  const victim = await wsClient();
  victim.sendJson({ type: 'join', room: 'hijack-room', id: 'victim0001', name: 'Alice', password: 'hp', secret: secretOf('victim0001') });
  assert.strictEqual((await victim.next()).type, 'welcome');
  const victimClosed = new Promise((r) => victim.once('close', (code) => r(code)));
  const mallory = await wsClient();
  mallory.sendJson({ type: 'join', room: 'hijack-room', id: 'mallory001', name: 'Mallory', password: 'hp', secret: secretOf('mallory001') });
  const mw = await mallory.next();
  assert.deepStrictEqual(mw.peers, [{ id: 'victim0001', name: 'Alice' }], 'every member sees the others\' ids');
  await victim.next(); // peer-joined

  // Mallory joins under Alice's id: with another secret, with none, and with a malformed one.
  const attempts = [
    [secretOf('mallory001'), 'id-taken'],
    [undefined, 'id-taken'],
    ['short', 'bad-request'],
    [['x'.repeat(20)], 'bad-request'],
    ['has spaces in it, 1234', 'bad-request'],
  ];
  for (const [secret, code] of attempts) {
    const ws = await wsClient();
    ws.sendJson({ type: 'join', room: 'hijack-room', id: 'victim0001', name: 'Mallory', password: 'hp', secret });
    assert.strictEqual((await ws.next()).code, code, JSON.stringify(secret));
    // Not a member: its leave (in Alice's name, if it had worked) and its signals go nowhere.
    ws.sendJson({ type: 'leave' });
    ws.sendJson({ type: 'signal', to: 'mallory001', data: { evil: 1 } });
    ws.close();
  }
  assert.deepStrictEqual(await online(), ['Alice', 'Mallory']);
  victim.sendJson({ type: 'time', c: 7 });
  assert.strictEqual((await victim.next()).c, 7, 'Alice is still connected and got nothing in between');
  mallory.sendJson({ type: 'time', c: 8 });
  assert.strictEqual((await mallory.next()).c, 8, 'and Mallory got no peer-left for her');

  // Alice's own tab (same secret) can take its id back, e.g. after a network blip: the old socket is replaced (4000).
  const again = await wsClient();
  again.sendJson({ type: 'join', room: 'hijack-room', id: 'victim0001', name: 'Alice', password: 'hp', secret: secretOf('victim0001') });
  assert.strictEqual((await again.next()).resumed, true);
  assert.strictEqual(await victimClosed, 4000);
  // A free id needs no secret (a client from before secrets existed).
  const legacy = await wsClient();
  legacy.sendJson({ type: 'join', room: 'hijack-room', id: 'legacy0001', name: 'Old', password: 'hp' });
  assert.strictEqual((await legacy.next()).type, 'welcome');
  // ...but such an entry cannot be taken over at all, not even without a secret.
  const legacy2 = await wsClient();
  legacy2.sendJson({ type: 'join', room: 'hijack-room', id: 'legacy0001', name: 'Old', password: 'hp' });
  assert.strictEqual((await legacy2.next()).code, 'id-taken');
  for (const ws of [again, mallory, legacy, legacy2]) ws.close();
});

// ---- Headers, caching, compression ---------------------------------------------------------------------------------
function rawGet(p, headers = {}, method = 'GET', base = BASE) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + p, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('HTML pages carry a Content-Security-Policy; HSTS only for HTTPS requests', async () => {
  for (const p of ['/', '/admin', '/SomeRoom']) {
    const res = await rawGet(p, { Host: 'calls.example.com' });
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/, 'no inline scripts');
    assert.match(csp, /style-src 'self'(;|$)/, 'no inline styles');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self' ws:\/\/calls\.example\.com wss:\/\/calls\.example\.com/);
    assert.match(csp, /media-src 'self' blob:/);
    assert.match(csp, /worker-src 'self' blob:/);
    assert.strictEqual(res.headers['strict-transport-security'], undefined, 'plain HTTP');
  }
  assert.strictEqual((await rawGet('/assets/js/app.js')).headers['content-security-policy'], undefined, 'only pages');
  const s = await spawnServer({ TRUST_PROXY: '1' });
  const https = await rawGet('/healthz', { 'X-Forwarded-Proto': 'https' }, 'GET', s.base);
  assert.match(https.headers['strict-transport-security'], /^max-age=\d+$/);
  assert.strictEqual((await rawGet('/healthz', {}, 'GET', s.base)).headers['strict-transport-security'], undefined);
  s.stop();
});

test('static files: ETag/Last-Modified, 304, compression, HEAD', async () => {
  const p = '/assets/js/app.js';
  const plain = await rawGet(p, { 'Accept-Encoding': 'identity' });
  assert.strictEqual(plain.status, 200);
  assert.strictEqual(plain.headers['content-encoding'], undefined);
  assert.strictEqual(plain.headers.vary, 'Accept-Encoding');
  assert.strictEqual(plain.headers['cache-control'], 'no-cache');
  assert(plain.headers.etag && plain.headers['last-modified']);
  assert.strictEqual(plain.headers['content-length'], String(plain.body.length));
  const original = fs.readFileSync(path.join(__dirname, '..', 'public', p));
  assert(plain.body.equals(original));

  // Conditional requests
  const again = await rawGet(p, { 'Accept-Encoding': 'identity', 'If-None-Match': plain.headers.etag });
  assert.strictEqual(again.status, 304);
  assert.strictEqual(again.body.length, 0);
  assert.strictEqual(again.headers.etag, plain.headers.etag);
  assert.strictEqual((await rawGet(p, { 'Accept-Encoding': 'identity', 'If-None-Match': `W/${plain.headers.etag}, "other"` })).status, 304);
  assert.strictEqual((await rawGet(p, { 'Accept-Encoding': 'identity', 'If-None-Match': '"nope"' })).status, 200);
  assert.strictEqual((await rawGet(p, { 'Accept-Encoding': 'identity', 'If-Modified-Since': plain.headers['last-modified'] })).status, 304);
  assert.strictEqual((await rawGet(p, { 'Accept-Encoding': 'identity', 'If-Modified-Since': new Date(0).toUTCString() })).status, 200);
  assert.strictEqual((await rawGet(p, { 'Accept-Encoding': 'identity', 'If-None-Match': '"nope"', 'If-Modified-Since': plain.headers['last-modified'] })).status, 200, 'If-None-Match wins');

  // Compression
  const zlib = require('node:zlib');
  const gz = await rawGet(p, { 'Accept-Encoding': 'gzip' });
  assert.strictEqual(gz.headers['content-encoding'], 'gzip');
  assert.strictEqual(gz.headers.vary, 'Accept-Encoding');
  assert.notStrictEqual(gz.headers.etag, plain.headers.etag, 'one validator per representation');
  assert(gz.body.length < original.length / 2);
  assert(zlib.gunzipSync(gz.body).equals(original));
  assert.strictEqual(gz.headers['content-length'], String(gz.body.length));
  const br = await rawGet(p, { 'Accept-Encoding': 'gzip, br' });
  assert.strictEqual(br.headers['content-encoding'], 'br');
  assert(zlib.brotliDecompressSync(br.body).equals(original));
  assert.strictEqual((await rawGet(p, { 'Accept-Encoding': 'br;q=0, gzip' })).headers['content-encoding'], 'gzip');
  assert.strictEqual((await rawGet(p, { 'Accept-Encoding': 'gzip', 'If-None-Match': gz.headers.etag })).status, 304);
  assert.strictEqual((await rawGet(p, { 'Accept-Encoding': 'gzip', 'If-None-Match': br.headers.etag })).status, 200);
  assert.strictEqual((await rawGet(p)).headers['content-encoding'], undefined, 'no Accept-Encoding, no compression');
  const html = await rawGet('/', { 'Accept-Encoding': 'gzip' });
  assert.strictEqual(html.headers['content-encoding'], 'gzip');
  assert(html.headers['content-security-policy']);
  assert(zlib.gunzipSync(html.body).equals(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'))));

  // HEAD: same headers, no body
  const head = await rawGet(p, { 'Accept-Encoding': 'gzip' }, 'HEAD');
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.body.length, 0);
  assert.strictEqual(head.headers['content-encoding'], 'gzip');
  assert.strictEqual(head.headers['content-length'], gz.headers['content-length']);
  assert.strictEqual(head.headers.etag, gz.headers.etag);
  const headPlain = await rawGet(p, { 'Accept-Encoding': 'identity' }, 'HEAD');
  assert.strictEqual(headPlain.headers['content-length'], String(original.length));
  assert.strictEqual(headPlain.body.length, 0);

  // Images are not compressed
  const png = await rawGet('/assets/icon.svg', { 'Accept-Encoding': 'gzip' });
  assert.strictEqual(png.status, 200);
});

test('a NUL byte in a path is a 400 and the server keeps answering', async () => {
  const s = await spawnServer({});
  for (const p of ['/assets/a%00b.js', '/assets/js/app.js%00.png', '/some%00room', '/admin%00', '/%00']) {
    const res = await rawGet(p, {}, 'GET', s.base);
    assert.strictEqual(res.status, 400, p);
  }
  assert.strictEqual((await rawGet('/healthz', {}, 'GET', s.base)).status, 200);
  assert.strictEqual((await rawGet('/assets/js/app.js', {}, 'GET', s.base)).status, 200);
  assert.strictEqual((await rawGet('/api/rooms/a%00b', {}, 'GET', s.base)).status, 404);
  assert.strictEqual(s.child.exitCode, null, 'still running');
  s.stop();
});

test('compression cache: concurrent cold requests share one result, and other assets are still served right', async () => {
  const zlib = require('node:zlib');
  const s = await spawnServer({});
  const pub = path.join(__dirname, '..', 'public');
  const first = '/assets/js/app.js';
  const others = ['/assets/js/mesh.js', '/assets/js/sync.js', '/assets/js/media.js', '/'];
  const original = (p) => fs.readFileSync(path.join(pub, p === '/' ? 'index.html' : p));
  const results = await Promise.all(Array.from({ length: 40 }, () => rawGet(first, { 'Accept-Encoding': 'br' }, 'GET', s.base)));
  for (const r of results) {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-encoding'], 'br');
    assert.strictEqual(r.headers.etag, results[0].headers.etag);
    assert(zlib.brotliDecompressSync(r.body).equals(original(first)));
  }
  // Different assets, cold and then warm, with a mix of encodings.
  for (let round = 0; round < 2; round++) {
    const batch = await Promise.all(others.flatMap((p) => [rawGet(p, { 'Accept-Encoding': 'br' }, 'GET', s.base), rawGet(p, { 'Accept-Encoding': 'gzip' }, 'GET', s.base)]));
    batch.forEach((r, i) => {
      const p = others[i >> 1];
      assert.strictEqual(r.status, 200, p);
      const out = i % 2 ? zlib.gunzipSync(r.body) : zlib.brotliDecompressSync(r.body);
      assert(out.equals(original(p)), `${p} ${i % 2 ? 'gzip' : 'br'}`);
    });
  }
  const again = await rawGet(first, { 'Accept-Encoding': 'br' }, 'GET', s.base);
  assert.strictEqual(again.headers.etag, results[0].headers.etag);
  assert(again.body.equals(results[0].body), 'the same cached body');
  s.stop();
});

// ---- Error answers -------------------------------------------------------------------------------------------------
test('bad input is a 400, internal failures are a generic 500 that is logged but not leaked', async () => {
  const s = await spawnServer({});
  const ck = await adminCookie(s.base);
  const call = (p, init) => fetch(s.base + p, { headers: { 'content-type': 'application/json', cookie: ck }, ...init });
  const bad = await call('/api/admin/rooms', { method: 'POST', body: '{nope' });
  assert.strictEqual(bad.status, 400);
  assert.deepStrictEqual(await bad.json(), { error: 'Invalid JSON' });
  // Too large: answered with 413 (the client gets to read it), not a connection reset.
  const big = await call('/api/admin/rooms', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(40000) }) });
  assert.strictEqual(big.status, 413);
  assert.deepStrictEqual(await big.json(), { error: 'Body too large' });
  // A malformed cookie (maybe from another app on the domain) is ignored: not logged in, but no error either.
  const cookieRes = await fetch(s.base + '/api/admin/rooms', { headers: { cookie: 'te_admin=%E0%A4%A' } });
  assert.strictEqual(cookieRes.status, 401);
  const mixed = await fetch(s.base + '/api/admin/rooms', { headers: { cookie: `other=%E0%A4%A; ${ck}; also=%zz` } });
  assert.strictEqual(mixed.status, 200, 'the valid session cookie still counts');
  // A body that is valid JSON but not an object is a client error too (also without logging in).
  for (const raw of ['null', '42', '"text"', '[1,2]', 'true']) {
    const res = await fetch(s.base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    assert.strictEqual(res.status, 400, raw);
    assert.deepStrictEqual(await res.json(), { error: 'Invalid JSON' });
    const authed = await call('/api/admin/rooms', { method: 'POST', body: raw });
    assert.strictEqual(authed.status, 400, raw);
  }
  assert.doesNotMatch(s.out.log, /request failed/, 'no TypeError was logged');
  // Domain errors keep their message
  const dupe = await call('/api/admin/rooms', { method: 'POST', body: JSON.stringify({ name: 'admin' }) });
  assert.strictEqual(dupe.status, 400);

  // Make writing rooms.json fail: a directory is in the way of the temp file.
  fs.mkdirSync(path.join(s.dir, 'rooms.json.tmp'));
  const res = await call('/api/admin/rooms', { method: 'POST', body: JSON.stringify({ name: 'wontsave' }) });
  assert.strictEqual(res.status, 500);
  const body = await res.json();
  assert.deepStrictEqual(Object.keys(body), ['error']);
  assert.doesNotMatch(JSON.stringify(body), /rooms\.json|EISDIR|\//, 'no path or errno in the answer');
  await new Promise((r) => setTimeout(r, 100));
  assert.match(s.out.log, /request failed:.*EISDIR/s, 'logged on the server');
  s.stop();
});

// ---- WebSocket hardening ------------------------------------------------------------------------------------------
test('WebSocket upgrades from foreign origins are refused', async () => {
  const s = await spawnServer({ ALLOWED_ORIGINS: 'https://calls.example.com/, https://other.example.org' });
  const host = new URL(s.base).host;
  const open = (origin) => wsAt(s.base, origin === undefined ? {} : { Origin: origin }).then((ws) => { ws.close(); return true; }, (err) => err.message);
  assert.strictEqual(await open(undefined), true, 'no Origin (non-browser client)');
  assert.strictEqual(await open(`http://${host}`), true, 'same host');
  assert.strictEqual(await open(`http://${host.toUpperCase()}`), true, 'host is case-insensitive');
  assert.strictEqual(await open('https://calls.example.com'), true, 'ALLOWED_ORIGINS');
  assert.strictEqual(await open('https://other.example.org'), true);
  assert.match(await open('https://evil.example.net'), /403/);
  assert.match(await open(`http://${host}.evil.net`), /403/, 'a host that merely starts the same');
  assert.match(await open('null'), /403/);
  assert.match(await open('not a url'), /403/);
  s.stop();
});

test('ALLOWED_ORIGINS entries are normalised like browser origins; bad ones are ignored with a warning', async () => {
  const s = await spawnServer({ ALLOWED_ORIGINS: 'https://Calls.Example.com:443/, http://plain.example.com:80, nonsense, https://other.example.org:8443/path' });
  const open = (origin) => wsAt(s.base, { Origin: origin }).then((ws) => { ws.close(); return true; }, (err) => err.message);
  assert.strictEqual(await open('https://calls.example.com'), true, 'default port and trailing slash');
  assert.strictEqual(await open('http://plain.example.com'), true);
  assert.strictEqual(await open('https://other.example.org:8443'), true, 'path dropped, port kept');
  assert.match(await open('https://other.example.org'), /403/, 'a different port is a different origin');
  assert.match(s.out.log, /ALLOWED_ORIGINS: ignoring "nonsense"/);
  // Older Safari does not match ws:/wss: to 'self', so the allowed origins are listed in connect-src too.
  const res = await fetch(s.base + '/');
  assert.match(res.headers.get('content-security-policy'), /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ wss:\/\/127\.0\.0\.1:\d+ wss:\/\/calls\.example\.com ws:\/\/plain\.example\.com wss:\/\/other\.example\.org:8443;/);
  s.stop();
});

test('Origin vs Host: strict host:port normally, hostname only behind a trusted proxy', async () => {
  const strict = await spawnServer({});
  const trusted = await spawnServer({ TRUST_PROXY: '1' });
  const open = (s, origin, host) => wsAt(s.base, { Origin: origin, Host: host }).then((ws) => { ws.close(); return true; }, (err) => err.message);
  // nginx "proxy_set_header Host $host": no port, while the browser's Origin has one.
  assert.match(await open(strict, 'https://x.example.com:8443', 'x.example.com'), /403/);
  // Behind a trusted proxy the scheme must match what the proxy forwards, and the port must be the default or Host's.
  const open2 = (origin, host, proto) => wsAt(trusted.base, { Origin: origin, Host: host, ...(proto && { 'X-Forwarded-Proto': proto }) }).then((ws) => { ws.close(); return true; }, (err) => err.message);
  assert.strictEqual(await open2('https://x.example.com:8443', 'x.example.com:8443', 'https'), true);
  assert.strictEqual(await open2('https://x.example.com', 'x.example.com:8443', 'https'), true, 'default port, Host with port');
  assert.strictEqual(await open2('https://x.example.com', 'x.example.com', 'https'), true);
  assert.strictEqual(await open2('http://x.example.com', 'x.example.com'), true, 'http page, no forwarded proto');
  assert.strictEqual(await open2('http://x.example.com', 'x.example.com', 'http'), true);
  assert.match(await open2('https://x.example.com:8443', 'x.example.com', 'https'), /403/, 'non-default port that Host does not name');
  assert.match(await open2('https://x.example.com:9999', 'x.example.com:8443', 'https'), /403/, 'a third port');
  assert.match(await open2('http://x.example.com', 'x.example.com:8443', 'https'), /403/, 'scheme differs from forwarded proto');
  assert.match(await open2('https://x.example.com', 'x.example.com:8443'), /403/, 'https origin, but the proxy did not say https');
  assert.match(await open2('http://x.example.com:80', 'x.example.com:8443', 'https'), /403/, 'http origin on an https connection');
  assert.match(await open2('https://127.0.0.1', 'evil.com@127.0.0.1', 'https'), /403/, 'userinfo trick in Host');
  assert.match(await open2('https://evil.com', 'evil.com/x', 'https'), /403/, 'slash in Host');
  assert.match(await open2('https://evil.com', 'evil.com @a', 'https'), /403/, 'whitespace in Host');
  assert.strictEqual(await open(strict, 'https://x.example.com:8443', 'x.example.com:8443'), true, 'exact host:port');
  assert.strictEqual(await open(strict, 'https://x.example.com', 'x.example.com'), true, 'default port');
  assert.match(await open(trusted, 'https://evil.example.net:8443', 'x.example.com'), /403/, 'other hostname');
  assert.match(await open(trusted, 'https://x.example.com.evil.net', 'x.example.com'), /403/);
  assert.match(await open(trusted, 'null', 'x.example.com'), /403/);
  strict.stop();
  trusted.stop();
});

test('limiterKey: IPv4 as is, IPv4-mapped IPv6 as IPv4, other IPv6 by /64', () => {
  assert.strictEqual(limiterKey('1.2.3.4'), '1.2.3.4');
  assert.strictEqual(limiterKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.strictEqual(limiterKey('::FFFF:0102:0304'), '1.2.3.4');
  assert.strictEqual(limiterKey('2001:db8:1:2:aaaa::1'), limiterKey('2001:0db8:0001:0002:bbbb:cccc:dddd:eeee'));
  assert.notStrictEqual(limiterKey('2001:db8:1:2::1'), limiterKey('2001:db8:1:3::1'));
  assert.strictEqual(limiterKey('[2001:db8::1]'), limiterKey('2001:db8:0:0:5::9'));
  assert.strictEqual(limiterKey('fe80::1%eth0'), limiterKey('fe80::2'));
  assert.strictEqual(limiterKey('not-an-ip'), 'not-an-ip');
  assert.strictEqual(limiterKey(''), '');
});

test('rate limits count an IPv6 /64 (and an IPv4-mapped address as its IPv4) as one client', async () => {
  const s = await spawnServer({ TRUST_PROXY: '1' });
  const attempt = (xff) => fetch(s.base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Forwarded-For': xff }, body: JSON.stringify({ password: 'wrong' }) }).then((r) => r.status);
  for (let i = 0; i < 10; i++) assert.strictEqual(await attempt(`2001:db8:5:6:${i}::${i + 1}`), 401);
  assert.strictEqual(await attempt('2001:db8:5:6:ffff::1'), 429, 'same /64');
  assert.strictEqual(await attempt('2001:db8:5:7::1'), 401, 'another /64');
  for (let i = 0; i < 5; i++) assert.strictEqual(await attempt('203.0.113.9'), 401);
  for (let i = 0; i < 5; i++) assert.strictEqual(await attempt('::ffff:203.0.113.9'), 401);
  assert.strictEqual(await attempt('203.0.113.9'), 429, 'mapped and plain IPv4 share the budget');

  // The room-password limiter uses the same key.
  const ck = await adminCookie(s.base);
  await fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ name: 'v6room', password: 'right' }) });
  const guesses = [];
  for (let i = 0; i < 25; i++) {
    const ws = await wsAt(s.base, { 'X-Forwarded-For': `2001:db8:9:9:${i}::1` });
    ws.sendJson({ type: 'join', room: 'v6room', id: `v6guess${String(i).padStart(4, '0')}`, name: 'G', password: 'bad' });
    guesses.push((await ws.next()).code);
    ws.close();
  }
  assert.strictEqual(guesses.filter((c) => c === 'bad-password').length, 20);
  assert.strictEqual(guesses.filter((c) => c === 'rate-limited').length, 5);
  s.stop();
});

test('a socket that floods the server is closed with a policy code', async () => {
  const s = await spawnServer({});
  // A normal burst (ICE candidates, clock pings) is fine, even a large one.
  const calm = await wsAt(s.base);
  for (let i = 0; i < 500; i++) calm.sendJson({ type: 'time', c: i });
  for (let i = 0; i < 500; i++) assert.strictEqual((await calm.next()).c, i);
  // A flood is not.
  const flood = await wsAt(s.base);
  const closed = new Promise((resolve) => flood.on('close', (code) => resolve(code)));
  for (let i = 0; i < 3000; i++) flood.sendJson({ type: 'time', c: i });
  assert.strictEqual(await closed, 1008);
  // It refills: the calm client can still talk after a pause.
  await new Promise((r) => setTimeout(r, 300));
  calm.sendJson({ type: 'time', c: 'again' });
  assert.strictEqual((await calm.next()).c, 'again');
  calm.close();
  s.stop();
});

test('a newcomer in a full room can send 400 signals in a burst without being disconnected', async () => {
  const s = await spawnServer({});
  const ck = await adminCookie(s.base);
  await fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ name: 'burst-room' }) });
  const a = await wsAt(s.base);
  const b = await wsAt(s.base);
  a.sendJson({ type: 'join', room: 'burst-room', id: 'burstpeerA1', name: 'A' });
  assert.strictEqual((await a.next()).type, 'welcome');
  b.sendJson({ type: 'join', room: 'burst-room', id: 'burstpeerB1', name: 'B' });
  assert.strictEqual((await b.next()).type, 'welcome');
  assert.strictEqual((await a.next()).type, 'peer-joined');
  let closedWith = null;
  b.on('close', (code) => { closedWith = code; });
  for (let i = 0; i < 400; i++) b.sendJson({ type: 'signal', to: 'burstpeerA1', data: { candidate: i } });
  for (let i = 0; i < 400; i++) assert.strictEqual((await a.next()).data.candidate, i);
  assert.strictEqual(closedWith, null);
  b.sendJson({ type: 'time', c: 1 });
  assert.strictEqual((await b.next()).c, 1, 'still connected');
  a.close();
  b.close();
  s.stop();
});

// ---- Startup settings -------------------------------------------------------------------------------------------------
/** Starts the server with `env` and expects it to refuse to start. Returns its output. */
async function failedStart(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-cfg-'));
  try {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      env: { ...process.env, PORT: String(await freePort()), HOST: '127.0.0.1', ADMIN_PASSWORD: 'admin-pw-for-tests', DATA_DIR: dir, GOOGLE_SERVICE_ACCOUNT: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const timer = setTimeout(() => child.kill(), 10000);
    const code = await new Promise((r) => child.on('exit', r));
    clearTimeout(timer);
    assert.strictEqual(code, 1, `exits with an error (${JSON.stringify(env)}): ${log}`);
    return log;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('config: settings are parsed strictly (unit)', () => {
  const { ConfigError, intSetting, trustedHops, driveCacheMb } = require('../server/config');
  assert.strictEqual(intSetting({}, 'X', 12, 1, 50), 12);
  assert.strictEqual(intSetting({ X: ' ' }, 'X', 12, 1, 50), 12);
  assert.strictEqual(intSetting({ X: ' 8 ' }, 'X', 12, 1, 50), 8);
  for (const bad of ['twelve', '12abc', '1.5', '-3', '0x10', '1e3', '0', '51', '9'.repeat(30)]) { // (in [1, 50] here)
    assert.throws(() => intSetting({ X: bad }, 'X', 12, 1, 50), ConfigError, bad);
  }
  assert.throws(() => intSetting({ X: 'z'.repeat(500) }, 'X', 1, 1, 2), (e) => e.message.length < 150, 'long values are cut short');
  for (const [v, n] of [['', 0], ['false', 0], ['NO', 0], ['0', 0], ['true', 1], ['Yes', 1], ['1', 1], ['2', 2], [' 3 ', 3]]) {
    assert.strictEqual(trustedHops({ TRUST_PROXY: v }), n, v);
  }
  assert.strictEqual(trustedHops({}), 0);
  for (const bad of ['on', 'maybe', '-1', '100', '1.5']) assert.throws(() => trustedHops({ TRUST_PROXY: bad }), ConfigError, bad);
  assert.strictEqual(driveCacheMb({}, 256), 256);
  assert.strictEqual(driveCacheMb({ DRIVE_CACHE_MB: '0' }, 256), 0);
  assert.strictEqual(driveCacheMb({ DRIVE_CACHE_MB: '64.5' }, 256), 64.5);
  for (const bad of ['lots', '-1', 'Infinity', '1e3', '99999999']) assert.throws(() => driveCacheMb({ DRIVE_CACHE_MB: bad }, 256), ConfigError, bad);
});

test('config: an unusable setting stops the server with a message naming it', async () => {
  for (const [env, re] of [
    [{ MAX_ROOM_SIZE: 'invalid' }, /MAX_ROOM_SIZE=invalid is not a whole number/],
    [{ MAX_ROOM_SIZE: '0' }, /MAX_ROOM_SIZE=0 is out of range/],
    [{ MAX_ROOM_SIZE: '51' }, /MAX_ROOM_SIZE=51 is out of range \(expected 1 to 50\)/],
    [{ PORT: '70000' }, /PORT=70000 is out of range/],
    [{ TRUST_PROXY: 'on' }, /TRUST_PROXY=on is not valid/],
    [{ DRIVE_CACHE_MB: 'lots' }, /DRIVE_CACHE_MB=lots is not a number/],
  ]) {
    assert.match(await failedStart(env), re);
  }
});

// ---- Drive cache setting ---------------------------------------------------------------------------------------------
test('DRIVE_CACHE_MB below the minimum is raised, with a warning', async () => {
  const env = (mb) => ({ GOOGLE_SERVICE_ACCOUNT: google.writeAccount(keyDir), GOOGLE_API_BASE: google.url, DRIVE_DEBUG: '1', DRIVE_CACHE_MB: mb });
  const low = await spawnServer(env('0'));
  assert.match(low.out.log, /DRIVE_CACHE_MB=0 is too small: using the minimum of 32 MB/);
  low.stop();
  const ok = await spawnServer(env('64'));
  assert.doesNotMatch(ok.out.log, /too small/);
  ok.stop();
});

// ---- Hostile client JSON ------------------------------------------------------------------------------------------
const WEIRD = [{ toString: 1 }, ['aaaaaaaa1'], 5, true, { a: 1 }, [], null];

test('limiterKey input: forwarded values that are not IPs fall back to the socket address; ports and brackets are stripped', async () => {
  const { forwardedAddress } = require('../server/ip');
  assert.strictEqual(forwardedAddress('1.2.3.4:5555'), '1.2.3.4');
  assert.strictEqual(forwardedAddress('[2001:db8::1]:443'), '2001:db8::1');
  assert.strictEqual(forwardedAddress('[2001:db8::1]'), '2001:db8::1');
  assert.strictEqual(forwardedAddress('2001:db8::1'), '2001:db8::1');
  for (const bad of ['', 'not-an-ip', 'x'.repeat(16000), '1.2.3.4.5', '999.1.1.1', '1.2.3.4:99999x', '1.2.3.4, 5.6.7.8', '[1.2.3.4]:80x']) assert.strictEqual(forwardedAddress(bad), '', bad.slice(0, 20));

  const s = await spawnServer({ TRUST_PROXY: '1' });
  const attempt = (xff) => fetch(s.base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Forwarded-For': xff }, body: JSON.stringify({ password: 'wrong' }) }).then((r) => r.status);
  // Garbage all counts against the socket's own address (127.0.0.1), whatever the text.
  for (let i = 0; i < 5; i++) assert.strictEqual(await attempt(`junk-${i}`), 401);
  for (let i = 0; i < 5; i++) assert.strictEqual(await attempt('z'.repeat(8000 + i)), 401);
  assert.strictEqual(await attempt('also-junk'), 429, 'one budget for all non-IP values');
  // A valid IP with a port is that IP.
  for (let i = 0; i < 10; i++) assert.strictEqual(await attempt(`5.5.5.5:${1000 + i}`), 401);
  assert.strictEqual(await attempt('5.5.5.5'), 429);
  assert.strictEqual(await attempt('[2001:db8:7::1]:5000'), 401);
  s.stop();
});

test('admin login: concurrent wrong passwords cannot get past the limit while their bodies arrive', async () => {
  const s = await spawnServer({});
  const { port } = new URL(s.base);
  const body = JSON.stringify({ password: 'wrong' });
  // Open 25 requests and send their headers first; only once all are waiting for a body do the bodies follow.
  const reqs = Array.from({ length: 25 }, () => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/admin/login', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    req.flushHeaders();
    const status = new Promise((resolve, reject) => {
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    return { req, status };
  });
  await new Promise((r) => setTimeout(r, 300));
  for (const { req } of reqs) req.end(body);
  const statuses = await Promise.all(reqs.map((r) => r.status));
  assert.strictEqual(statuses.filter((c) => c === 401).length, 10, `at most 10 checked passwords: ${statuses}`);
  assert.strictEqual(statuses.filter((c) => c === 429).length, 15);
  s.stop();
});

test('the failure limiters remember at most 10,000 clients (expired first, then the oldest unblocked one)', async () => {
  const s = await spawnServer({ TRUST_PROXY: '1' });
  const attempt = (xff) => fetch(s.base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Forwarded-For': xff }, body: JSON.stringify({ password: 'wrong' }) }).then((r) => r.status);
  for (let i = 0; i < 10; i++) assert.strictEqual(await attempt('9.9.9.9'), 401);
  assert.strictEqual(await attempt('9.9.9.9'), 429);
  // 10,000 other clients (one failure each) fill the map past its cap; the oldest unblocked entries go, a blocked one stays.
  const ips = Array.from({ length: 10000 }, (_, i) => `10.${i >> 8 & 255}.${i & 255}.1`);
  for (let i = 0; i < ips.length; i += 200) await Promise.all(ips.slice(i, i + 200).map(attempt));
  assert.strictEqual(await attempt('9.9.9.9'), 429, 'a blocked client stays blocked however many others are added');
  assert.strictEqual(await attempt('10.39.15.1'), 401, 'a recent one is still counted (one failure so far, one more now)');
  s.stop();
});

test('hostile JSON in WebSocket messages never takes the server down', async () => {
  const s = await spawnServer({});
  const ck = await adminCookie(s.base);
  const post = (body) => fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify(body) });
  assert.strictEqual((await post({ name: 'hostile' })).status, 201);
  assert.strictEqual((await post({ name: 'hostile-pw', password: 'right' })).status, 201);
  const alive = async () => {
    assert.strictEqual(s.child.exitCode, null, 'server process is still running');
    const probe = await wsAt(s.base);
    probe.sendJson({ type: 'time', c: 1 });
    assert.strictEqual((await probe.next()).c, 1);
    probe.close();
  };

  const a = await wsAt(s.base);
  a.sendJson({ type: 'join', room: 'hostile', id: 'hostilea1', name: 'A' });
  assert.strictEqual((await a.next()).type, 'welcome');
  const b = await wsAt(s.base);
  b.sendJson({ type: 'join', room: 'hostile', id: 'hostileb1', name: 'B' });
  assert.strictEqual((await b.next()).type, 'welcome');
  assert.strictEqual((await a.next()).type, 'peer-joined');

  // rename with every odd shape: the name becomes Guest, the server stays up.
  for (const name of WEIRD) b.sendJson({ type: 'rename', name });
  b.sendJson({ type: 'time', c: 2 });
  assert.strictEqual((await b.next()).c, 2);
  const rooms = async () => (await (await fetch(s.base + '/api/admin/rooms', { headers: { cookie: ck } })).json()).rooms;
  assert.deepStrictEqual((await rooms()).find((r) => r.name === 'hostile').online, ['A', 'Guest']);
  b.sendJson({ type: 'rename', name: 'Bob' });
  b.sendJson({ type: 'time', c: 3 });
  await b.next();
  assert.deepStrictEqual((await rooms()).find((r) => r.name === 'hostile').online, ['A', 'Bob']);

  // type, signal.to, and every join field with odd values.
  for (const v of WEIRD) {
    b.sendJson({ type: v });
    b.sendJson({ type: 'signal', to: v, data: 1 });
    b.sendJson({ type: 'signal', to: 'hostilea1', data: v }); // data is relayed as is
  }
  b.sendJson([1, 2, 3]);
  b.sendJson('text');
  b.sendJson(null);
  b.sendJson({ type: 'time', c: 4 });
  assert.strictEqual((await b.next()).c, 4);
  let got = 0;
  for (let i = 0; i < WEIRD.length; i++) { assert.strictEqual((await a.next()).type, 'signal'); got++; }
  assert.strictEqual(got, WEIRD.length);

  for (const field of ['room', 'id', 'password', 'name', 'type']) {
    for (const v of WEIRD) {
      const c = await wsAt(s.base);
      const msg = { type: 'join', room: 'hostile-pw', id: 'hostilec1', name: 'C', password: 'right', [field]: v };
      c.sendJson(msg);
      if (field === 'type') { c.sendJson({ type: 'time', c: 9 }); assert.strictEqual((await c.next()).c, 9); c.close(); continue; } // not a join at all
      const reply = await c.next();
      if (field === 'name') assert.strictEqual(reply.type, 'welcome', `${field} ${JSON.stringify(v)} ${JSON.stringify(reply)}`);
      else assert.strictEqual(reply.type, 'error', `${field} ${JSON.stringify(v)}`);
      c.close();
    }
  }
  await alive();

  // Admin API bodies.
  for (const v of WEIRD) {
    const created = await post({ name: v, password: 'x' });
    assert.strictEqual(created.status, 400, `create name ${JSON.stringify(v)}`);
    const pw = await post({ name: 'okname', password: v });
    assert.strictEqual(pw.status, v === null ? 201 : 400, `create password ${JSON.stringify(v)}`);
    await fetch(s.base + '/api/admin/rooms/okname', { method: 'DELETE', headers: { cookie: ck } });
    const put = await fetch(s.base + '/api/admin/rooms/hostile', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ password: v, kick: v }) });
    assert.notStrictEqual(put.status, 500, `set password ${JSON.stringify(v)}`);
    const link = await fetch(s.base + '/api/admin/rooms/hostile/drive', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ link: v }) });
    assert.notStrictEqual(link.status, 500, `drive link ${JSON.stringify(v)}`);
    const login = await fetch(s.base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: v }) });
    assert.strictEqual(login.status, 401, 'login with a non-text password');
  }
  assert.strictEqual((await post({ name: 'okname2', password: { toString: 1 } })).status, 400);
  assert.strictEqual((await post({ name: ['x'] })).status, 400);
  assert.strictEqual((await fetch(s.base + '/api/admin/rooms/hostile', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ password: { toString: 1 } }) })).status, 400);
  assert.strictEqual((await fetch(s.base + '/api/admin/rooms/hostile/drive', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ link: {} }) })).status, 400, 'a non-text link does not silently remove the folder');
  assert.doesNotMatch(s.out.log, /request failed|message failed|join failed/, 'nothing threw');
  await alive();
  a.close();
  b.close();
  s.stop();
});

test('a failed join leaves no ghost: it cannot relay signals, is not counted, and kicks reach it', async () => {
  const s = await spawnServer({ MAX_ROOM_SIZE: '2' });
  const ck = await adminCookie(s.base);
  const post = (body) => fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify(body) });
  await post({ name: 'ghosts' });
  await post({ name: 'lockedg', password: 'right' });
  const rooms = async () => (await (await fetch(s.base + '/api/admin/rooms', { headers: { cookie: ck } })).json()).rooms;
  const online = async (name) => (await rooms()).find((r) => r.name === name).online;

  const a = await wsAt(s.base);
  a.sendJson({ type: 'join', room: 'ghosts', id: 'ghostmem01', name: 'A' });
  assert.strictEqual((await a.next()).type, 'welcome');

  // Each failing join (bad id, wrong password, no room, odd fields, full room): the socket still cannot relay into the room.
  const failing = [
    { room: 'ghosts', id: 'x', name: 'bad id' },
    { room: 'ghosts', id: ['ghostbad01'], name: 'array id' },
    { room: 'ghosts', id: 'ghostbad02', name: 'N', password: { toString: 1 } },
    { room: 'lockedg', id: 'ghostbad03', name: 'N', password: 'wrong' },
    { room: 'missing', id: 'ghostbad04', name: 'N' },
    { room: { toString: 1 }, id: 'ghostbad05', name: 'N' },
  ];
  for (const f of failing) {
    const g = await wsAt(s.base);
    g.sendJson({ type: 'join', ...f });
    assert.strictEqual((await g.next()).type, 'error', JSON.stringify(f));
    g.sendJson({ type: 'signal', to: 'ghostmem01', data: { evil: 1 } });
    g.sendJson({ type: 'rename', name: 'Ghost' });
    g.sendJson({ type: 'time', c: 1 });
    assert.strictEqual((await g.next()).c, 1);
    g.close();
  }
  a.sendJson({ type: 'time', c: 2 });
  assert.strictEqual((await a.next()).c, 2, 'nothing was relayed to the member');
  assert.deepStrictEqual(await online('ghosts'), ['A']);
  assert.deepStrictEqual(await online('lockedg'), [], 'no empty room entry stays behind');

  // A join to a full room fails too: it is not a member afterwards, and the freed-up count is exact.
  const b = await wsAt(s.base);
  b.sendJson({ type: 'join', room: 'ghosts', id: 'ghostmem02', name: 'B' });
  assert.strictEqual((await b.next()).type, 'welcome');
  assert.strictEqual((await a.next()).type, 'peer-joined');
  const full = await wsAt(s.base);
  full.sendJson({ type: 'join', room: 'ghosts', id: 'ghostmem03', name: 'C' });
  assert.strictEqual((await full.next()).code, 'room-full');
  full.sendJson({ type: 'signal', to: 'ghostmem01', data: { evil: 1 } });
  full.sendJson({ type: 'time', c: 3 });
  await full.next();
  a.sendJson({ type: 'time', c: 4 });
  assert.strictEqual((await a.next()).c, 4, 'no signal from the rejected socket');

  // A member whose second join fails still is a member of its first room only through its registration, and a
  // socket that failed to move cannot sign as someone else.
  const closes = new Promise((r) => full.on('close', r));
  assert.deepStrictEqual((await online('ghosts')).sort(), ['A', 'B']);
  const kick = await fetch(s.base + '/api/admin/rooms/ghosts', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ password: 'newpw', kick: true }) });
  assert.strictEqual(kick.status, 200);
  assert.strictEqual((await a.next()).code, 'kicked');
  assert.strictEqual((await b.next()).code, 'kicked');
  assert.deepStrictEqual(await online('ghosts'), []);
  full.close();
  await closes;
  a.close();
  b.close();
  s.stop();
});

// A second server with Drive on: tokens are renewed while members stay connected, and the session cookie is Secure behind TLS.
test('drive: a member connected for a long time gets a fresh token pushed; the cookie is Secure behind a TLS proxy', async () => {
  const FOLDER = 'REFRESH_FOLDER_01';
  google.addFolder(FOLDER, 'Refresh folder');
  google.addFile('REFRESH_MOVIE_001', 'r.mp4', FOLDER, Buffer.from('0123456789'), 'video/mp4');
  const s = await spawnServer({
    GOOGLE_SERVICE_ACCOUNT: google.writeAccount(keyDir), GOOGLE_API_BASE: google.url, DRIVE_DEBUG: '1',
    DRIVE_TOKEN_REFRESH_MS: '600', HEARTBEAT_MS: '150', TRUST_PROXY: 'true',
  });
  const login = await fetch(s.base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin-pw-for-tests' }) });
  const admin = { 'Content-Type': 'application/json', cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.strictEqual((await fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'refresh', password: 'pw' }) })).status, 201);
  assert.strictEqual((await fetch(s.base + '/api/admin/rooms/refresh/drive', { method: 'PUT', headers: admin, body: JSON.stringify({ link: FOLDER }) })).status, 200);

  const ws = new WebSocket(s.base.replace('http', 'ws') + '/ws');
  const inbox = [];
  let wake = null;
  ws.on('message', (m) => { inbox.push(JSON.parse(m.toString())); wake?.(); });
  const next = async (ms = 4000) => {
    const end = Date.now() + ms;
    while (!inbox.length && Date.now() < end) await new Promise((r) => { wake = r; setTimeout(r, 50); });
    return inbox.shift();
  };
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', room: 'refresh', id: 'rrrrrrrr1', name: 'Tester', password: 'pw' }));
  const welcome = await next();
  assert.strictEqual(welcome.type, 'welcome');
  const first = welcome.drive.token;
  const get = (token) => fetch(s.base + '/api/rooms/refresh/drive/folders/root', { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual((await get(first)).status, 200);

  // After more than the (shortened) refresh age and a housekeeping tick, a new token arrives over the socket.
  const push = await next();
  assert.strictEqual(push?.type, 'drive');
  assert.strictEqual(push.drive.folder, FOLDER);
  assert.notStrictEqual(push.drive.token, first);
  assert.strictEqual((await get(push.drive.token)).status, 200);
  // ...and then again, so a member never runs out (the timer restarts with each push).
  const again = await next();
  assert.strictEqual(again?.type, 'drive');
  assert.notStrictEqual(again.drive.token, push.drive.token);
  ws.close();

  // The session cookie is Secure when the proxy says the request came in over https, like the admin cookie.
  const viaProxy = (proto) => fetch(s.base + '/api/rooms/refresh/drive/session', { method: 'POST', headers: { Authorization: `Bearer ${push.drive.token}`, 'X-Forwarded-Proto': proto, 'X-Forwarded-For': '203.0.113.9' } });
  assert.match((await viaProxy('https')).headers.get('set-cookie'), /; Secure/);
  assert.doesNotMatch((await viaProxy('http')).headers.get('set-cookie'), /Secure/);
  // Clearing it is Secure under the same rule.
  const clearVia = (proto) => fetch(s.base + '/api/rooms/refresh/drive/session', { method: 'DELETE', headers: { 'X-Forwarded-Proto': proto, 'X-Forwarded-For': '203.0.113.9' } });
  assert.match((await clearVia('https')).headers.get('set-cookie'), /Max-Age=0; Secure$/);
  assert.doesNotMatch((await clearVia('http')).headers.get('set-cookie'), /Secure/);
});

// Drive limits seen from the HTTP side: a folder listing that was cut off says so, and one room cannot hold
// more than 3 x MAX_ROOM_SIZE file streams open at once.
test('drive: `truncated` reaches the folders endpoint, and a room has a cap on open file streams (429)', async () => {
  const F = 'LIMITS_FOLDER_001', BIG = 'LIMITS_BIG_FILE_01';
  google.addFolder(F, 'Limits folder');
  for (let i = 0; i < 5; i++) google.addFile(`LIMITS_MOVIE_00${i}_`, `m${i}.mp4`, F, Buffer.from('0123456789'), 'video/mp4');
  const big = bytes(48 * MiB);
  google.addFile(BIG, 'big.mp4', F, big, 'video/mp4');
  const s = await spawnServer({
    GOOGLE_SERVICE_ACCOUNT: google.writeAccount(keyDir), GOOGLE_API_BASE: google.url, DRIVE_DEBUG: '1',
    DRIVE_MAX_LIST_ITEMS: '3', MAX_ROOM_SIZE: '1', // at most 3 streams per room
  });
  const login = await fetch(s.base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin-pw-for-tests' }) });
  const admin = { 'Content-Type': 'application/json', cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.strictEqual((await fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'limits' }) })).status, 201);
  const put = await fetch(s.base + '/api/admin/rooms/limits/drive', { method: 'PUT', headers: admin, body: JSON.stringify({ link: F }) });
  assert.deepStrictEqual((await put.json()).check, { name: 'Limits folder', items: 3, truncated: true });

  const ws = new WebSocket(s.base.replace('http', 'ws') + '/ws');
  const welcome = await new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room: 'limits', id: 'llllllll1', name: 'L' })));
    ws.on('message', (m) => resolve(JSON.parse(m.toString())));
  });
  const token = welcome.drive.token;
  const listing = await (await fetch(s.base + '/api/rooms/limits/drive/folders/root', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.strictEqual(listing.items.length, 3);
  assert.strictEqual(listing.truncated, true);

  // Three streams that nobody reads stay open (the file is far bigger than the socket buffers); the fourth is refused.
  const open = () => new Promise((resolve, reject) => {
    const req = http.get(s.base + `/api/rooms/limits/drive/files/${BIG}`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      res.pause();
      resolve({ res, req });
    });
    req.on('error', reject);
  });
  const held = [await open(), await open(), await open()];
  assert(held.every((h) => h.res.statusCode === 200));
  const refused = await fetch(s.base + `/api/rooms/limits/drive/files/${BIG}`, { headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-9' } });
  assert.strictEqual(refused.status, 429);
  assert.match((await refused.json()).error, /Too many movie streams/);
  assert.strictEqual(refused.headers.get('retry-after'), '5');
  // Other requests of the room still work (folders, and a stream is not needed for them)
  assert.strictEqual((await fetch(s.base + '/api/rooms/limits/drive/folders/root', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  // Closing one frees a place.
  held[0].req.destroy();
  let freed = false;
  for (let i = 0; i < 50 && !freed; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const r = await fetch(s.base + `/api/rooms/limits/drive/files/${BIG}`, { headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-9' } });
    freed = r.status === 206;
    await r.arrayBuffer();
  }
  assert(freed, 'a stream was possible again after one closed');
  for (const h of held) h.req.destroy();
  ws.close();
});

test('container health check: exits 0 while the server answers, 1 when it is down', async () => {
  const script = path.join(__dirname, '..', 'server', 'healthcheck.js');
  const run = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, TLS_CERT: '', TLS_KEY: '', ...env }, stdio: 'ignore' });
    child.on('exit', (code) => resolve(code));
  });
  assert.strictEqual(await run({ PORT: String(PORT), HOST: '127.0.0.1' }), 0, 'healthy server');
  assert.strictEqual(await run({ PORT: String(PORT), HOST: '0.0.0.0' }), 0, 'wildcard bind is checked over loopback');
  assert.strictEqual(await run({ PORT: String(await freePort()), HOST: '127.0.0.1' }), 1, 'nothing listening');
  // A plain HTTP server speaking to an HTTPS check (TLS_CERT set) fails rather than passing by accident.
  assert.strictEqual(await run({ PORT: String(PORT), HOST: '127.0.0.1', TLS_CERT: 'x', TLS_KEY: 'x' }), 1, 'TLS mismatch');
});

test('admin logout behind a TLS proxy clears a Secure cookie and ends the session (X-Forwarded-Proto in any case)', async () => {
  const s = await spawnServer({ TRUST_PROXY: 'true' });
  const tls = { 'content-type': 'application/json', 'X-Forwarded-Proto': 'HTTPS' };
  const login = await fetch(s.base + '/api/admin/login', { method: 'POST', headers: tls, body: JSON.stringify({ password: 'admin-pw-for-tests' }) });
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  const ck = login.headers.get('set-cookie').split(';')[0];
  assert.strictEqual((await fetch(s.base + '/api/admin/rooms', { headers: { cookie: ck } })).status, 200);
  const out = await fetch(s.base + '/api/admin/logout', { method: 'POST', headers: { ...tls, cookie: ck }, body: '{}' });
  assert.strictEqual(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /^te_admin=;.*Max-Age=0; Secure$/);
  assert.strictEqual((await fetch(s.base + '/api/admin/rooms', { headers: { cookie: ck } })).status, 401);
  s.stop();
});

/** What `read()` resolves to once it deep-equals `want`, or its last value after `ms` (a client sees its socket close a
 * moment before the server has processed it, so lists of members lag behind by a few milliseconds). */
async function settled(read, want, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await read();
    if (JSON.stringify(got) === JSON.stringify(want) || Date.now() > deadline) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The next message `pred` accepts (others are skipped); { type: 'timeout' } after `ms`. */
async function nextMatching(ws, pred, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { type: 'timeout' };
    const m = await Promise.race([ws.next(), new Promise((r) => setTimeout(() => r(null), left))]);
    if (!m) return { type: 'timeout' };
    if (pred(m)) return m;
  }
}

test('several members flooding one (each within its own budget): the flooders are cut off, the receiver stays', { timeout: 60000 }, async () => {
  const s = await spawnServer({ MAX_ROOM_SIZE: '50' }); // the receiver, an honest member and 48 flooders: a full room
  const ck = await adminCookie(s.base);
  await fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ name: 'stall-room' }) });
  const online = async () => (await (await fetch(s.base + '/api/admin/rooms', { headers: { cookie: ck } })).json()).rooms[0].online;
  const joinAs = async (id) => {
    const ws = await wsAt(s.base);
    ws.sendJson({ type: 'join', room: 'stall-room', id, name: id });
    assert.strictEqual((await nextMatching(ws, (m) => m.type === 'welcome')).type, 'welcome');
    return ws;
  };
  const a = await joinAs('stallpeerA1');
  const honest = await joinAs('honestpeer1');
  const senders = [];
  for (let i = 0; i < 48; i++) senders.push(await joinAs(`stallsend${String(i).padStart(2, '0')}`));
  const closes = senders.map((b) => new Promise((r) => b.once('close', (code) => r(code))));
  honest.sendJson({ type: 'signal', to: 'stallpeerA1', data: { sdp: 'an honest offer' } });
  // A's link is slow (here: it stops reading); together the senders queue far more than it takes.
  a._socket.pause();
  const big = 'x'.repeat(30 * 1024);
  for (const b of senders) for (let i = 0; i < 16; i++) b.sendJson({ type: 'signal', to: 'stallpeerA1', data: { sdp: big } });
  const codes = await Promise.race([Promise.all(closes), new Promise((r) => setTimeout(() => r(null), 20000))]);
  assert(codes, 'every flooder was cut off');
  assert(codes.every((c) => c === 1008), JSON.stringify(codes));
  const stayed = ['honestpeer1', 'stallpeerA1'];
  assert.deepStrictEqual(await settled(async () => (await online()).sort(), stayed), stayed, 'the receiver and the honest member are still in the room');
  honest.sendJson({ type: 'signal', to: 'stallpeerA1', data: { sdp: 'another honest offer' } });
  honest.sendJson({ type: 'time', c: 1 });
  assert.strictEqual((await nextMatching(honest, (m) => m.type === 'time')).c, 1, 'the honest member is still connected');
  a.terminate();
  honest.close();
  s.stop();
});

test('a member that stops reading is dropped by the heartbeat, and the others are told', { timeout: 30000 }, async () => {
  const s = await spawnServer({ DRIVE_DEBUG: '1', HEARTBEAT_MS: '200' });
  const ck = await adminCookie(s.base);
  await fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ name: 'stuck-room' }) });
  const a = await wsAt(s.base);
  a.sendJson({ type: 'join', room: 'stuck-room', id: 'stuckpeerA1', name: 'A' });
  assert.strictEqual((await a.next()).type, 'welcome');
  const b = await wsAt(s.base);
  b.sendJson({ type: 'join', room: 'stuck-room', id: 'stuckpeerB1', name: 'B' });
  assert.strictEqual((await b.next()).type, 'welcome');
  a._socket.pause(); // A's connection stalls: no more pongs either
  const left = await nextMatching(b, (m) => m.type === 'peer-left', 10000);
  assert.deepStrictEqual({ type: left.type, id: left.id }, { type: 'peer-left', id: 'stuckpeerA1' });
  a.terminate();
  b.close();
  s.stop();
});

test('the signal budget grows with MAX_ROOM_SIZE: a newcomer in a big room can send an offer to everyone', { timeout: 30000 }, async () => {
  // About 15 KB (an offer with a shared screen, and its candidates) to each of the 49 others in a full room of 50, all at
  // once. Signals to someone who is not in the room still count against the sender's budget, so the members do not
  // have to exist here.
  const burst = async (maxRoomSize) => {
    const s = await spawnServer({ MAX_ROOM_SIZE: maxRoomSize });
    const ck = await adminCookie(s.base);
    await fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ name: 'big-room' }) });
    const ws = await wsAt(s.base);
    ws.sendJson({ type: 'join', room: 'big-room', id: 'newcomer01', name: 'N' });
    assert.strictEqual((await ws.next()).type, 'welcome');
    const closed = new Promise((r) => ws.once('close', (code) => r(code)));
    const offer = 'o'.repeat(15 * 1024);
    for (let i = 0; i < 49; i++) ws.sendJson({ type: 'signal', to: `member${String(i).padStart(4, '0')}`, data: { sdp: offer } });
    ws.sendJson({ type: 'time', c: 1 });
    const answer = await Promise.race([nextMatching(ws, (m) => m.type === 'time', 5000), closed.then((code) => ({ type: 'closed', code }))]);
    ws.terminate();
    s.stop();
    return answer;
  };
  assert.strictEqual((await burst('50')).type, 'time', 'MAX_ROOM_SIZE=50: still connected');
  assert.deepStrictEqual(await burst('12'), { type: 'closed', code: 1008 }, 'MAX_ROOM_SIZE=12: that much is a flood');
});

test('signals: one member cannot flood another off the server; oversized signals are not relayed', { timeout: 30000 }, async () => {
  const s = await spawnServer({});
  const ck = await adminCookie(s.base);
  await fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ name: 'flood-room' }) });
  const online = async () => (await (await fetch(s.base + '/api/admin/rooms', { headers: { cookie: ck } })).json()).rooms[0].online.sort();
  const victim = await wsAt(s.base);
  victim.sendJson({ type: 'join', room: 'flood-room', id: 'floodvict1', name: 'Victim' });
  assert.strictEqual((await victim.next()).type, 'welcome');
  const attacker = await wsAt(s.base);
  attacker.sendJson({ type: 'join', room: 'flood-room', id: 'floodattk1', name: 'Attacker' });
  assert.strictEqual((await attacker.next()).type, 'welcome');
  assert.strictEqual((await victim.next()).type, 'peer-joined');

  // A signal above the size limit is dropped (an SDP is far smaller); the sender stays connected.
  attacker.sendJson({ type: 'signal', to: 'floodvict1', data: { sdp: 'x'.repeat(40 * 1024) } });
  attacker.sendJson({ type: 'signal', to: 'floodvict1', data: { sdp: 'small' } });
  assert.deepStrictEqual(await victim.next(), { type: 'signal', from: 'floodattk1', data: { sdp: 'small' } }, 'only the small one arrived');

  // The victim's link is slow (it stops reading); the attacker sends as fast as it can: the attacker is cut off.
  victim._socket.pause();
  const closed = new Promise((r) => attacker.once('close', (code) => r(code)));
  const big = 'x'.repeat(30 * 1024);
  for (let i = 0; i < 300; i++) attacker.sendJson({ type: 'signal', to: 'floodvict1', data: { sdp: big } });
  assert.strictEqual(await closed, 1008, 'the flooding sender is closed as rate limited');
  assert.deepStrictEqual(await settled(online, ['Victim']), ['Victim'], 'the victim is still in the room');
  victim._socket.resume();
  victim.terminate();
  s.stop();
});
// ---- TURN credentials go to members only ------------------------------------------------------------------------
test('TURN credentials: not in the public config, in the welcome after the password check, and renewed before they expire', async () => {
  const secret = 'turn-shared-secret';
  const s = await spawnServer({ TURN_URLS: 'turn:turn.example.com:3478', TURN_SECRET: secret, DRIVE_DEBUG: '1', HEARTBEAT_MS: '100', ICE_REFRESH_MS: '400' });
  const cfg = await (await fetch(s.base + '/api/config')).json();
  assert(!JSON.stringify(cfg).includes('turn:'), 'no TURN server in /api/config');
  assert(!JSON.stringify(cfg).includes('credential') && !JSON.stringify(cfg).includes('username'));
  assert(cfg.iceServers.length && cfg.iceServers.every((x) => x.urls.every((u) => u.startsWith('stun:'))), 'STUN only');
  const ck = await adminCookie(s.base);
  await fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ name: 'turn-room', password: 'tp' }) });

  const bad = await wsAt(s.base);
  bad.sendJson({ type: 'join', room: 'turn-room', id: 'turnbad001', name: 'X', password: 'wrong' });
  const refused = await bad.next();
  assert.strictEqual(refused.code, 'bad-password');
  assert(!JSON.stringify(refused).includes('turn:'));
  bad.close();

  const ws = await wsAt(s.base);
  ws.sendJson({ type: 'join', room: 'turn-room', id: 'turnmem001', name: 'M', password: 'tp' });
  const welcome = await ws.next();
  const turnOf = (servers) => servers.find((x) => x.urls.some((u) => u.startsWith('turn:')));
  const turn = turnOf(welcome.iceServers);
  assert(turn, 'the welcome carries the TURN server');
  assert.strictEqual(turn.credential, crypto.createHmac('sha1', secret).update(turn.username).digest('base64'), 'coturn use-auth-secret credential');
  // Renewed while connected (here after 400 ms instead of 10 h).
  const renewed = await nextMatching(ws, (m) => m.type === 'ice', 5000);
  assert.strictEqual(renewed.type, 'ice');
  assert(Number(turnOf(renewed.iceServers).username.split(':')[0]) >= Number(turn.username.split(':')[0]));
  ws.close();
  s.stop();
});

// ---- ADMIN_PASSWORD ------------------------------------------------------------------------------------------------
test('ADMIN_PASSWORD: an example value, a short one or only spaces stops the server, without printing it', async () => {
  const { adminPassword, ConfigError } = require('../server/config');
  assert.strictEqual(adminPassword({}), '', 'unset: the server generates one');
  assert.strictEqual(adminPassword({ ADMIN_PASSWORD: '' }), '');
  assert.strictEqual(adminPassword({ ADMIN_PASSWORD: 'a-long-enough-pw' }), 'a-long-enough-pw');
  assert.strictEqual(adminPassword({ ADMIN_PASSWORD: 'nine-char' }), 'nine-char', '9 characters is the minimum');
  for (const bad of ['change-me-to-something-long', ' Change-Me-To-Something-Long ', 'replace-with-a-long-random-password', 'short', '8-chars!', ' '.repeat(20)]) {
    assert.throws(() => adminPassword({ ADMIN_PASSWORD: bad }), ConfigError, JSON.stringify(bad));
  }
  const exitOf = async (password) => {
    const port = String(await freePort());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-pw-'));
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      env: { ...process.env, PORT: port, HOST: '127.0.0.1', ADMIN_PASSWORD: password, DATA_DIR: dir, GOOGLE_SERVICE_ACCOUNT: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    return { code, log };
  };
  const example = await exitOf('change-me-to-something-long');
  assert.strictEqual(example.code, 1);
  assert.match(example.log, /Configuration error: ADMIN_PASSWORD is still the example value/);
  assert(!example.log.includes('change-me-to-something-long'), 'the value is not printed');
  const short = await exitOf('pw123');
  assert.strictEqual(short.code, 1);
  assert.match(short.log, /ADMIN_PASSWORD is too short \(5 characters\)/);
});

// ---- Sockets that do not join ----------------------------------------------------------------------------------------
test('a socket that does not join (or has left) is closed after the join deadline; members stay', { timeout: 30000 }, async () => {
  const s = await spawnServer({ DRIVE_DEBUG: '1', JOIN_DEADLINE_MS: '300' });
  const ck = await adminCookie(s.base);
  await fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ name: 'deadline' }) });
  const closeCode = (ws) => new Promise((r) => ws.once('close', (code) => r(code)));
  const idle = await wsAt(s.base);
  const idleClosed = closeCode(idle);
  const member = await wsAt(s.base);
  member.sendJson({ type: 'join', room: 'deadline', id: 'deadline01', name: 'M' });
  assert.strictEqual((await member.next()).type, 'welcome');
  assert.strictEqual(await idleClosed, 4002, 'never joined');
  await new Promise((r) => setTimeout(r, 500));
  member.sendJson({ type: 'time', c: 1 });
  assert.strictEqual((await member.next()).c, 1, 'a member is past the deadline and still connected');
  const leftClosed = closeCode(member);
  member.sendJson({ type: 'leave' });
  assert.strictEqual(await leftClosed, 4002, 'left the room and stayed idle');
  s.stop();
});

test('open sockets per client address are capped (an IPv4 address or an IPv6 /64), and freed when they close', { timeout: 30000 }, async () => {
  const s = await spawnServer({ TRUST_PROXY: '1', MAX_ROOM_SIZE: '1' }); // cap: max(64, 2 x room size) = 64
  const from = (ip) => wsAt(s.base, { 'X-Forwarded-For': ip });
  const held = [];
  for (let i = 0; i < 64; i++) held.push(await from('10.9.9.9'));
  await assert.rejects(from('10.9.9.9'), /429/);
  const other = await from('10.9.9.10');
  // One IPv6 subscriber (a /64) counts once, whichever address inside it is used.
  const v6 = [];
  for (let i = 0; i < 64; i++) v6.push(await from(`2001:db8:1:2::${(i + 1).toString(16)}`));
  await assert.rejects(from('2001:db8:1:2:ffff::1'), /429/);
  assert.match(s.out.log, /Refused a WebSocket: 64 are already open from one client address/);
  const gone = new Promise((r) => held[0].once('close', r));
  held[0].close();
  await gone;
  await new Promise((r) => setTimeout(r, 200)); // the server's side of the close
  held[0] = await from('10.9.9.9');
  for (const ws of [...held, ...v6, other]) ws.close();
  s.stop();
});

// ---- Drive in a room without a password ------------------------------------------------------------------------------
test('drive: a room without a password can have a folder (the admin page warns), and removing a password keeps it working', async () => {
  // An open room gets a folder: allowed, and every member (anyone with the link) gets a token.
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'open-drive', password: '' })).status, 201);
  assert.strictEqual((await json('PUT', '/api/admin/rooms/open-drive/drive', { link: D.rootA })).status, 200);
  const listed = (await (await json('GET', '/api/admin/rooms')).json()).rooms.find((r) => r.name === 'open-drive');
  assert.deepStrictEqual({ drive: listed.drive, hasPassword: listed.hasPassword }, { drive: { folderId: D.rootA }, hasPassword: false }, 'what the admin page warns about');
  const open = await join('open-drive', '', 'opendrive1');
  assert.strictEqual(open.welcome.drive.folder, D.rootA);
  assert.strictEqual((await api('/api/rooms/open-drive/drive/folders/root', open.welcome.drive.token)).status, 200);
  open.ws.close();

  // A room with a password and a folder may lose its password: members get a new token (the old one stopped working).
  assert.strictEqual((await json('PUT', '/api/admin/rooms/open-drive', { password: 'odp' })).status, 200);
  const member = await join('open-drive', 'odp', 'opendrive2');
  const before = member.welcome.drive.token;
  assert.strictEqual((await json('PUT', '/api/admin/rooms/open-drive', { password: '' })).status, 200);
  const pushed = await nextMatching(member.ws, (m) => m.type === 'drive');
  assert.notStrictEqual(pushed.drive.token, before);
  assert.strictEqual((await api('/api/rooms/open-drive/drive/folders/root', before)).status, 401);
  assert.strictEqual((await api('/api/rooms/open-drive/drive/folders/root', pushed.drive.token)).status, 200);
  member.ws.close();
  assert.strictEqual((await json('DELETE', '/api/admin/rooms/open-drive', {})).status, 200);
});

// ---- Admin routes match their exact path ---------------------------------------------------------------------------------
test('admin routes match their exact path: extra segments are a 404 and change nothing', async () => {
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'exact-path', password: 'ep' })).status, 201);
  const exists = async () => (await json('GET', '/api/admin/rooms').then((r) => r.json())).rooms.some((r) => r.name === 'exact-path');
  for (const [method, p, body] of [
    ['DELETE', '/api/admin/rooms/exact-path/extra', {}],
    ['DELETE', '/api/admin/rooms/exact-path/drive/oops', {}],
    ['PUT', '/api/admin/rooms/exact-path/extra', { password: '' }],
    ['PUT', '/api/admin/rooms/exact-path/drive/extra', { link: '' }],
    ['POST', '/api/admin/rooms/extra', { name: 'made-up' }],
    ['GET', '/api/admin/rooms/extra/more'],
    ['POST', '/api/admin/login/extra', { password: 'admin-pw-for-tests' }],
    ['GET', '/api/config/extra'],
  ]) {
    assert.strictEqual((await json(method, p, body)).status, 404, `${method} ${p}`);
  }
  assert(await exists(), 'the room is still there');
  assert.strictEqual((await fetch(BASE + '/api/rooms/exact-path')).status, 200);
  assert.strictEqual((await json('DELETE', '/api/admin/rooms/exact-path', {})).status, 200);
  assert(!(await exists()));
});

test('guessing room names is slow: after 30 misses a client gets 429 for every lookup, existing rooms included', async () => {
  const s = await spawnServer({ TRUST_PROXY: '1' });
  const ck = await adminCookie(s.base);
  await fetch(s.base + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ name: 'real-room' }) });
  const look = (name, ip) => fetch(`${s.base}/api/rooms/${name}`, { headers: { 'X-Forwarded-For': ip } }).then((r) => r.status);
  // Finding a room costs nothing; only misses count.
  for (let i = 0; i < 40; i++) assert.strictEqual(await look('real-room', '10.7.7.7'), 200);
  for (let i = 0; i < 29; i++) assert.strictEqual(await look(`guess-${i}`, '10.7.7.7'), 404);
  // Joins to missing rooms are misses too.
  const ws = await wsAt(s.base, { 'X-Forwarded-For': '10.7.7.7' });
  ws.sendJson({ type: 'join', room: 'guess-by-join', id: 'guesser001', name: 'G' });
  assert.strictEqual((await ws.next()).code, 'no-room');
  assert.strictEqual(await look('guess-more', '10.7.7.7'), 429);
  assert.strictEqual(await look('real-room', '10.7.7.7'), 429, 'an existing room looks the same as a missing one now');
  ws.sendJson({ type: 'join', room: 'real-room', id: 'guesser001', name: 'G' });
  assert.strictEqual((await ws.next()).code, 'rate-limited');
  assert.strictEqual(await look('real-room', '10.7.7.8'), 200, 'other clients are not affected');
  ws.close();
  s.stop();
});

// ---- Removing one member ---------------------------------------------------------------------------------------------
test('admin: one member can be removed; the others stay and are told, and the room list has the ids to do it', async () => {
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'kick-room', password: 'kp' })).status, 201);
  const room = async () => (await (await json('GET', '/api/admin/rooms')).json()).rooms.find((r) => r.name === 'kick-room');
  const alice = await join('kick-room', 'kp', 'kickalice1', 'Alice');
  const bob = await join('kick-room', 'kp', 'kickbob001', 'Bob');
  await alice.ws.next(); // peer-joined
  const listed = await room();
  assert.deepStrictEqual(listed.online.sort(), ['Alice', 'Bob'], 'online keeps listing names');
  assert.deepStrictEqual(listed.members.sort((x, y) => x.name.localeCompare(y.name)), [{ id: 'kickalice1', name: 'Alice' }, { id: 'kickbob001', name: 'Bob' }]);

  const url = '/api/admin/rooms/kick-room/members/kickbob001';
  assert.strictEqual((await json('DELETE', url, {}, { cookie: '' })).status, 401, 'admins only');
  const closed = new Promise((r) => bob.ws.once('close', (code) => r(code)));
  assert.strictEqual((await json('DELETE', url, {})).status, 200);
  assert.deepStrictEqual(await bob.ws.next(), { type: 'error', code: 'kicked', message: 'The administrator removed you from the room.' });
  assert.strictEqual(await closed, 4001);
  assert.deepStrictEqual(await alice.ws.next(), { type: 'peer-left', id: 'kickbob001' });
  assert.deepStrictEqual((await room()).online, ['Alice']);
  assert.strictEqual((await json('DELETE', url, {})).status, 404, 'not in the room any more');
  assert.strictEqual((await json('DELETE', '/api/admin/rooms/no-such-room/members/kickalice1', {})).status, 404);
  assert.strictEqual((await json('DELETE', '/api/admin/rooms/kick-room/members/kickalice1/extra', {})).status, 404);
  // It does not keep anyone out: with the password, Bob can join again.
  const again = await join('kick-room', 'kp', 'kickbob001', 'Bob');
  assert.strictEqual(again.welcome.type, 'welcome');
  for (const c of [alice, again]) c.ws.close();
  assert.strictEqual((await json('DELETE', '/api/admin/rooms/kick-room', {})).status, 200);
});

test('drive: removing a member ends its Drive access at once (token, cookie, open download); the others keep theirs', { timeout: 60000 }, async () => {
  const F = 'REVOKE_FOLDER_0001', BIG = 'REVOKE_BIG_FILE_01';
  google.addFolder(F, 'Revoke folder');
  google.addFile(BIG, 'big.mp4', F, bytes(48 * MiB), 'video/mp4');
  const s = await spawnServer({ GOOGLE_SERVICE_ACCOUNT: google.writeAccount(keyDir), GOOGLE_API_BASE: google.url, DRIVE_DEBUG: '1' });
  const ck = await adminCookie(s.base);
  const admin = (method, p, body) => fetch(s.base + p, { method, headers: { 'content-type': 'application/json', cookie: ck }, body: body && JSON.stringify(body) });
  assert.strictEqual((await admin('POST', '/api/admin/rooms', { name: 'revoke', password: 'rp' })).status, 201);
  assert.strictEqual((await admin('PUT', '/api/admin/rooms/revoke/drive', { link: F })).status, 200);
  const member = async (id) => {
    const ws = await wsAt(s.base);
    ws.sendJson({ type: 'join', room: 'revoke', id, name: id, password: 'rp', secret: secretOf(id) });
    const welcome = await nextMatching(ws, (m) => m.type === 'welcome');
    return { ws, token: welcome.drive.token };
  };
  const status = (token, headers = {}) => fetch(`${s.base}/api/rooms/revoke/drive/folders/root`, { headers: { ...(token && { Authorization: `Bearer ${token}` }), ...headers } }).then((r) => r.status);
  const streams = async () => (await (await fetch(`${s.base}/api/debug/drive-streams`)).json()).streams;

  const alice = await member('revokealic1');
  const mallory = await member('revokemall1');
  assert.notStrictEqual(alice.token, mallory.token, 'every member has its own token');
  // Mallory's native-playback cookie, and a whole-film download she does not read, so it stays open.
  const session = await fetch(`${s.base}/api/rooms/revoke/drive/session`, { method: 'POST', headers: { Authorization: `Bearer ${mallory.token}` } });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  assert.strictEqual(await status(null, { cookie }), 200);
  const download = await new Promise((resolve, reject) => {
    const req = http.get(`${s.base}/api/rooms/revoke/drive/files/${BIG}`, { headers: { Authorization: `Bearer ${mallory.token}` } }, (res) => {
      res.pause();
      resolve({ req, res });
    });
    req.on('error', reject);
  });
  download.req.on('error', () => {}); // the server cuts it below
  download.res.on('error', () => {});
  assert.strictEqual(download.res.statusCode, 200);
  assert.strictEqual(await streams(), 1);

  assert.strictEqual((await admin('DELETE', '/api/admin/rooms/revoke/members/revokemall1', {})).status, 200);
  for (let i = 0; i < 50 && (await streams()) > 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(await streams(), 0, 'her download was cut');
  assert.strictEqual(await status(mallory.token), 401, 'her token');
  assert.strictEqual(await status(null, { cookie }), 401, 'her cookie');
  assert.strictEqual((await fetch(`${s.base}/api/rooms/revoke/drive/session`, { method: 'POST', headers: { Authorization: `Bearer ${mallory.token}` } })).status, 401, 'no new cookie from it');
  assert.strictEqual(await status(alice.token), 200, 'Alice keeps hers');

  // Removing does not keep anyone out: joining again with the password gives a new token that works; the old one stays void.
  const back = await member('revokemall1');
  assert.strictEqual(await status(back.token), 200);
  assert.strictEqual(await status(mallory.token), 401);
  download.req.destroy();
  for (const ws of [alice.ws, back.ws]) ws.close();
  s.stop();
});
