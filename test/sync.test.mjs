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
    { seq: -1 }, { seq: 1.5 }, { seq: '3' }, { seq: Infinity }, { seq: NaN }, { seq: 2 ** 53 }, { seq: 1e12 },
    { by: 5 }, { by: '' }, { by: 'x'.repeat(65) },
    { paused: 'no' }, { paused: undefined },
    { pos: -1 }, { pos: NaN }, { pos: '1' }, { pos: Infinity },
    { at: NaN }, { at: Infinity }, { at: '5' },
    { movie: 'film' }, { movie: [] }, { movie: { size: 5 } }, { movie: { name: 7 } },
  ]) assert.equal(cleanState(good(bad)), null, JSON.stringify(bad));
  assert.equal(cleanState(null), null);
  assert.equal(cleanState('x'), null);
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
