// MseEngine's wake-up bookkeeping (no MediaSource needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import './browser-globals.mjs';

globalThis.window ??= {}; // mse.js reads window.MediaSource when it is loaded
const { MseEngine } = await import('../public/assets/js/player/mse.js');

test('waitWake: a wait that times out leaves no waker behind', async () => {
  const e = new MseEngine({}, {});
  for (let i = 0; i < 50; i++) await e.waitWake(1);
  assert.equal(e._wakers.length, 0);
  // several at once, then they all time out
  await Promise.all([e.waitWake(2), e.waitWake(3), e.waitWake(4)]);
  assert.equal(e._wakers.length, 0);
});

test('waitWake: wake() releases every waiter and empties the list; a timer that fires later does nothing', async () => {
  const e = new MseEngine({}, {});
  const done = [e.waitWake(10000), e.waitWake(10000)];
  assert.equal(e._wakers.length, 2);
  e.wake();
  assert.equal(e._wakers.length, 0);
  await Promise.all(done);
  // a waiter added after the wake-up is its own
  const late = e.waitWake(5);
  assert.equal(e._wakers.length, 1);
  await late;
  assert.equal(e._wakers.length, 0);
});

test('waitWake: timing out one waiter keeps the others', async () => {
  const e = new MseEngine({}, {});
  const long = e.waitWake(10000);
  await e.waitWake(1);
  assert.equal(e._wakers.length, 1);
  e.wake();
  await long;
  assert.equal(e._wakers.length, 0);
});

// ---- bounded SourceBuffer waits ----------------------------------------------

const { Feeder, waitUpdate } = await import('../public/assets/js/player/mse.js');

/** A SourceBuffer stand-in: `updating` and the events are driven by the test. */
function fakeSourceBuffer() {
  const sb = new EventTarget();
  sb.updating = false;
  sb.aborts = 0;
  sb.abort = () => { sb.aborts++; };
  return sb;
}
function feederOn(sb, ms = { readyState: 'open' }) {
  const f = new Feeder({ destroyed: false, ms }, { id: 1, type: 'audio' });
  f.sb = sb;
  f.updateTimeoutMs = 20;
  return f;
}

test('waitUpdate: resolves on updateend, rejects on error or after the timeout, and removes its listeners', async () => {
  const sb = fakeSourceBuffer();
  const p = waitUpdate(sb, 1000);
  sb.dispatchEvent(new Event('updateend'));
  await p;
  const q = waitUpdate(sb, 1000);
  sb.dispatchEvent(new Event('error'));
  await assert.rejects(q, /SourceBuffer error/);
  await assert.rejects(waitUpdate(sb, 5), { name: 'TimeoutError' });
});

test('_whenIdle: an update that never ends is aborted, and then the wait is over', async () => {
  const sb = fakeSourceBuffer();
  sb.updating = true;
  sb.abort = () => {
    sb.aborts++;
    sb.updating = false; // abort() ends the operation, as the spec says
  };
  const f = feederOn(sb);
  await f._whenIdle();
  assert.equal(sb.aborts, 1);
});

test('_whenIdle: a SourceBuffer that stays busy even after abort() fails instead of hanging', async () => {
  const sb = fakeSourceBuffer();
  sb.updating = true; // stuck for good
  const f = feederOn(sb);
  await assert.rejects(f._whenIdle(), { name: 'TimeoutError' });
  assert.equal(sb.aborts, 1);
});

test('_whenIdle: repeated error events on a busy buffer end in an error, not a loop', async () => {
  const sb = fakeSourceBuffer();
  sb.updating = true;
  const f = feederOn(sb);
  f.updateTimeoutMs = 10_000;
  const p = f._whenIdle();
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    sb.dispatchEvent(new Event('error'));
  }
  await assert.rejects(p, /SourceBuffer error/);
});

test('_append: an append that never completes is reported as an error', async () => {
  const sb = fakeSourceBuffer();
  sb.appendBuffer = () => { sb.updating = true; }; // and no updateend ever comes
  const f = feederOn(sb);
  await assert.rejects(f._append(new Uint8Array(4), f.gen), { name: 'TimeoutError' });
});

test('setAudioTrack: a switch on a broken buffer answers false, so the player rebuilds the pipeline', async () => {
  const e = new MseEngine({ currentTime: 30 }, {});
  e.ms = { readyState: 'open' };
  const sb = fakeSourceBuffer();
  sb.updating = true;
  const f = new Feeder(e, { id: 2, type: 'audio', mime: 'audio/mp4; codecs="mp4a.40.2"' });
  f.sb = sb;
  f.mime = 'audio/mp4; codecs="mp4a.40.2"';
  f.updateTimeoutMs = 10;
  e.feeders.push(f);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await e.setAudioTrack({ id: 3, type: 'audio', mime: f.mime }), false);
  } finally {
    console.warn = warn;
  }
});

// ---- buffered ranges: eviction ahead, merged ranges ----------------------------------------------------

/** A TimeRanges stand-in. */
const ranges = (...rs) => ({ length: rs.length, start: (i) => rs[i][0], end: (i) => rs[i][1] });

function rangeFeeder(buffered, { currentTime = 0, duration = 1000 } = {}) {
  const sb = fakeSourceBuffer();
  sb.buffered = buffered;
  sb.removed = [];
  sb.remove = (a, b) => {
    sb.removed.push([a, b]);
    sb.updating = true;
    setTimeout(() => { sb.updating = false; sb.dispatchEvent(new Event('updateend')); }, 0);
  };
  const seeks = [];
  const engine = {
    destroyed: false,
    ms: { readyState: 'open', duration },
    video: { currentTime },
    demux: { createCursor: () => ({ seek: (t) => seeks.push(t) }) },
    wake() {},
  };
  const f = new Feeder(engine, { id: 1, type: 'video' });
  f.sb = sb;
  f.updateTimeoutMs = 1000;
  return { f, sb, seeks, engine };
}

test('QuotaExceededError: ranges far ahead of the playhead are freed too, not only what is behind it', async () => {
  // Watched near the start after seeking around: [10, 30] being filled, [600, 640] and [900, 940] left by earlier seeks.
  const { f, sb } = rangeFeeder(ranges([10, 30], [600, 640], [900, 940]), { currentTime: 12 });
  f.lastEnd = 30;
  let calls = 0;
  sb.appendBuffer = () => {
    if (++calls === 1) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    sb.updating = true;
    setTimeout(() => { sb.updating = false; sb.dispatchEvent(new Event('updateend')); }, 0);
  };
  assert.equal(await f._append(new Uint8Array(4), f.gen), true);
  const ahead = sb.removed.find(([a, b]) => b === Infinity);
  assert.ok(ahead, `removed ${JSON.stringify(sb.removed)}`);
  assert.ok(ahead[0] > 30 && ahead[0] < 600, 'keeps what is being filled, frees the far ranges');
});

test('a range that merged with older data: the feeder continues from its end, once', () => {
  // We appended up to 30; the browser merged [10, 30] with [30, 80] appended before a seek back.
  const { f, seeks } = rangeFeeder(ranges([10, 80]), { currentTime: 25 });
  f.cursor = {};
  f.lastEnd = 30;
  assert.equal(f.continuousAt(50), true, 'a small seek inside the merged range needs no reposition');
  f._skipMerged();
  assert.deepEqual(seeks, [80 - 10], 'cursor moved to the merged end (movie time = element time - SHIFT)');
  // The first fragment from the keyframe before 80 ends at 76: no second jump to the same place.
  f.lastEnd = 76;
  f._skipMerged();
  assert.deepEqual(seeks, [70]);
  // Our own appends extending the range do not count as a merge.
  f.lastEnd = 80;
  f._skipMerged();
  assert.deepEqual(seeks, [70]);
});

test('a separate range elsewhere is not continuous with ours', () => {
  const { f } = rangeFeeder(ranges([10, 30], [600, 640]), { currentTime: 25 });
  f.lastEnd = 30;
  assert.equal(f.continuousAt(20), true);
  assert.equal(f.continuousAt(610), false);
});
