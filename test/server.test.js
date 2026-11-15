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
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_PASSWORD: 'admin-pw', DATA_DIR: dir, GOOGLE_SERVICE_ACCOUNT: '', ...env },
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
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_PASSWORD: 'admin-pw', DATA_DIR: dataDir,
      GOOGLE_SERVICE_ACCOUNT: google.writeAccount(keyDir), GOOGLE_API_BASE: google.url,
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
  const res = await json('POST', '/api/admin/login', { password: 'admin-pw' });
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

async function join(room, password, id, name = 'Tester') {
  const ws = await wsClient();
  ws.sendJson({ type: 'join', room, id, name, password });
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
  assert.deepStrictEqual(Object.keys(claims).sort(), ['e', 'r', 'v']);
  assert.strictEqual(claims.r, 'drive-a');
  assert(Math.abs(claims.e - (Date.now() + 12 * 3600 * 1000)) < 60000, 'expires in 12 hours');

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
  assert.strictEqual((await fetch(`${BASE}${folders}?t=${encodeURIComponent(tokA)}`)).status, 200, 't query parameter');
  // Room A's token on room B's URLs, and the other way round.
  assert.strictEqual((await api('/api/rooms/drive-b/drive/folders/root', tokA)).status, 401);
  assert.strictEqual((await api(files('drive-b', D.movieB), tokA)).status, 401);
  assert.strictEqual((await api(files('drive-a', D.movie), tokB)).status, 401);
  assert.strictEqual((await api('/api/rooms/drive-b/drive/folders/root', tokB)).status, 200);
  // Other methods
  assert.strictEqual((await api(folders, tokA, { method: 'POST' })).status, 405);
  assert.strictEqual((await api('/api/rooms/drive-a/drive/nothing/x1234567890', tokA)).status, 404);
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

test('drive: without a service account there is no drive field and no endpoint', async () => {
  const s = await spawnServer({});
  const login = await fetch(s.base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'admin-pw' }) });
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
      env: { ...process.env, PORT: String(await freePort()), HOST: '127.0.0.1', ADMIN_PASSWORD: 'x', DATA_DIR: dir, GOOGLE_SERVICE_ACCOUNT: '' },
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
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'admin-pw' }) });
  return login.headers.get('set-cookie').split(';')[0];
}

test('room password limit: a burst of wrong passwords cannot get past it, and open rooms cost nothing', async () => {
  const s = await spawnServer({ TRUST_PROXY: '1', MAX_ROOM_SIZE: '100' });
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

// ---- welcome.resumed ----------------------------------------------------------------------------------------------
test('welcome says whether the join resumed the previous connection', async () => {
  assert.strictEqual((await json('POST', '/api/admin/rooms', { name: 'resume-room', password: '' })).status, 201);
  const a = await wsClient();
  a.sendJson({ type: 'join', room: 'resume-room', id: 'resumer001', name: 'A' });
  const first = await a.next();
  assert.strictEqual(first.resumed, false);
  const b = await wsClient();
  b.sendJson({ type: 'join', room: 'resume-room', id: 'resumer001', name: 'A' });
  const second = await b.next();
  assert.strictEqual(second.resumed, true, 'took over the live entry of the same id');
  const other = await wsClient();
  other.sendJson({ type: 'join', room: 'resume-room', id: 'resumer002', name: 'B' });
  assert.strictEqual((await other.next()).resumed, false);
  // After a clean leave there is nothing to resume.
  b.sendJson({ type: 'leave' });
  await other.next(); // peer-left
  const c = await wsClient();
  c.sendJson({ type: 'join', room: 'resume-room', id: 'resumer001', name: 'A' });
  assert.strictEqual((await c.next()).resumed, false);
  for (const ws of [a, b, c, other]) ws.close();
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
  const big = await call('/api/admin/rooms', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(40000) }) }).then((r) => r.status, () => 400);
  assert.strictEqual(big, 400);
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

// ---- Drive cache setting ---------------------------------------------------------------------------------------------
test('DRIVE_CACHE_MB below the minimum is raised, with a warning', async () => {
  const env = (mb) => ({ GOOGLE_SERVICE_ACCOUNT: google.writeAccount(keyDir), GOOGLE_API_BASE: google.url, DRIVE_CACHE_MB: mb });
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
