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
const { parseDriveFolder } = require('../server/store');
const { startFakeGoogle } = require('./fake-google');

const PORT = 45000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc, dataDir, cookie = '', google, keyDir;
const extraProcs = [];

async function waitUp(base) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

/** Another server instance (own data dir), e.g. without a service account. Returns { base, log, stop }. */
async function spawnServer(env) {
  const port = PORT + 1000 + Math.floor(Math.random() * 1000);
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
  return { base, out, stop };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-'));
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-key-'));
  google = await startFakeGoogle();
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
