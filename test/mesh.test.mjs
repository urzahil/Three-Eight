// The chunk protocol of the data channel: strict reassembly of incoming messages, backpressure when sending.
import test from 'node:test';
import assert from 'node:assert/strict';
import './browser-globals.mjs';
import { Reassembler, ChunkSender, MAX_QUEUED, routeVideo, screenBudget } from '../public/assets/js/mesh.js';

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
