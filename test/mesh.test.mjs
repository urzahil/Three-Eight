// The chunk protocol of the data channel: strict reassembly of incoming messages, backpressure when sending.
import test from 'node:test';
import assert from 'node:assert/strict';
import './browser-globals.mjs';
import { Reassembler, ChunkSender, MAX_QUEUED, routeVideo, screenBudget, Mesh, MAX_OFFERS_PER_PEER, OFFER_WINDOW_MS, usableIceServers } from '../public/assets/js/mesh.js';

const CHUNK = 12 * 1024;
const chunk = (mid, i, n, d = 'x') => ({ type: '_chunk', mid, i, n, d });

/** Split like the sender does, to feed a Reassembler. */
function split(s, mid = 'm1') {
  const n = Math.ceil(s.length / CHUNK);
  return Array.from({ length: n }, (_, i) => chunk(mid, i, n, s.slice(i * CHUNK, (i + 1) * CHUNK)));
}

test('chunks arriving in any order are put together', () => {
  const s = 'abcdefghij'.repeat(5000);
  const parts = split(s);
  assert.equal(parts.length, 5);
  const r = new Reassembler();
  let out = null;
  for (const i of [3, 0, 4, 1, 2]) out = r.add(parts[i]) ?? out;
  assert.equal(out, s);
  assert.equal(r.parts.size, 0);
  assert.equal(r.total, 0);
});

test('a repeated chunk is ignored', () => {
  const r = new Reassembler();
  assert.equal(r.add(chunk('a', 0, 2, 'he')), null);
  assert.equal(r.add(chunk('a', 0, 2, 'XX')), null);
  assert.equal(r.add(chunk('a', 1, 2, 'llo')), 'hello');
});

test('i out of range or not an integer is rejected, and a huge index cannot complete a message', () => {
  const r = new Reassembler();
  assert.equal(r.add(chunk('a', 0, 2)), null);
  assert.equal(r.add(chunk('a', 1e9, 2)), null); // would have made got === n over a sparse array
  assert.equal(r.parts.has('a'), false);
  for (const i of [-1, 2, 1.5, '1', NaN, Infinity, null, undefined]) {
    assert.equal(r.add(chunk('b', i, 2)), null, String(i));
    assert.equal(r.parts.has('b'), false);
  }
});

test('n must be an integer above 1 and within the chunk limit', () => {
  const r = new Reassembler();
  for (const n of [0, 1, -3, 2.5, '2', NaN, Infinity, 1e9, 1025, undefined]) {
    assert.equal(r.add(chunk('a', 0, n)), null, String(n));
    assert.equal(r.parts.size, 0);
  }
  assert.equal(r.add(chunk('a', 0, 1024)), null);
  assert.equal(r.parts.size, 1);
});

test('mid must be a short string', () => {
  const r = new Reassembler();
  for (const mid of [5, '', null, 'x'.repeat(33), {}]) assert.equal(r.add(chunk(mid, 0, 2)), null);
  assert.equal(r.parts.size, 0);
  r.add(chunk('x'.repeat(32), 0, 2));
  assert.equal(r.parts.size, 1);
});

test('a chunk with another n drops the whole message', () => {
  const r = new Reassembler();
  r.add(chunk('a', 0, 3, 'aa'));
  r.add(chunk('a', 1, 3, 'bb'));
  assert.equal(r.add(chunk('a', 2, 2, 'cc')), null);
  assert.equal(r.parts.size, 0);
  assert.equal(r.total, 0);
  // the same id may start over cleanly
  assert.equal(r.add(chunk('a', 0, 2, 'x')), null);
  assert.equal(r.add(chunk('a', 1, 2, 'y')), 'xy');
});

test('an oversized or non-string d is rejected', () => {
  const r = new Reassembler();
  assert.equal(r.add(chunk('a', 0, 2, 'ok')), null);
  assert.equal(r.add(chunk('a', 1, 2, 'x'.repeat(CHUNK + 1))), null);
  assert.equal(r.parts.has('a'), false);
  for (const d of [5, null, undefined, ['x'], {}]) assert.equal(r.add(chunk('b', 0, 2, d)), null);
  assert.equal(r.parts.size, 0);
  assert.equal(r.add(chunk('c', 0, 2, 'x'.repeat(CHUNK))), null);
  assert.equal(r.parts.size, 1);
});

test('the number of concurrent messages is capped, oldest first', () => {
  const r = new Reassembler();
  for (let k = 0; k < 20; k++) r.add(chunk('m' + k, 0, 2, 'x'));
  assert.equal(r.parts.size, 12);
  assert.equal(r.parts.has('m0'), false);
  assert.equal(r.parts.has('m19'), true);
});

test('the total buffered size is capped, oldest first', () => {
  const r = new Reassembler();
  const full = 'x'.repeat(CHUNK);
  // 12 messages of 1000 full chunks each would be ~144 MiB: only what fits in the budget is kept.
  for (let k = 0; k < 12; k++) for (let i = 0; i < 1000; i++) r.add(chunk('m' + k, i, 1024, full));
  assert.ok(r.total <= 24 * 1024 * 1024, `total ${r.total}`);
  assert.equal(r.parts.has('m0'), false);
  assert.equal(r.parts.has('m11'), true);
  let sum = 0;
  for (const a of r.parts.values()) sum += a.chars;
  assert.equal(sum, r.total);
});

test('a message of the full 12 MiB cap is still accepted', () => {
  const r = new Reassembler();
  // n is at most 1024 chunks of 12 KiB = exactly the 12 MiB cap.
  const full = 'x'.repeat(CHUNK);
  let out = null;
  for (let i = 0; i < 1024; i++) out = r.add(chunk('big', i, 1024, full)) ?? out;
  assert.equal(out.length, 1024 * CHUNK);
  assert.equal(r.parts.size, 0);
});

test('unfinished messages time out (lazily and by sweep)', () => {
  const r = new Reassembler();
  r.add(chunk('old', 0, 2, 'a'), 1000);
  r.add(chunk('new', 0, 2, 'b'), 20000);
  r.sweep(31001);
  assert.deepEqual([...r.parts.keys()], ['new']);
  // lazily on the next chunk: 'new' is now stale, so its second chunk starts a fresh assembly instead of finishing it
  assert.equal(r.add(chunk('new', 1, 2, 'c'), 60000), null);
  assert.equal(r.parts.get('new').got, 1);
  // each chunk renews the timer
  r.add(chunk('slow', 0, 3, 'a'), 0);
  r.add(chunk('slow', 1, 3, 'b'), 25000);
  assert.equal(r.add(chunk('slow', 2, 3, 'c'), 50000), 'abc');
});

test('a subtitle-sized (5 MiB) message round-trips through sender and reassembler', () => {
  const text = 'Dialogue "line" \\ with\nescapes é\n'.repeat(Math.ceil((5 * 1024 * 1024) / 30)).slice(0, 5 * 1024 * 1024);
  const json = JSON.stringify({ type: 'sub-data', text });
  assert.ok(json.length > 5 * 1024 * 1024 && json.length < 12 * 1024 * 1024);
  const dc = fakeChannel();
  const sender = new ChunkSender(dc);
  const r = new Reassembler();
  let out = null;
  dc.onsend = (s) => {
    const m = JSON.parse(s);
    assert.ok(s.length < CHUNK * 2); // JSON escaping of the chunk stays small
    out = r.add(m) ?? out;
  };
  assert.equal(sender.send(json), true);
  while (sender.queue.length) {
    assert.ok(dc.bufferedAmount <= 1024 * 1024 + CHUNK * 2);
    dc.drain();
    sender.pump();
  }
  assert.equal(out, json);
  assert.equal(JSON.parse(out).text, text);
});

// ---- sender ---------------------------------------------------------------

function fakeChannel() {
  const dc = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    sent: [],
    onsend: null,
    send(s) {
      dc.sent.push(s);
      dc.bufferedAmount += s.length;
      dc.onsend?.(s);
    },
    drain() {
      dc.bufferedAmount = 0;
    },
  };
  return dc;
}

test('a short message goes out at once', () => {
  const dc = fakeChannel();
  assert.equal(new ChunkSender(dc).send('{"type":"a"}'), true);
  assert.deepEqual(dc.sent, ['{"type":"a"}']);
});

test('a short message waits in the queue while the channel is over the high-water mark', () => {
  const dc = fakeChannel();
  const s = new ChunkSender(dc);
  dc.bufferedAmount = 1024 * 1024 + 1; // stalled: the browser buffer is full
  assert.equal(s.send('{"type":"a"}'), true);
  assert.deepEqual(dc.sent, []);
  assert.equal(s.queue.length, 1);
  dc.drain(); // bufferedamountlow
  s.pump();
  assert.deepEqual(dc.sent, ['{"type":"a"}']);
  assert.equal(s.queue.length, 0);
  assert.equal(s.queued, 0);
  assert.equal(s.send('{"type":"b"}'), true); // recovered: straight out again
  assert.deepEqual(dc.sent, ['{"type":"a"}', '{"type":"b"}']);
});

test('short messages on a stalled channel overflow the bounded queue instead of growing the browser buffer', () => {
  const dc = fakeChannel();
  const s = new ChunkSender(dc, 1000);
  let overflows = 0;
  s.onoverflow = () => overflows++;
  dc.bufferedAmount = 1024 * 1024 + 1;
  const msg = '{"type":"state","t":12345}'; // 26 chars
  let ok = 0;
  for (let k = 0; k < 100; k++) if (s.send(msg)) ok++;
  assert.equal(dc.sent.length, 0);
  assert.ok(overflows >= 1);
  assert.ok(s.queued <= 1000);
  assert.ok(ok < 100);
});

test('a short message whose send throws is reported, not thrown', () => {
  const dc = fakeChannel();
  const s = new ChunkSender(dc);
  dc.send = () => {
    const err = new Error('send queue full');
    err.name = 'OperationError';
    throw err;
  };
  assert.equal(s.send('{"type":"a"}'), false);
  assert.equal(s.queue.length, 0);
});

test('queued messages are dropped when the channel closes, and nothing is sent after', () => {
  const dc = fakeChannel();
  const s = new ChunkSender(dc);
  dc.bufferedAmount = 1024 * 1024 + 1;
  s.send('{"type":"a"}');
  s.send('{"type":"b"}');
  dc.readyState = 'closed';
  s.clear(); // what the channel's onclose does
  dc.drain();
  s.pump();
  assert.deepEqual(dc.sent, []);
  assert.equal(s.queued, 0);
  assert.equal(s.send('{"type":"c"}'), false);
});

test('send reports a closed channel', () => {
  const dc = fakeChannel();
  dc.readyState = 'closed';
  assert.equal(new ChunkSender(dc).send('x'), false);
  assert.equal(dc.sent.length, 0);
});

test('a long message is held back by the high-water mark and later messages queue behind it', () => {
  const dc = fakeChannel();
  const s = new ChunkSender(dc);
  assert.ok(dc.bufferedAmountLowThreshold > 0);
  const big = 'y'.repeat(CHUNK * 300); // 3.6 MiB
  assert.equal(s.send(big), true);
  const first = dc.sent.length;
  assert.ok(first > 1 && first < 300, `sent ${first}`);
  assert.ok(dc.bufferedAmount <= 1024 * 1024 + CHUNK * 2);
  assert.equal(s.send('{"type":"after"}'), true);
  assert.equal(dc.sent.includes('{"type":"after"}'), false); // behind the chunks, not in front of them
  while (s.queue.length) {
    dc.drain();
    s.pump();
  }
  const mids = dc.sent.slice(0, -1).map((x) => JSON.parse(x));
  assert.deepEqual(mids.map((m) => m.i), mids.map((_, k) => k)); // in order
  assert.equal(new Set(mids.map((m) => m.mid)).size, 1);
  assert.equal(dc.sent.at(-1), '{"type":"after"}');
});

test('clear() empties the queue; a failing channel does not throw', () => {
  const dc = fakeChannel();
  const s = new ChunkSender(dc);
  s.send('y'.repeat(CHUNK * 300));
  s.clear();
  dc.drain();
  const n = dc.sent.length;
  s.pump();
  assert.equal(dc.sent.length, n);
  dc.send = () => {
    throw new Error('closed');
  };
  s.send('y'.repeat(CHUNK * 3));
  assert.equal(s.queue.length, 0);
});

test('the queue is bounded: a peer that stops reading triggers onoverflow instead of endless buffering', () => {
  assert.ok(MAX_QUEUED >= 2 * 12 * 1024 * 1024, 'room for a full-size subtitle message and more');
  const dc = fakeChannel();
  dc.bufferedAmount = 8 * 1024 * 1024; // the other side has stopped reading: the channel's buffer stays full
  const s = new ChunkSender(dc, CHUNK * 100);
  let overflows = 0;
  s.onoverflow = () => overflows++;
  assert.equal(s.send('y'.repeat(CHUNK * 60)), true);
  assert.equal(s.send('{"type":"small"}'), true, 'queues behind the long one');
  assert.ok(s.queued > 0 && s.queued <= CHUNK * 100);
  assert.equal(overflows, 0);
  assert.equal(s.send('z'.repeat(CHUNK * 50)), false, 'would go past the limit');
  assert.equal(overflows, 1);
  assert.equal(s.queue.length, 0, 'the queue is emptied');
  assert.equal(s.queued, 0);
  // Once the channel drains, the accounting is right again: a full queue drains back to zero.
  dc.drain();
  assert.equal(s.send('y'.repeat(CHUNK * 90)), true);
  while (s.queue.length) {
    dc.drain();
    s.pump();
  }
  assert.equal(s.queued, 0);
  assert.equal(overflows, 1);
});

// ---- Screen sharing: which incoming video is the camera, which the screen --------------------------------

test('the camera is the video in the same stream as the audio; another stream is the screen', () => {
  const cam = { id: 'cam' }, scr = { id: 'scr' };
  assert.deepEqual(routeVideo('A', new Map([['A', cam]])), { camera: cam, screen: null });
  assert.deepEqual(routeVideo('A', new Map([['A', cam], ['S', scr]])), { camera: cam, screen: scr });
  // The screen's media section can be negotiated first (a link built during a share): order does not matter.
  assert.deepEqual(routeVideo('A', new Map([['S', scr], ['A', cam]])), { camera: cam, screen: scr });
  // Only a screen so far (the camera's track has not arrived yet).
  assert.deepEqual(routeVideo('A', new Map([['S', scr]])), { camera: null, screen: scr });
});

test('without audio, the first video is taken for the camera', () => {
  const cam = { id: 'cam' }, scr = { id: 'scr' };
  assert.deepEqual(routeVideo(null, new Map()), { camera: null, screen: null });
  assert.deepEqual(routeVideo(null, new Map([['A', cam]])), { camera: cam, screen: null });
  assert.deepEqual(routeVideo(null, new Map([['A', cam], ['S', scr]])), { camera: cam, screen: scr });
});

test('a shared screen gets more upload than a camera, less with more peers and in low-power mode', () => {
  const kbps = [1, 2, 3, 4, 5, 8].map((n) => screenBudget(n, false) / 1000);
  assert.deepEqual(kbps, [2500, 1800, 1000, 1000, 600, 600]);
  for (const n of [1, 2, 4, 8]) assert.ok(screenBudget(n, true) <= 800 * 1000);
});

test('offers: a peer gets at most MAX_OFFERS_PER_PEER answered per window, others are not affected', () => {
  const realNow = Date.now;
  const realWarn = console.warn;
  let t = 1_000_000;
  let warnings = 0;
  Date.now = () => t;
  console.warn = () => { warnings++; };
  try {
    const mesh = Object.create(Mesh.prototype);
    mesh._offers = new Map();
    const taken = Array.from({ length: MAX_OFFERS_PER_PEER + 5 }, () => mesh._takeOffer('pushy'));
    assert.equal(taken.filter(Boolean).length, MAX_OFFERS_PER_PEER);
    assert.deepEqual(taken.slice(MAX_OFFERS_PER_PEER), Array(5).fill(false));
    assert.equal(warnings, 1, 'said once, not for every ignored offer');
    assert.equal(mesh._takeOffer('calm'), true, 'another peer has its own allowance');
    t += OFFER_WINDOW_MS - 1;
    assert.equal(mesh._takeOffer('pushy'), false, 'still within the window');
    t += 1;
    assert.equal(mesh._takeOffer('pushy'), true, 'the window has passed');
  } finally {
    Date.now = realNow;
    console.warn = realWarn;
  }
});

// ---- signaling: which connection of theirs a signal belongs to ---------------------------------------------

function signalMesh() {
  globalThis.MediaStream ??= class MediaStream {};
  const signaling = new EventTarget();
  const mesh = new Mesh(signaling, 'me-me-me-me', []);
  const log = [];
  const fakePeer = (id, remoteConn) => ({
    id, remoteConn, open: true, polite: false, dc: { readyState: 'open' }, pc: { signalingState: 'stable', remoteDescription: {} },
    handleSignal(data) { log.push({ peer: this, data }); },
  });
  mesh._rebuildLimited = (id) => {
    log.push({ rebuilt: id });
    const p = fakePeer(id, null);
    mesh.peers.set(id, p);
    return p;
  };
  const signal = (from, data) => signaling.dispatchEvent(Object.assign(new Event('signal'), { detail: { from, data } }));
  return { mesh, log, fakePeer, signal };
}

test('an offer from a rebuilt connection of theirs gets a fresh link, though ours still looks open', () => {
  const { mesh, log, fakePeer, signal } = signalMesh();
  const old = fakePeer('peer-bbbbbbbb', 'connA1');
  mesh.peers.set(old.id, old);
  const offer = { type: 'offer', sdp: 'v=0' };
  signal(old.id, { description: offer, conn: 'connA1' }); // a renegotiation of the same connection
  assert.equal(log.at(-1).peer, old);
  signal(old.id, { description: offer, conn: 'connA2' }); // they rebuilt (network change, reload)
  assert.deepEqual(log.at(-2), { rebuilt: old.id });
  assert.notEqual(log.at(-1).peer, old);
  assert.equal(log.at(-1).data.conn, 'connA2');
});

test('an older client sends no conn id: offers are judged as before', () => {
  const { mesh, log, fakePeer, signal } = signalMesh();
  const p = fakePeer('peer-bbbbbbbb', 'connA1');
  mesh.peers.set(p.id, p);
  signal(p.id, { description: { type: 'offer', sdp: 'v=0' } });
  assert.equal(log.length, 1);
  assert.equal(log[0].peer, p, 'no rebuild: the link is open and the offer carries no id');
});

test('ICE candidates meant for another connection of theirs are dropped; others are delivered', () => {
  const { mesh, log, fakePeer, signal } = signalMesh();
  const p = fakePeer('peer-bbbbbbbb', 'connA2');
  mesh.peers.set(p.id, p);
  signal(p.id, { candidate: { candidate: 'old' }, conn: 'connA1' });
  assert.equal(log.length, 0);
  signal(p.id, { candidate: { candidate: 'new' }, conn: 'connA2' });
  signal(p.id, { candidate: { candidate: 'legacy' } });
  assert.deepEqual(log.map((l) => l.data.candidate.candidate), ['new', 'legacy']);
  signal(p.id, { candidate: { candidate: 'odd' }, conn: { not: 'a string' } }); // not a valid id: treated as none
  assert.equal(log.at(-1).data.conn, undefined);
});

// ---- ICE servers the browser refuses -------------------------------------------------------------------------

test('usableIceServers: a server the browser refuses is left out, instead of every call failing', () => {
  const realPc = globalThis.RTCPeerConnection;
  const realWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  // Like Chromium: a URL without its scheme, or a TURN server without credentials, fails the whole configuration.
  globalThis.RTCPeerConnection = class {
    constructor({ iceServers }) {
      for (const s of iceServers) {
        if (s.urls.some((u) => !/^(stuns?|turns?):/.test(u))) throw new SyntaxError('not a valid stun or turn URL');
        if (s.urls.some((u) => u.startsWith('turn')) && (!s.username || !s.credential)) throw new DOMException('empty username', 'InvalidAccessError');
      }
    }
    close() {}
  };
  try {
    const stun = { urls: ['stun:stun.example.com:3478'] };
    const good = [stun, { urls: ['turn:t.example.com'], username: 'u', credential: 'c' }];
    assert.equal(usableIceServers(good), good, 'all accepted: the same list');
    assert.equal(warned, 0);
    assert.deepEqual(usableIceServers([stun, { urls: ['turn:t.example.com'], username: '', credential: '' }]), [stun]);
    assert.deepEqual(usableIceServers([{ urls: ['stun.example.com:3478'] }, stun]), [stun]);
    assert.equal(warned, 2);
    assert.deepEqual(usableIceServers(null), [], 'not a list: none');
    assert.deepEqual(usableIceServers([]), []);
  } finally {
    globalThis.RTCPeerConnection = realPc;
    console.warn = realWarn;
  }
});
