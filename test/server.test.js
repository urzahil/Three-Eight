// Server tests: admin API, room passwords, routing and signaling relay.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = 45000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc, dataDir, cookie = '';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_PASSWORD: 'admin-pw', DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + '/healthz')).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  proc.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
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
  assert.deepStrictEqual(rooms.map((r) => [r.name, r.hasPassword]), [['MovieNight', true], ['open-room', false]]);
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
