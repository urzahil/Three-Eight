// The keyboard shortcuts: one list (SHORTCUTS in room/keyboard.js) feeds the "?" dialog. The tables in README.md and
// docs/movie-player.md must list exactly its keys, and the keydown handler must act on each of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './browser-globals.mjs';
import { SHORTCUTS, Keyboard } from '../public/assets/js/room/keyboard.js';

const root = new URL('..', import.meta.url);
const listed = new Set(SHORTCUTS.flatMap((s) => s.keys));

/** The keys a document's "Keyboard shortcuts" table lists (the backticked names in its first column). */
function documentedKeys(file) {
  const text = fs.readFileSync(new URL(file, root), 'utf8');
  const section = text.split(/^## /m).find((part) => part.startsWith('Keyboard shortcuts'));
  assert.ok(section, `${file} has a "Keyboard shortcuts" section`);
  const keys = new Set();
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const first = line.split('|')[1];
    for (const m of first.matchAll(/`([^`]+)`/g)) keys.add(m[1]);
  }
  return keys;
}

for (const file of ['README.md', 'docs/movie-player.md']) {
  test(`${file} lists every keyboard shortcut, and no other`, () => {
    const documented = documentedKeys(file);
    assert.deepEqual([...listed].filter((k) => !documented.has(k)), [], 'missing from the table');
    assert.deepEqual([...documented].filter((k) => !listed.has(k)), [], 'in the table but not a shortcut');
  });
}

test('every shortcut has a key code per key, and an action', () => {
  for (const s of SHORTCUTS) {
    assert.equal(s.codes.length, s.keys.length, s.action);
    assert.ok(s.action);
  }
});

/** A Room with the Keyboard part and stubs for everything the shortcuts call; returns { room, press, calls }. */
function keyboardRoom({ movie = true } = {}) {
  const calls = [];
  const doc = {
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    getElementById: (id) => (id === 'stage' ? { hidden: !movie } : null),
    querySelectorAll: () => [],
  };
  globalThis.document = doc;
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getDisplayMedia() {} } }, configurable: true, writable: true });
  const room = Object.create(Keyboard.prototype);
  Object.assign(room, {
    left: false,
    seekStep: 10,
    pipMode: 'document',
    sync: { fileMatches: movie, toggle: () => calls.push('toggle'), seek: (t) => calls.push(['seek', t]) },
    player: { loaded: movie },
    _pos: () => 100,
    _userAction: (fn) => fn(),
    _stepMovieVolume: (d) => calls.push(['volume', d]),
    toggleFullscreen: () => calls.push('fullscreen'),
    toggleMic: () => calls.push('mic'),
    toggleCam: () => calls.push('cam'),
    toggleScreen: () => calls.push('screen'),
    toggleSidebar: (tab) => calls.push(['sidebar', tab]),
    togglePip: () => calls.push('pip'),
    openShortcuts: () => calls.push('list'),
  });
  room._initKeyboard();
  const press = (key, opts = {}) => {
    const e = {
      key, shiftKey: key === '?', metaKey: false, ctrlKey: false, altKey: false, ...opts,
      target: { closest: () => null, ownerDocument: doc },
      prevented: false,
      preventDefault() { this.prevented = true; },
    };
    doc.listeners.keydown(e);
    return e.prevented;
  };
  return { room, press, calls };
}

test('the handler acts on every listed key while the movie is joined', () => {
  const { press, calls } = keyboardRoom();
  for (const s of SHORTCUTS) for (const code of s.codes) assert.equal(press(code), true, `${code} (${s.action})`);
  assert.deepEqual(calls, [
    'toggle', 'toggle',
    ['seek', 90], ['seek', 110],
    ['seek', 90], ['seek', 110],
    ['volume', 0.05], ['volume', -0.05],
    'pip', 'fullscreen', 'mic', 'cam', 'screen', ['sidebar', 'chat'], 'list',
  ]);
});

test('without a movie, the movie keys do nothing (the arrows scroll the page); the others still work', () => {
  const { press, calls } = keyboardRoom({ movie: false });
  for (const s of SHORTCUTS) {
    for (const code of s.codes) assert.equal(press(code), !s.movie, `${code} (${s.action})`);
  }
  assert.deepEqual(calls, ['fullscreen', 'mic', 'cam', 'screen', ['sidebar', 'chat'], 'list']);
});

test('"?" from the picture-in-picture window does not open the list in the main window', () => {
  const { room, calls } = keyboardRoom();
  const e = {
    key: '?', shiftKey: true, metaKey: false, ctrlKey: false, altKey: false,
    target: { closest: () => null, ownerDocument: { querySelectorAll: () => [] } },
    preventDefault() { this.prevented = true; },
  };
  room._onKeydown(e);
  assert.deepEqual(calls, []);
  assert.equal(e.prevented, undefined);
});
