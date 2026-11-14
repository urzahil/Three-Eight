// Unit tests for sharing film pieces between viewers (public/assets/js/player/swarm.js).
// Peers are simulated: every Swarm gets a fake mesh, and a small in-memory network delivers frames between them.
// Run with: node --test test/swarm.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCues, MAX_CUES, Swarm, T, DENIED, HEADER, MAX_FRAME, MAX_PAYLOAD, assignFetcher, decodeFrame, encodeFrame, filmKey, keyId, mergeRanges, parseHave, movieKeys } from '../public/assets/js/player/swarm.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = 256 * 1024; // piece size used here (the real one is 1 MiB)
const BS = 64 * 1024; // block size of the RemoteFile under test

function makeData(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 131 + (i >> 9) * 7) & 255;
  return b;
}

// ---- a tiny network of fake meshes ----------------------------------------------------------------------------
class FakeMesh extends EventTarget {
  constructor(net, id) {
    super();
    this.net = net;
    this.selfId = id;
    this.peers = new Map();
    this.framesOut = []; // decoded frames this node sent: { to, f }
    this.dropped = [];
  }

  send(id, msg) {
    return this.net.json(this.selfId, id, msg);
  }

  broadcast(msg) {
    for (const id of this.peers.keys()) this.send(id, msg);
  }

  sendFilm(id, buf, tag) {
    const p = this.peers.get(id);
    if (!p || !p.filmOpen) return false;
    this.framesOut.push({ to: id, f: decodeFrame(buf), tag });
    this.net.film(this.selfId, id, buf);
    return true;
  }

  dropFilm(id, tag) {
    this.dropped.push([id, tag]);
  }

  out(type) {
    return this.framesOut.filter((x) => x.f?.type === type);
  }
}

class Net {
  constructor() {
    this.nodes = new Map();
    this.silent = new Set(); // ids that never receive film frames (a peer that does not answer)
  }

  node(id, opts = {}) {
    const mesh = new FakeMesh(this, id);
    const swarm = new Swarm(mesh, { selfId: id, pieceSize: P, firstByteMs: 60, minRate: 4 * 1024 * 1024, advertiseMs: 0, ...opts });
    this.nodes.set(id, { mesh, swarm });
    return { id, mesh, swarm };
  }

  connect(...ids) {
    for (const a of ids) {
      for (const b of ids) if (a !== b) this.nodes.get(a).mesh.peers.set(b, { id: b, name: b, filmOpen: true });
    }
  }

  json(from, to, msg) {
    const n = this.nodes.get(to);
    if (!n) return false;
    const copy = JSON.parse(JSON.stringify(msg));
    setImmediate(() => n.mesh.dispatchEvent(new CustomEvent('message', { detail: { peer: { id: from }, msg: copy } })));
    return true;
  }

  film(from, to, buf) {
    const n = this.nodes.get(to);
    if (!n || this.silent.has(to)) return;
    const copy = new Uint8Array(buf).buffer;
    setImmediate(() => n.mesh.dispatchEvent(new CustomEvent('film', { detail: { peer: { id: from }, data: copy } })));
  }

  closeAll() {
    for (const { swarm } of this.nodes.values()) swarm.destroy();
  }
}

/** A server serving `data` with Range, counting requests. `delay` makes it slow; aborting is observable. */
function makeServer(data, { delay = 0 } = {}) {
  const calls = [];
  const fn = async (start, end, signal) => {
    const call = { start, end, aborted: false };
    calls.push(call);
    signal?.addEventListener('abort', () => { call.aborted = true; });
    if (delay) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    }
    return new Response(data.subarray(start, end + 1), { status: 206 });
  };
  fn.calls = calls;
  return fn;
}

const driveFile = (swarm, data, server, o = {}) => swarm.openRemote({ name: 'm.mkv', size: data.length, drive: { id: 'DRIVEFILE_0001' }, server, blockSize: BS, readAhead: false, minRequest: BS, retries: 0, ...o });
const peerFile = (swarm, data, o = {}) => swarm.openRemote({ name: 'm.mkv', size: data.length, blockSize: BS, readAhead: false, minRequest: BS, retries: 0, networkRetryDelay: 1, ...o });
const read = async (rf, a, b) => Buffer.from(await rf.slice(a, b).arrayBuffer());

// ---- pure functions ----------------------------------------------------------------------------------------------
test('assignFetcher: streamers sorted by id, piece mod N, the same from every point of view', () => {
  assert.equal(assignFetcher(0, []), null);
  const ids = ['carol', 'alice', 'bob'];
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((p) => assignFetcher(p, ids)), ['alice', 'bob', 'carol', 'alice', 'bob', 'carol', 'alice']);
  for (const perm of [['alice', 'bob', 'carol'], ['bob', 'carol', 'alice']]) {
    for (let p = 0; p < 20; p++) assert.equal(assignFetcher(p, perm), assignFetcher(p, ids));
  }
  assert.deepEqual(ids, ['carol', 'alice', 'bob'], 'the argument is not reordered');
  assert.equal(assignFetcher(7, ['solo']), 'solo');
});

test('film keys: Drive id, or size; a Drive movie is also named by its size', () => {
  assert.equal(filmKey({ drive: { id: 'ABC' }, size: 5 }), 'd:ABC');
  assert.equal(filmKey({ size: 5 }), 's:5');
  assert.deepEqual(movieKeys({ size: 5, drive: { id: 'ABCDEFGHIJ' } }), ['d:ABCDEFGHIJ', 's:5']);
  assert.deepEqual(movieKeys({ size: 5 }), ['s:5']);
  assert.notEqual(keyId('d:A'), keyId('d:B'));
});

test('frames: encode, decode, and the largest message is 64 KiB', () => {
  const payload = new Uint8Array(MAX_PAYLOAD).fill(7);
  const buf = encodeFrame({ type: T.DATA, req: 65535, key: 0xdeadbeef, piece: 123456, offset: 987654, payload });
  assert.equal(buf.length, MAX_FRAME);
  assert.equal(HEADER, 16);
  const f = decodeFrame(buf.buffer);
  assert.deepEqual({ type: f.type, req: f.req, key: f.key, piece: f.piece, offset: f.offset, len: f.payload.length }, { type: T.DATA, req: 65535, key: 0xdeadbeef, piece: 123456, offset: 987654, len: MAX_PAYLOAD });
  for (const type of [T.WANT, T.CANCEL]) assert.equal(decodeFrame(encodeFrame({ type, req: 1, key: 2, piece: 3 })).piece, 3);
  assert.equal(decodeFrame(encodeFrame({ type: T.DENY, req: 1, key: 2, piece: 3, flags: DENIED.BUSY })).flags, DENIED.BUSY);
  // a view into a bigger buffer decodes too
  const big = new Uint8Array(100);
  big.set(encodeFrame({ type: T.WANT, req: 9, key: 1, piece: 4 }), 10);
  assert.equal(decodeFrame(big.subarray(10, 26)).req, 9);
});

test('frames: anything malformed is rejected', () => {
  const ok = { req: 1, key: 2, piece: 3 };
  const bad = [
    new Uint8Array(15), // shorter than the header
    new ArrayBuffer(0),
    'text',
    null,
    encodeFrame({ type: 0, ...ok }),
    encodeFrame({ type: 9, ...ok }),
    encodeFrame({ type: T.DATA, ...ok }), // no payload
    encodeFrame({ type: T.DATA, ...ok, payload: new Uint8Array(MAX_PAYLOAD + 1) }), // over 64 KiB
    encodeFrame({ type: T.DATA, ...ok, flags: 1, payload: new Uint8Array(4) }),
    encodeFrame({ type: T.DATA, ...ok, offset: 0xfffffff0, payload: new Uint8Array(4) }),
    encodeFrame({ type: T.WANT, ...ok, payload: new Uint8Array(1) }),
    encodeFrame({ type: T.WANT, ...ok, offset: 5 }),
    encodeFrame({ type: T.CANCEL, ...ok, payload: new Uint8Array(1) }),
    encodeFrame({ type: T.DENY, ...ok }), // no reason
    encodeFrame({ type: T.DENY, ...ok, flags: 9 }),
    encodeFrame({ type: T.WANT, ...ok, piece: 0xffffffff }),
    new Uint8Array(MAX_FRAME + 1),
  ];
  for (const b of bad) assert.equal(decodeFrame(b?.buffer && b instanceof Uint8Array ? b : b), null, String(b?.length));
});

test('film-have: validation and range merging', () => {
  assert.deepEqual(parseHave({ key: 'd:ABCDEFGHIJ', local: false, ranges: [[3, 4], [0, 1], [2, 2]], via: 'drive' }), { key: 'd:ABCDEFGHIJ', local: false, ranges: [[0, 4]], via: 'drive', subs: [] });
  assert.deepEqual(parseHave({ key: null }), { key: '', local: false, ranges: [], via: '', subs: [] });
  for (const m of [null, 'x', {}, { key: 'x:1', local: false, ranges: [] }, { key: 's:12', local: 'yes', ranges: [] }, { key: 's:12', local: true, ranges: [[2, 1]] }, { key: 's:12', local: true, ranges: [[-1, 1]] }, { key: 's:12', local: true, ranges: [[0.5, 1]] }, { key: 's:12', local: true, ranges: 'all' }, { key: 's:12', local: true, ranges: new Array(65).fill([0, 0]) }, { key: 's:12', local: true, ranges: [[0, 1e12]] }, { key: 'd:short', local: false, ranges: [] }]) {
    assert.equal(parseHave(m), null, JSON.stringify(m)?.slice(0, 60));
  }
  const many = Array.from({ length: 100 }, (_, i) => [i * 10, i * 10 + 1]);
  const merged = mergeRanges(many, 32);
  assert.equal(merged.length, 32);
  assert.deepEqual([merged[0][0], merged.at(-1)[1]], [0, 991], 'still spans everything');
  assert.deepEqual(mergeRanges([[5, 6], [0, 2], [3, 4]], 8), [[0, 6]]);
  // the smallest gaps are closed first
  assert.deepEqual(mergeRanges([[0, 0], [2, 2], [100, 100]], 2), [[0, 2], [100, 100]]);
});

// ---- reading through the swarm ---------------------------------------------------------------------------------------
test('peer with a whole copy: pieces are requested from it and spread over the holders (piece mod count)', async () => {
  const net = new Net();
  const data = makeData(4 * P + 1000); // 5 pieces, the last one short
  const file = new Blob([data]);
  const a = net.node('a'); // the receiver
  const h1 = net.node('h1');
  const h2 = net.node('h2');
  net.connect('a', 'h1', 'h2');
  h1.swarm.openLocal(file);
  h2.swarm.openLocal(file);
  const rf = peerFile(a.swarm, data);
  rf.swarm.activate();
  await sleep(30);
  assert.deepEqual(a.swarm.holders({ size: data.length }), ['h1', 'h2']);
  assert.deepEqual(a.swarm.holders({ size: data.length + 1 }), [], 'a movie of another size has no holders');
  assert((await read(rf, 0, data.length)).equals(data), 'whole file, read through the swarm, is intact');
  const asked = (id) => a.mesh.out(T.WANT).filter((x) => x.to === id).map((x) => x.f.piece).sort();
  assert.deepEqual(asked('h1'), [0, 2, 4], 'sorted holders [h1, h2]: piece mod 2');
  assert.deepEqual(asked('h2'), [1, 3]);
  assert.equal(a.swarm.stats.server, 0);
  // the pieces are in the block cache now: nothing is asked twice, and the receiver advertises them
  const before = a.mesh.out(T.WANT).length;
  await read(rf, 100, 3 * P);
  assert.equal(a.mesh.out(T.WANT).length, before);
  assert.deepEqual(rf.cachedPieces(P), [[0, 4]]);
  net.closeAll();
});

test('a range inside a piece is cut from the whole piece; an odd range across pieces too', async () => {
  const net = new Net();
  const data = makeData(3 * P + 5);
  const a = net.node('a');
  const h = net.node('h');
  net.connect('a', 'h');
  h.swarm.openLocal(new Blob([data]));
  const rf = peerFile(a.swarm, data);
  rf.swarm.activate();
  await sleep(30);
  assert((await read(rf, P + 70000, P + 70010)).equals(data.subarray(P + 70000, P + 70010)));
  assert((await read(rf, P - 10, 2 * P + 10)).equals(data.subarray(P - 10, 2 * P + 10)));
  assert((await read(rf, data.length - 3, data.length)).equals(data.subarray(data.length - 3)));
  net.closeAll();
});

test('a holder that turned sharing off denies; the next holder is tried, and a film with no holder left fails', async () => {
  const net = new Net();
  const data = makeData(2 * P);
  const a = net.node('a');
  const h1 = net.node('h1');
  const h2 = net.node('h2');
  net.connect('a', 'h1', 'h2');
  h1.swarm.openLocal(new Blob([data]));
  h2.swarm.openLocal(new Blob([data]));
  await sleep(20);
  const rf = peerFile(a.swarm, data);
  rf.swarm.activate();
  h1.swarm.share = false; // changed its mind, the advertisement has not reached us yet
  assert((await read(rf, 0, P)).equals(data.subarray(0, P)), 'piece 0 was asked from h1, denied, then h2 answered');
  assert.deepEqual(h1.mesh.out(T.DENY).map((x) => x.f.flags), [DENIED.UNAVAILABLE]);
  h1.swarm.setShare(false); // now it tells everybody
  await sleep(20);
  assert.deepEqual(a.swarm.holders({ size: data.length }), ['h2'], 'h1 now advertises nothing');
  h2.swarm.setShare(false);
  await sleep(20);
  assert.deepEqual(a.swarm.holders({ size: data.length }), []);
  await assert.rejects(read(rf, P, 2 * P), /Nobody is sharing/);
  net.closeAll();
});

test('Drive film, nobody local: the fetcher of piece p is streamers[p mod N]; the others ask it, it fetches once from the server', async () => {
  const net = new Net();
  const data = makeData(4 * P);
  const server = makeServer(data);
  const nodes = ['alice', 'bob', 'carol'].map((id) => net.node(id));
  net.connect('alice', 'bob', 'carol');
  const files = nodes.map((n) => driveFile(n.swarm, data, server));
  files.forEach((f) => f.swarm.activate());
  await sleep(30); // everybody has advertised that it streams this film
  // alice, bob and carol all read piece 0..3 at about the same time
  const results = await Promise.all(files.map((f) => read(f, 0, 4 * P)));
  results.forEach((r) => assert(r.equals(data)));
  const fetched = server.calls.map((c) => c.start / P).sort();
  assert.deepEqual(fetched, [0, 1, 2, 3], `each piece came from the server once: ${JSON.stringify(server.calls)}`);
  // piece 0 -> alice, 1 -> bob, 2 -> carol, 3 -> alice
  const fetcherOf = (p) => ['alice', 'bob', 'carol'][p % 3];
  for (const n of nodes) {
    const asked = n.mesh.out(T.WANT).map((x) => `${x.f.piece}:${x.to}`).sort();
    const expected = [0, 1, 2, 3].filter((p) => fetcherOf(p) !== n.id).map((p) => `${p}:${fetcherOf(p)}`).sort();
    assert.deepEqual(asked, expected, n.id);
  }
  assert.equal(nodes[0].swarm.stats.server + nodes[1].swarm.stats.server + nodes[2].swarm.stats.server, 4 * P);
  net.closeAll();
});

test('a peer that already has the piece cached is asked before the assignment is used', async () => {
  const net = new Net();
  const data = makeData(2 * P);
  const server = makeServer(data);
  const a = net.node('a');
  const b = net.node('b');
  net.connect('a', 'b');
  const fb = driveFile(b.swarm, data, server);
  fb.swarm.activate();
  await read(fb, 0, 2 * P); // b has everything (and advertises it)
  await sleep(30);
  assert.equal(server.calls.length, 2);
  const fa = driveFile(a.swarm, data, server);
  fa.swarm.activate();
  await sleep(30);
  assert((await read(fa, 0, 2 * P)).equals(data));
  assert.equal(server.calls.length, 2, 'a got both pieces from b, whatever the assignment says');
  assert.equal(a.mesh.out(T.WANT).length, 2);
  net.closeAll();
});

test('fallback to the server: a peer that never answers is skipped after the first-byte timeout, and not asked again for a while', async () => {
  const net = new Net();
  const data = makeData(4 * P);
  const server = makeServer(data);
  const a = net.node('alice');
  const b = net.node('bob');
  net.connect('alice', 'bob');
  const fa = driveFile(a.swarm, data, server);
  const fb = driveFile(b.swarm, data, server);
  fa.swarm.activate();
  fb.swarm.activate();
  await sleep(30);
  net.silent.add('bob'); // bob stops answering (a frozen tab)
  const t0 = Date.now();
  assert((await read(fa, P, 2 * P)).equals(data.subarray(P, 2 * P)), 'piece 1 is bob\'s; alice falls back to the server');
  const took = Date.now() - t0;
  assert(took >= 50 && took < 1500, `waited about the first-byte timeout: ${took} ms`);
  assert.deepEqual(server.calls.map((c) => c.start), [P]);
  assert.equal(a.swarm.stats.fallbacks, 1);
  assert.equal(a.mesh.out(T.CANCEL).length, 1, 'the want was cancelled');
  // bob is marked bad: the next piece that is his goes straight to the server, without waiting
  const t1 = Date.now();
  await read(fa, 3 * P, 4 * P); // piece 3 -> streamers [alice, bob][3 mod 2] = bob
  assert(Date.now() - t1 < 40, 'no second wait');
  assert.equal(a.mesh.out(T.WANT).length, 1, 'bob was not asked again');
  assert.deepEqual(server.calls.map((c) => c.start), [P, 3 * P]);
  net.closeAll();
});

test('fallback: a peer that disconnects while we wait for its piece', async () => {
  const net = new Net();
  const data = makeData(2 * P);
  const server = makeServer(data);
  const a = net.node('alice', { firstByteMs: 5000 });
  const b = net.node('bob');
  net.connect('alice', 'bob');
  const fa = driveFile(a.swarm, data, server);
  const fb = driveFile(b.swarm, data, server);
  fa.swarm.activate();
  fb.swarm.activate();
  await sleep(30);
  net.silent.add('bob');
  const pending = read(fa, P, 2 * P); // bob's piece
  await sleep(20);
  a.mesh.dispatchEvent(new CustomEvent('peer-removed', { detail: { peer: { id: 'bob' } } }));
  assert((await pending).equals(data.subarray(P, 2 * P)));
  assert.equal(server.calls.length, 1);
  net.closeAll();
});

test('a peer that stalls half way is abandoned too', async () => {
  const net = new Net();
  const data = makeData(2 * P);
  const server = makeServer(data);
  const a = net.node('alice');
  const b = net.node('bob');
  net.connect('alice', 'bob');
  const fa = driveFile(a.swarm, data, server);
  const fb = driveFile(b.swarm, data, server);
  fb.swarm.activate();
  fa.swarm.activate();
  await sleep(30);
  // bob "answers" with only the first frame of piece 1, then goes quiet
  const orig = net.film.bind(net);
  let sent = 0;
  net.film = (from, to, buf) => {
    const f = decodeFrame(buf);
    if (from === 'bob' && f?.type === T.DATA && sent++ >= 1) return;
    orig(from, to, buf);
  };
  const t0 = Date.now();
  assert((await read(fa, P, 2 * P)).equals(data.subarray(P, 2 * P)));
  assert(sent >= 2 && Date.now() - t0 < 1500);
  assert.equal(server.calls.length, 2, 'bob fetched it for alice (it never arrived whole), then alice fetched it herself');
  net.closeAll();
});

test('serving: from the cache when the whole piece is cached, otherwise one server fetch shared by all askers', async () => {
  const net = new Net();
  const data = makeData(4 * P);
  const server = makeServer(data, { delay: 30 });
  const f = net.node('f');
  const r1 = net.node('r1');
  const r2 = net.node('r2');
  net.connect('f', 'r1', 'r2');
  const ff = driveFile(f.swarm, data, server);
  ff.swarm.activate();
  ff.inject(0, new Uint8Array(data.subarray(0, P))); // piece 0 is cached at f
  assert.equal(server.calls.length, 0);
  // r1 and r2 want pieces 0 and 1 from f (frames sent by hand, as a peer would)
  const want = (from, piece, req, key = keyId('d:DRIVEFILE_0001')) => net.film(from, 'f', encodeFrame({ type: T.WANT, req, key, piece }));
  const got = new Map(); // `${to}:${piece}` -> bytes
  for (const n of [r1, r2]) {
    n.mesh.addEventListener('film', (e) => {
      const fr = decodeFrame(e.detail.data);
      if (fr?.type === T.DATA) {
        const k = `${n.id}:${fr.piece}`;
        const cur = got.get(k) || Buffer.alloc(0);
        assert.equal(fr.offset, cur.length, 'frames arrive in order');
        got.set(k, Buffer.concat([cur, Buffer.from(fr.payload)]));
      }
    });
  }
  want('r1', 0, 1);
  await sleep(40);
  assert.equal(server.calls.length, 0, 'piece 0 came from the cache');
  assert(got.get('r1:0').equals(data.subarray(0, P)));
  want('r1', 1, 2);
  want('r2', 1, 1);
  await sleep(150);
  assert.equal(server.calls.length, 1, 'piece 1 was fetched from the server once for both');
  assert(got.get('r1:1').equals(data.subarray(P, 2 * P)));
  assert(got.get('r2:1').equals(data.subarray(P, 2 * P)));
  assert.equal(f.swarm.stats.served, 3 * P);
  // it is cached afterwards: asking again does not fetch
  got.delete('r2:1');
  want('r2', 1, 2);
  await sleep(30);
  assert(got.get('r2:1').equals(data.subarray(P, 2 * P)));
  assert.equal(server.calls.length, 1);
  // every message was at most 64 KiB
  assert(f.mesh.framesOut.every((x) => x.f.payload.length <= MAX_PAYLOAD));
  assert(f.mesh.out(T.DATA).length >= 3 * Math.floor(P / MAX_PAYLOAD));
  net.closeAll();
});

test('serving limits: at most maxPerPeer pieces in flight for a friend, then BUSY; unknown film or piece', async () => {
  const net = new Net();
  const data = makeData(6 * P);
  const server = makeServer(data, { delay: 100 });
  const f = net.node('f', { maxPerPeer: 2 });
  const r = net.node('r');
  net.connect('f', 'r');
  driveFile(f.swarm, data, server).swarm.activate();
  const key = keyId('d:DRIVEFILE_0001');
  const send = (type, piece, req, k = key) => net.film('r', 'f', encodeFrame({ type, req, key: k, piece }));
  send(T.WANT, 0, 1);
  send(T.WANT, 1, 2);
  send(T.WANT, 2, 3);
  await sleep(20);
  assert.deepEqual(f.mesh.out(T.DENY).map((x) => [x.f.req, x.f.flags]), [[3, DENIED.BUSY]]);
  send(T.WANT, 3, 4, keyId('d:SOMEOTHERFILE')); // another film: denied, not served
  send(T.WANT, 99, 5); // no such piece: dropped silently
  await sleep(20);
  assert.deepEqual(f.mesh.out(T.DENY).map((x) => [x.f.req, x.f.flags]), [[3, DENIED.BUSY], [4, DENIED.UNAVAILABLE]]);
  assert(!f.mesh.framesOut.some((x) => x.f.req === 5));
  await sleep(250);
  assert.equal(server.calls.length, 2);
  // a satisfied job frees its slot
  send(T.WANT, 4, 6);
  await sleep(150);
  assert.equal(f.mesh.out(T.DATA).filter((x) => x.f.req === 6).length > 0, true);
  net.closeAll();
});

test('cancellation: a want that is no longer needed is cancelled at the holder, which stops its work', async () => {
  const net = new Net();
  const data = makeData(2 * P);
  const server = makeServer(data, { delay: 500 });
  const f = net.node('f');
  const r = net.node('r', { firstByteMs: 5000 });
  net.connect('f', 'r');
  const ff = driveFile(f.swarm, data, server);
  ff.swarm.activate();
  const fr = driveFile(r.swarm, data, makeServer(data));
  fr.swarm.activate();
  await sleep(30);
  // r reads piece 0 (f's: sorted [f, r], 0 mod 2) and aborts the read (a seek)
  const ctrl = new AbortController();
  const pending = fr.request(0, P - 1, ctrl.signal, {});
  await sleep(40);
  assert.equal(f.mesh.out(T.DATA).length, 0);
  assert.equal(server.calls.length, 1, 'f started fetching');
  ctrl.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await sleep(30);
  assert.equal(r.mesh.out(T.CANCEL).length, 1, 'cancel frame sent');
  assert.equal(server.calls[0].aborted, true, 'f aborted its server fetch');
  assert.equal(f.mesh.out(T.DATA).length, 0, 'and sent nothing');
  assert.equal(f.swarm.film.jobs.size, 0);
  assert.deepEqual(f.mesh.dropped.length >= 1, true, 'queued frames of the job were dropped');
  // closing the film cancels what is outstanding too
  const pending2 = fr.request(P, 2 * P - 1, undefined, {}); // piece 1 -> r itself (server)
  const pending3 = pending2.catch(() => 'x');
  fr.close();
  await pending3;
  assert.equal(r.swarm.film, null);
  net.closeAll();
});

test('a read that is aborted while waiting for a slot or a shared fetch leaves the other readers alone', async () => {
  const net = new Net();
  const data = makeData(2 * P);
  const server = makeServer(data, { delay: 50 });
  const a = net.node('a');
  const rf = driveFile(a.swarm, data, server);
  rf.swarm.activate();
  const c1 = new AbortController();
  const c2 = new AbortController();
  const p1 = rf.swarm.request(0, P - 1, c1.signal, {});
  const p2 = rf.swarm.request(0, P - 1, c2.signal, {});
  c1.abort();
  await assert.rejects(p1, { name: 'AbortError' });
  const res = await p2;
  assert.equal(res.status, 206);
  assert.equal(server.calls.length, 1, 'one fetch for both readers');
  assert.equal(server.calls[0].aborted, false, 'the other reader still needed it');
  net.closeAll();
});

test('incoming frames are validated: wrong film, wrong peer, wrong piece, out-of-order or oversized data are dropped', async () => {
  const net = new Net();
  const data = makeData(2 * P);
  const a = net.node('a', { firstByteMs: 300 });
  const h = net.node('h');
  const evil = net.node('evil');
  net.connect('a', 'h', 'evil');
  h.swarm.openLocal(new Blob([data]));
  net.silent.add('h'); // h's real answers never arrive: we hand-craft frames instead
  const rf = peerFile(a.swarm, data);
  rf.swarm.activate();
  await sleep(30);
  const pending = read(rf, 0, P).then((b) => b, (e) => e);
  await sleep(10);
  const want = a.mesh.out(T.WANT)[0].f;
  const deliver = (from, fr) => a.mesh.dispatchEvent(new CustomEvent('film', { detail: { peer: { id: from }, data: encodeFrame(fr).buffer } }));
  const piece = data.subarray(0, P);
  const base = { type: T.DATA, req: want.req, key: want.key, piece: 0 };
  deliver('evil', { ...base, offset: 0, payload: new Uint8Array(100) }); // not the peer we asked
  deliver('h', { ...base, key: keyId('d:OTHERFILE01'), offset: 0, payload: new Uint8Array(100) }); // another film
  deliver('h', { ...base, req: want.req + 1, offset: 0, payload: new Uint8Array(100) }); // not our request
  deliver('h', { ...base, piece: 1, offset: 0, payload: new Uint8Array(100) }); // another piece
  deliver('h', { ...base, offset: 5, payload: new Uint8Array(100) }); // not the next offset
  deliver('h', { ...base, offset: 0, payload: new Uint8Array(MAX_PAYLOAD) }); // fine so far (a valid first frame)
  deliver('h', { ...base, offset: 100, payload: new Uint8Array(100) }); // not the next offset: the previous frame was longer
  deliver('h', { ...base, offset: MAX_PAYLOAD, payload: new Uint8Array(MAX_PAYLOAD * 5) }); // too long for a frame
  a.mesh.dispatchEvent(new CustomEvent('film', { detail: { peer: { id: 'h' }, data: new Uint8Array(7).buffer } })); // garbage
  assert(a.swarm.stats.dropped >= 6, `dropped ${a.swarm.stats.dropped}`);
  // The piece never completed from those frames (only one valid, partial frame got through), so it fails
  // after the stall timeout rather than being handed to the player with wrong bytes.
  void piece;
  const err = await pending;
  assert(err instanceof Error, 'no garbage was accepted as the piece');
  assert.equal(a.mesh.out(T.CANCEL).length >= 1, true);
  net.closeAll();
});

test('a complete piece arrives only when all of it did; its length is checked', async () => {
  const net = new Net();
  const data = makeData(P + 1234); // the last piece is shorter
  const a = net.node('a', { firstByteMs: 2000 });
  const h = net.node('h');
  net.connect('a', 'h');
  h.swarm.openLocal(new Blob([data]));
  await sleep(30);
  const rf = peerFile(a.swarm, data);
  rf.swarm.activate();
  const last = await read(rf, P, P + 1234);
  assert(last.equals(data.subarray(P)));
  assert.equal(h.mesh.out(T.DATA).reduce((n, x) => n + x.f.payload.length, 0), 1234, 'the short last piece was sent as exactly its length');
  // a frame that would run past the end of the short piece is dropped
  const bogus = a.swarm.stats.dropped;
  a.mesh.dispatchEvent(new CustomEvent('film', { detail: { peer: { id: 'h' }, data: encodeFrame({ type: T.DATA, req: 1, key: keyId('s:' + data.length), piece: 1, offset: 1200, payload: new Uint8Array(100) }).buffer } }));
  assert.equal(a.swarm.stats.dropped, bogus + 1);
  net.closeAll();
});

test('advertising: sent to new peers, on change (throttled), and cleared when the film closes', async () => {
  const net = new Net();
  const data = makeData(2 * P);
  const a = net.node('a', { advertiseMs: 80 });
  const b = net.node('b');
  net.connect('a', 'b');
  const seen = [];
  b.mesh.addEventListener('message', (e) => seen.push(e.detail.msg));
  a.swarm.openLocal(new Blob([data]));
  await sleep(120);
  assert.deepEqual(seen.map((m) => [m.key, m.local]), [[`s:${data.length}`, true]]);
  assert.deepEqual(b.swarm.holders({ size: data.length }), ['a']);
  // a new peer gets it as soon as its channel opens
  const c = net.node('c');
  net.connect('a', 'b', 'c');
  a.mesh.dispatchEvent(new CustomEvent('channel-open', { detail: { peer: { id: 'c' } } }));
  await sleep(20);
  assert.deepEqual(c.swarm.holders({ size: data.length }), ['a']);
  // many changes in a row make at most one message per throttle period
  seen.length = 0;
  for (let i = 0; i < 20; i++) {
    a.swarm.setShare(i % 2 === 0 ? false : true);
    a.swarm.setShare(true);
  }
  await sleep(200);
  assert(seen.length <= 2, `throttled: ${seen.length}`);
  a.swarm.closeFilm();
  await sleep(150);
  assert.equal(seen.at(-1).key, null);
  assert.deepEqual(b.swarm.holders({ size: data.length }), []);
  net.closeAll();
});

test('the film channel of a peer that is not open is not used', async () => {
  const net = new Net();
  const data = makeData(P);
  const server = makeServer(data);
  const a = net.node('a');
  const h = net.node('h');
  net.connect('a', 'h');
  h.swarm.openLocal(new Blob([data]));
  await sleep(30);
  a.mesh.peers.get('h').filmOpen = false;
  const rf = driveFile(a.swarm, data, server);
  rf.swarm.activate();
  assert((await read(rf, 0, P)).equals(data));
  assert.equal(a.mesh.out(T.WANT).length, 0);
  assert.equal(server.calls.length, 1, 'straight to the server');
  net.closeAll();
});

test('small reads (embedded subtitles) of a Drive film go straight to the server, exactly the bytes asked for', async () => {
  const net = new Net();
  const data = makeData(3 * P);
  const server = makeServer(data);
  const a = net.node('a');
  const rf = driveFile(a.swarm, data, server);
  rf.swarm.activate();
  const lite = rf.lite();
  const got = Buffer.from(await lite.slice(P + 100, P + 100 + 5000).arrayBuffer());
  assert(got.equals(data.subarray(P + 100, P + 100 + 5000)));
  assert.equal(server.calls.length, 1);
  assert(server.calls[0].end - server.calls[0].start + 1 <= 2 * BS, 'a block or two, not a piece');
  net.closeAll();
});

test('server errors are handed to RemoteFile unchanged (its explain() words them); a closed film still reads from the server', async () => {
  const net = new Net();
  const data = makeData(P);
  const a = net.node('a');
  const server = async () => new Response(JSON.stringify({ error: 'quota used up', permanent: true }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  const explain = async (res) => Object.assign(new Error((await res.json()).error), { permanent: true });
  const rf = driveFile(a.swarm, data, server, { explain });
  rf.swarm.activate();
  await assert.rejects(read(rf, 0, 100), (err) => err.message === 'quota used up' && err.permanent === true);
  // switching to native playback: the film stops being shared but the file keeps working
  const ok = makeServer(data);
  const rf2 = driveFile(a.swarm, data, ok);
  rf2.swarm.activate();
  rf2.swarm.dispose();
  assert((await read(rf2, 10, 50)).equals(data.subarray(10, 50)));
  assert.equal(a.swarm.film, null);
  net.closeAll();
});

// ---- relaying: friends that stream pass pieces on, so the origin sends about one copy -------------------------------
test('planner: a streamer with the piece cached, else the assigned fetcher, else the origin', async () => {
  const net = new Net();
  const data = makeData(6 * P);
  const me = net.node('m');
  for (const id of ['a', 'z', 's']) net.node(id);
  net.connect('m', 'a', 'z', 's');
  const rf = peerFile(me.swarm, data);
  rf.swarm.activate();
  const film = me.swarm.film;
  const have = (id, o) => me.swarm.have.set(id, { key: `s:${data.length}`, local: false, ranges: [], via: 'peers', ...o });
  me.swarm.have.set('s', { key: `s:${data.length}`, local: true, ranges: [[0, 5]], via: 'file' });
  // streamers [a, m, z] (sorted, with me): piece p -> p mod 3; when it is me the plan has no friend (go to the origin)
  have('a');
  have('z');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((p) => me.swarm._plan(film, p).peers), [['a'], [], ['z'], ['a'], [], ['z']]);
  assert.equal(me.swarm._plan(film, 0).origin, true);
  // a streamer that has the piece cached comes first, whoever the fetcher is; several: piece mod count
  have('z', { ranges: [[2, 3]] });
  assert.deepEqual(me.swarm._plan(film, 1).peers, [], 'not cached anywhere: the fetcher is me');
  assert.deepEqual(me.swarm._plan(film, 3).peers, ['z']);
  have('a', { ranges: [[3, 3]] });
  assert.deepEqual(me.swarm._plan(film, 3).peers, ['z'], 'both have 3: sorted [a, z], 3 mod 2 = 1');
  assert.deepEqual(me.swarm._plan(film, 2).peers, ['z']);
  // the sharer is never a relay: a local holder is not among the streamers
  assert(![0, 1, 2, 3, 4, 5].some((p) => me.swarm._plan(film, p).peers.includes('s')));
  // no holders and nobody has it: no origin
  me.swarm.have.delete('s');
  assert.deepEqual(me.swarm._plan(film, 4), { peers: [], origin: false });
  net.closeAll();
});

test('one sharer, three streamers: the sharer sends about one copy; everybody gets exact bytes', async () => {
  const net = new Net();
  const data = makeData(8 * P + 777);
  const sharer = net.node('sharer');
  const names = ['bob', 'carol', 'dave'];
  const nodes = names.map((id) => net.node(id));
  net.connect('sharer', ...names);
  sharer.swarm.openLocal(new Blob([data]));
  const files = nodes.map((n) => peerFile(n.swarm, data, { retries: 2 }));
  files.forEach((f) => f.swarm.activate());
  await sleep(40);
  const all = await Promise.all(files.map((f) => read(f, 0, data.length)));
  all.forEach((r) => assert(r.equals(data)));
  const served = sharer.swarm.stats.served;
  assert(served <= data.length * 1.4, `the sharer sent ${served} bytes for a film of ${data.length}`);
  assert(nodes.reduce((n, x) => n + x.swarm.stats.peers, 0) >= 3 * data.length, 'every streamer received the whole film');
  // streamers asked each other for some pieces (relaying), and the relays only ever asked the sharer
  const wantsToStreamers = nodes.flatMap((n) => n.mesh.out(T.WANT)).filter((x) => names.includes(x.to));
  assert(wantsToStreamers.length > 0, 'pieces were relayed between streamers');
  net.closeAll();
});

test('a fetcher that is asked for a piece goes to the origin only, never to another streamer', async () => {
  const net = new Net();
  const data = makeData(3 * P);
  const s = net.node('s');
  const b = net.node('b');
  const c = net.node('c');
  net.connect('s', 'b', 'c');
  s.swarm.openLocal(new Blob([data]));
  const fb = peerFile(b.swarm, data);
  fb.swarm.activate();
  const fc = peerFile(c.swarm, data);
  fc.swarm.activate();
  await sleep(40);
  // c asks b for piece 1 (b has nothing): b must fetch it from s, and ask nobody else
  net.film('c', 'b', encodeFrame({ type: T.WANT, req: 7, key: keyId(`s:${data.length}`), piece: 1 }));
  await sleep(60);
  assert.deepEqual(b.mesh.out(T.WANT).map((x) => [x.to, x.f.piece]), [['s', 1]]);
  assert.deepEqual(c.mesh.out(T.WANT).length, 0);
  assert.equal(b.mesh.out(T.DATA).filter((x) => x.to === 'c').reduce((n, x) => n + x.f.payload.length, 0), P);
  net.closeAll();
});

test('single streamer: the friend is the fetcher and asks the sharer directly', async () => {
  const net = new Net();
  const data = makeData(3 * P);
  const s = net.node('s');
  const b = net.node('b');
  net.connect('s', 'b');
  s.swarm.openLocal(new Blob([data]));
  const fb = peerFile(b.swarm, data);
  fb.swarm.activate();
  await sleep(30);
  assert((await read(fb, 0, data.length)).equals(data));
  assert.deepEqual(b.mesh.out(T.WANT).map((x) => x.to), ['s', 's', 's']);
  assert.equal(s.swarm.stats.served, data.length);
  net.closeAll();
});

test('the fetcher dies: re-plan without it, the next fetcher gets the piece from the origin once', async () => {
  const net = new Net();
  const data = makeData(4 * P);
  const s = net.node('s');
  const b = net.node('b');
  const c = net.node('c');
  net.connect('s', 'b', 'c');
  s.swarm.openLocal(new Blob([data]));
  const fb = peerFile(b.swarm, data);
  const fc = peerFile(c.swarm, data);
  fb.swarm.activate();
  fc.swarm.activate();
  await sleep(40);
  net.silent.add('b'); // b freezes
  const t0 = Date.now();
  // streamers [b, c]: piece 0 is b's. c waits for b, then plans again: c is the fetcher and asks the sharer.
  assert((await read(fc, 0, P)).equals(data.subarray(0, P)));
  assert(Date.now() - t0 < 1500);
  assert.deepEqual(c.mesh.out(T.WANT).map((x) => x.to), ['b', 's']);
  assert.equal(c.swarm.stats.fallbacks, 1);
  // the sharer lost nothing by it: each piece was sent once
  assert.equal(s.swarm.stats.served, P);
  net.closeAll();
});

test('Drive film with a local holder: the holder is the origin; the server only when the holder fails', async () => {
  const net = new Net();
  const data = makeData(3 * P);
  const server = makeServer(data);
  const h = net.node('h');
  const a = net.node('a');
  net.connect('h', 'a');
  h.swarm.openLocal(new Blob([data]));
  const fa = driveFile(a.swarm, data, server);
  fa.swarm.activate();
  await sleep(40);
  assert((await read(fa, 0, P)).equals(data.subarray(0, P)));
  assert.equal(server.calls.length, 0, 'the holder was the origin');
  assert.equal(a.mesh.out(T.WANT)[0].to, 'h');
  net.silent.add('h');
  assert((await read(fa, P, 2 * P)).equals(data.subarray(P, 2 * P)));
  assert.deepEqual(server.calls.map((c) => c.start), [P], 'then the server');
  assert.equal(a.swarm.stats.fallbacks, 1);
  net.closeAll();
});

test('the sharer leaves: what streamers cached keeps flowing, the rest fails with the usual message', async () => {
  const net = new Net();
  const data = makeData(4 * P);
  const s = net.node('s');
  const b = net.node('b');
  const c = net.node('c');
  net.connect('s', 'b', 'c');
  s.swarm.openLocal(new Blob([data]));
  const fb = peerFile(b.swarm, data);
  const fc = peerFile(c.swarm, data);
  fb.swarm.activate();
  fc.swarm.activate();
  await sleep(40);
  await read(fb, 0, 2 * P); // b has pieces 0 and 1
  await sleep(40); // ... and has told c
  for (const n of [b, c]) n.mesh.dispatchEvent(new CustomEvent('peer-removed', { detail: { peer: { id: 's' } } }));
  b.mesh.peers.delete('s');
  c.mesh.peers.delete('s');
  assert((await read(fc, 0, 2 * P)).equals(data.subarray(0, 2 * P)), 'c gets the cached pieces from b');
  await assert.rejects(read(fc, 3 * P, 4 * P), /Could not get this part|Nobody is sharing/);
  net.closeAll();
});

// ---- embedded subtitle cues between viewers ----------------------------------------------------------------------------
const CUES = [{ start: 1, end: 4, text: 'Hello' }, { start: 20, end: 25, text: 'Twenty seconds', top: true }];

test('film-have: the list of extracted subtitle tracks is validated', () => {
  const have = (subs) => parseHave({ key: 's:123', local: true, ranges: [[0, 1]], via: 'file', subs });
  assert.deepEqual(have(['e1', 'e12']).subs, ['e1', 'e12']);
  assert.deepEqual(have(['e1', 'x', 5, '../../a', 'e', 'e1234567']).subs, ['e1'], 'only track ids, nothing else');
  assert.deepEqual(have(undefined).subs, []);
  assert.equal(have(new Array(200).fill('e1')).subs.length, 64);
});

test('sanitizeCues: bounds and shape', () => {
  assert.deepEqual(sanitizeCues(CUES), CUES);
  assert.deepEqual(sanitizeCues([{ start: 1, end: 2, text: 'x', top: 'yes', extra: 1 }]), [{ start: 1, end: 2, text: 'x' }], 'only known fields, top only when true');
  for (const bad of [null, 'x', {}, [null], [{ start: 1, end: 1, text: 'x' }], [{ start: -1, end: 1, text: 'x' }], [{ start: 1, end: 2, text: 5 }], [{ start: NaN, end: 2, text: 'x' }], [{ start: 1, end: Infinity, text: 'x' }], [{ start: 1, end: 2e7, text: 'x' }], [{ start: 1, end: 2, text: 'x'.repeat(5000) }], new Array(MAX_CUES + 1).fill({ start: 1, end: 2, text: 'x' })]) {
    assert.equal(sanitizeCues(bad), null, JSON.stringify(bad)?.slice(0, 50));
  }
  const big = Array.from({ length: 3000 }, (_, i) => ({ start: i, end: i + 1, text: 'y'.repeat(3000) })); // 9 MB of text
  assert.equal(sanitizeCues(big), null, 'total text is capped');
});

/** Two viewers of the same Drive film; `with` has the extracted tracks. */
async function cueSetup({ lists = ['e3'], cueTimeoutMs = 80 } = {}) {
  const net = new Net();
  const data = makeData(2 * P);
  const server = makeServer(data);
  const a = net.node('a', { cueTimeoutMs });
  const b = net.node('b', { cueTimeoutMs });
  net.connect('a', 'b');
  const fa = driveFile(a.swarm, data, server);
  const fb = driveFile(b.swarm, data, server);
  fa.swarm.activate();
  fb.swarm.activate();
  b.swarm.setSubSource({ list: () => lists, get: () => CUES, accepts: (t) => /^e\d+$/.test(t) });
  a.swarm.setSubSource({ list: () => [], get: () => null, accepts: (t) => t === 'e3' });
  await sleep(40);
  return { net, a, b };
}

test('cues: a viewer asks the one that advertises the track and gets validated cues', async () => {
  const { net, a, b } = await cueSetup();
  assert.deepEqual(a.swarm.have.get('b').subs, ['e3']);
  assert.equal(a.swarm.hasCueHolder('e3'), true);
  assert.equal(a.swarm.hasCueHolder('e4'), false);
  assert.equal(await a.swarm.fetchCues('e4'), null, 'nobody has it: no request is sent');
  const got = await a.swarm.fetchCues('e3');
  assert.deepEqual(got, CUES);
  assert.equal(b.mesh.framesOut.length, 0, 'cues travel on the JSON channel, not the film channel');
  net.closeAll();
});

test('cues: unsolicited, wrong-sender, wrong-film or oversized answers are ignored; the next peer is asked after a timeout', async () => {
  const { net, a, b } = await cueSetup();
  const deliver = (from, msg) => a.mesh.dispatchEvent(new CustomEvent('message', { detail: { peer: { id: from }, msg } }));
  const key = a.swarm.film.key;
  deliver('b', { type: 'sub-cues', key, track: 'e3', cues: CUES }); // nobody asked
  assert.equal(a.swarm.cueReqs.size, 0);
  net.silent.add('b');
  b.swarm.subSrc = null; // b will not answer
  const p = a.swarm.fetchCues('e3');
  await sleep(10);
  deliver('c', { type: 'sub-cues', key, track: 'e3', cues: CUES }); // not the peer asked
  deliver('b', { type: 'sub-cues', key: 'd:OTHERFILE001', track: 'e3', cues: CUES }); // another film
  deliver('b', { type: 'sub-cues', key, track: 'e3', cues: new Array(MAX_CUES + 1).fill({ start: 1, end: 2, text: 'x' }) }); // too many
  deliver('b', { type: 'sub-cues', key, track: 'e3', cues: [{ start: 5, end: 1, text: 'x' }] }); // nonsense
  assert.equal(await p, null, 'nothing valid arrived: no cues, after the timeout');
  assert(a.swarm.stats.dropped >= 2);
  net.closeAll();
});

test('cues: asks local holders first, then moves on when one does not answer', async () => {
  const net = new Net();
  const data = makeData(2 * P);
  const a = net.node('a', { cueTimeoutMs: 80 });
  const l = net.node('z-local', { cueTimeoutMs: 80 });
  const s = net.node('b-streamer', { cueTimeoutMs: 80 });
  net.connect('a', 'z-local', 'b-streamer');
  l.swarm.openLocal(new Blob([data]));
  const fa = peerFile(a.swarm, data);
  fa.swarm.activate();
  const fs_ = peerFile(s.swarm, data);
  fs_.swarm.activate();
  const src = { list: () => ['e3'], get: () => CUES, accepts: () => true };
  l.swarm.setSubSource(src);
  s.swarm.setSubSource(src);
  a.swarm.setSubSource({ list: () => [], get: () => null, accepts: () => true });
  await sleep(40);
  const asked = [];
  for (const n of [l, s]) n.mesh.addEventListener('message', (e) => { if (e.detail.msg.type === 'sub-cues-req') asked.push(n.id); });
  assert.deepEqual(await a.swarm.fetchCues('e3'), CUES);
  assert.deepEqual(asked, ['z-local'], 'the local holder was asked first (and alone)');
  l.swarm.subSrc = null; // it stops answering (but still advertises)
  asked.length = 0;
  assert.deepEqual(await a.swarm.fetchCues('e3'), CUES);
  assert.deepEqual(asked, ['z-local', 'b-streamer'], 'then the next one');
  // sharing off: the local holder neither advertises nor answers
  l.swarm.subSrc = src;
  l.swarm.setShare(false);
  await sleep(30);
  assert.equal(a.swarm.have.has('z-local'), false);
  net.closeAll();
});
