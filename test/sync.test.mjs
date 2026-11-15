// Unit tests for how sync.js accepts a peer's playback state (no DOM needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanState, emptyState, MovieSync } from '../public/assets/js/sync.js';

const good = (over = {}) => ({ seq: 3, by: 'peer-aaaaaaaa', movie: { name: 'A.mkv', size: 100, duration: 60 }, paused: false, pos: 12.5, at: 1700000000000, rate: 1, audio: 1, sub: 'e0', subFiles: [{ id: 'x1', name: 'a.srt' }], ...over });

test('a well-formed state passes through unchanged', () => {
  assert.deepEqual(cleanState(good()), good());
});

test('unusable core fields reject the message', () => {
  for (const bad of [
    { seq: -1 }, { seq: 1.5 }, { seq: '3' }, { seq: Infinity }, { seq: NaN }, { seq: 2 ** 53 }, { seq: Number.MAX_SAFE_INTEGER },
    { by: 5 }, { by: '' }, { by: 'x'.repeat(65) },
    { paused: 'no' }, { paused: undefined },
    { pos: -1 }, { pos: NaN }, { pos: '1' }, { pos: Infinity }, { pos: 1e7 + 1 }, { pos: 1e300 },
    { at: NaN }, { at: Infinity }, { at: '5' }, { at: -1 }, { at: 1e14 + 1 }, { at: 1e300 },
    { movie: 'film' }, { movie: [] }, { movie: { size: 5 } }, { movie: { name: 7 } },
  ]) assert.equal(cleanState(good(bad)), null, JSON.stringify(bad));
  assert.equal(cleanState(null), null);
  assert.equal(cleanState('x'), null);
});

test('pos and at may reach their limits', () => {
  assert.equal(cleanState(good({ pos: 1e7, at: 1e14 })).pos, 1e7);
  assert.equal(cleanState(good({ pos: 0, at: 0 })).at, 0);
});

test('the other fields are clamped', () => {
  const s = cleanState(good({ rate: 1000, audio: -4, sub: 5, movie: { name: 'n'.repeat(1000), size: -1, duration: NaN, extra: 1 } }));
  assert.equal(s.rate, 4);
  assert.equal(s.audio, 0);
  assert.equal(s.sub, null);
  assert.deepEqual(s.movie, { name: 'n'.repeat(300), size: 0, duration: 0 });
  assert.equal(cleanState(good({ rate: 'fast' })).rate, 1);
  assert.equal(cleanState(good({ rate: 0 })).rate, 0.25);
  assert.equal(cleanState(good({ audio: 1e9 })).audio, 64);
  assert.equal(cleanState(good({ movie: null })).movie, null);
});

test('subtitle files: only {id, name} strings, bounded', () => {
  const files = [{ id: 'a', name: 'A' }, null, { id: 5, name: 'x' }, { id: 'b' }, { id: 'c'.repeat(300), name: 'n'.repeat(300), junk: 1 }];
  const s = cleanState(good({ subFiles: files }));
  assert.deepEqual(s.subFiles, [{ id: 'a', name: 'A' }, { id: 'c'.repeat(100), name: 'n'.repeat(120) }]);
  assert.deepEqual(cleanState(good({ subFiles: 'nope' })).subFiles, []);
  assert.equal(cleanState(good({ subFiles: Array.from({ length: 80 }, (_, i) => ({ id: 'i' + i, name: 'n' })) })).subFiles.length, 50);
});

test('the Google Drive reference is still validated', () => {
  const ok = cleanState(good({ movie: { name: 'A', size: 1, duration: 1, drive: { id: 'abcdefghij12', folder: 'abcdefghij34', evil: 1 } } }));
  assert.deepEqual(ok.movie.drive, { id: 'abcdefghij12', folder: 'abcdefghij34' });
  const bad = cleanState(good({ movie: { name: 'A', size: 1, duration: 1, drive: { id: '../x' } } }));
  assert.equal(bad.movie.drive, undefined);
});

test('MovieSync ignores an invalid state and a huge seq can not lock local commits', () => {
  const mesh = new EventTarget();
  mesh.broadcast = () => {};
  const player = new EventTarget();
  player.loaded = false;
  const sync = new MovieSync({ mesh, signaling: { now: () => 1000 }, player, selfId: 'me-me-me-me' });
  const peer = { id: 'peer-aaaaaaaa', send() {} };
  sync._onMessage(peer, { type: 'sync-state', state: good({ seq: 2 ** 60 }) });
  assert.equal(sync.state.seq, 0);
  sync._onMessage(peer, { type: 'sync-state', state: good({ pos: -5 }) });
  assert.equal(sync.state.seq, 0);
  sync._onMessage(peer, { type: 'sync-state', state: good() });
  assert.equal(sync.state.seq, 3);
  sync.pause();
  assert.equal(sync.state.seq, 4);
  assert.deepEqual(Object.keys(emptyState()).sort(), Object.keys(sync.state).sort());
  sync.destroy();
});

function makeSync(now = 1700000000000) {
  const mesh = new EventTarget();
  const sent = [];
  mesh.broadcast = (m) => sent.push(m);
  const player = new EventTarget();
  player.loaded = false;
  const sync = new MovieSync({ mesh, signaling: { now: () => now }, player, selfId: 'me-me-me-me' });
  return { sync, sent };
}
const peer = { id: 'peer-aaaaaaaa', send() {} };

test('a newcomer at seq 0 accepts any state up to the absolute cap, however far ahead', () => {
  const { sync } = makeSync();
  sync._onMessage(peer, { type: 'sync-state', state: good({ seq: 5_000_000 }) });
  assert.equal(sync.state.seq, 5_000_000);
  sync._onMessage(peer, { type: 'sync-state', state: good({ seq: 1e12 }) });
  assert.equal(sync.state.seq, 1e12);
  sync.destroy();
});

test('states above the absolute cap are rejected', () => {
  const { sync } = makeSync();
  sync._onMessage(peer, { type: 'sync-state', state: good({ seq: Number.MAX_SAFE_INTEGER }) });
  assert.equal(sync.state.seq, 0);
  sync._onMessage(peer, { type: 'sync-state', state: good({ seq: 2 ** 60 }) });
  assert.equal(sync.state.seq, 0);
  sync._onMessage(peer, { type: 'sync-state', state: good({ seq: Number.MAX_SAFE_INTEGER - 1 }) });
  assert.equal(sync.state.seq, Number.MAX_SAFE_INTEGER - 1, 'the cap itself is accepted');
  sync.destroy();
});

test('a commit at the cap does not exceed it and peers accept it', () => {
  const { sync, sent } = makeSync();
  sync._onMessage(peer, { type: 'sync-state', state: good({ seq: Number.MAX_SAFE_INTEGER - 1 }) });
  sync.pause();
  assert.equal(sync.state.seq, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(sync.state.by, 'me-me-me-me');
  assert.ok(cleanState(sent.at(-1).state));
  sync.destroy();
});

test('Mesh rebuild attempts decay after a minute without a rebuild', async () => {
  const { Mesh } = await import('../public/assets/js/mesh.js');
  const realNow = Date.now;
  let t = 1e12;
  Date.now = () => t;
  try {
    const fake = { _attempts: new Map(), _lastRebuild: new Map(), rebuilt: 0, rebuildPeer() { this.rebuilt++; this._lastRebuild.set('p', t); return {}; } };
    fake._attemptCount = Mesh.prototype._attemptCount;
    const limited = () => Mesh.prototype._rebuildLimited.call(fake, 'p');
    for (let i = 0; i < 6; i++) { assert.ok(limited()); t += 1500; }
    assert.equal(limited(), null, 'capped');
    t += 30_000;
    assert.equal(limited(), null, 'still capped within a minute');
    t += 31_000;
    assert.ok(limited(), 'allowed again after the counter decayed');
    assert.equal(fake._attempts.get('p'), 1);
    assert.equal(limited(), null, 'the 1 s minimum interval still applies');
  } finally {
    Date.now = realNow;
  }
});

test('local commits stay inside the ranges peers accept, even with bad inputs', () => {
  const { sync, sent } = makeSync();
  sync.state = { ...sync.state, seq: Number.MAX_SAFE_INTEGER - 1 };
  sync.seek(Infinity);
  sync.seek(NaN);
  sync.seek(1e300);
  sync.seek(-5);
  assert.equal(sent.length, 4);
  for (const { state } of sent) assert.ok(cleanState(state), JSON.stringify(state));
  assert.equal(sync.state.seq, Number.MAX_SAFE_INTEGER - 1, 'never above what cleanState allows');
  const late = makeSync(Infinity);
  late.sync.seek(10);
  assert.ok(cleanState(late.sync.state), 'a broken clock does not produce an invalid state');
  sync.destroy();
  late.sync.destroy();
});

test('expectedPosition is finite for every accepted state', () => {
  const { sync } = makeSync(1e14);
  const s = cleanState(good({ paused: false, pos: 1e7, at: 0, rate: 4, movie: null }));
  assert.ok(s);
  assert.ok(Number.isFinite(sync.expectedPosition(s)));
  sync.destroy();
});
