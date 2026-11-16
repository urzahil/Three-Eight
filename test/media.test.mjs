// LocalMedia asks only for the devices that are switched on, and drops tracks that arrive after leaving.
import test from 'node:test';
import assert from 'node:assert/strict';
import './browser-globals.mjs';
import { LocalMedia } from '../public/assets/js/media.js';

function fakeTrack(kind) {
  return { kind, enabled: true, stopped: false, stop() { this.stopped = true; }, addEventListener() {}, getSettings: () => ({}) };
}

/** Install a fake navigator.mediaDevices; `gate` (a promise) delays the answer like a permission prompt does. */
function fakeDevices({ fail = false, gate = null } = {}) {
  const calls = [];
  const made = [];
  const nav = {
    mediaDevices: {
      async getUserMedia(c) {
        calls.push(c);
        if (gate) await gate;
        if (fail) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        const tracks = [];
        if (c.audio) tracks.push(fakeTrack('audio'));
        if (c.video) tracks.push(fakeTrack('video'));
        made.push(...tracks);
        return {
          getTracks: () => tracks,
          getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
          getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
        };
      },
    },
  };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  return { calls, made };
}

const keys = (c) => ({ audio: !!c.audio, video: !!c.video });

test('mic on, cam on: one combined request for both', async () => {
  const { calls } = fakeDevices();
  const m = new LocalMedia({ mic: true, cam: true });
  await m.init();
  assert.equal(calls.length, 1);
  assert.deepEqual(keys(calls[0]), { audio: true, video: true });
  assert.ok(calls[0].audio.echoCancellation !== undefined);
  assert.ok(calls[0].video.width);
  assert.ok(m.audioTrack && m.videoTrack);
});

test('mic on, cam off: audio only', async () => {
  const { calls } = fakeDevices();
  const m = new LocalMedia({ mic: true, cam: false });
  await m.init();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].video, false);
  assert.ok(calls[0].audio);
  assert.ok(m.audioTrack && !m.videoTrack);
});

test('mic off, cam on: video only, the microphone is not requested', async () => {
  const { calls } = fakeDevices();
  const m = new LocalMedia({ mic: false, cam: true });
  await m.init();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].audio, false);
  assert.ok(calls[0].video);
  assert.ok(!m.audioTrack && m.videoTrack);
});

test('mic off, cam off: getUserMedia is not called at all', async () => {
  const { calls } = fakeDevices();
  const m = new LocalMedia({ mic: false, cam: false });
  await m.init();
  assert.equal(calls.length, 0);
  assert.ok(!m.audioTrack && !m.videoTrack);
});

test('the fallback after a failed combined request asks only for enabled kinds', async () => {
  const { calls } = fakeDevices({ fail: true });
  const m = new LocalMedia({ mic: false, cam: true });
  await m.init();
  assert.deepEqual(calls.map(keys), [{ audio: false, video: true }, { audio: false, video: true }]);
  const calls2 = fakeDevices({ fail: true }).calls;
  await new LocalMedia({ mic: true, cam: false }).init();
  assert.deepEqual(calls2.map(keys), [{ audio: true, video: false }, { audio: true, video: false }]);
});

test('turning the mic on later acquires it then, and emits an audio change for the mesh', async () => {
  const { calls } = fakeDevices();
  const m = new LocalMedia({ mic: false, cam: false });
  await m.init();
  const seen = [];
  m.addEventListener('change', (e) => seen.push(e.detail.kind));
  assert.equal(await m.setMic(true), true);
  assert.deepEqual(calls.map(keys), [{ audio: true, video: false }]);
  assert.ok(m.audioTrack.enabled);
  assert.deepEqual(seen, ['audio']);
});

test('muting keeps the track (disabled) for an instant unmute', async () => {
  const { calls } = fakeDevices();
  const m = new LocalMedia({ mic: true, cam: false });
  await m.init();
  const t = m.audioTrack;
  await m.setMic(false);
  assert.equal(m.audioTrack, t);
  assert.equal(t.enabled, false);
  assert.equal(t.stopped, false);
  await m.setMic(true);
  assert.equal(t.enabled, true);
  assert.equal(calls.length, 1);
});

test('tracks delivered after stop() are stopped', async () => {
  let open;
  const gate = new Promise((r) => (open = r));
  const { made } = fakeDevices({ gate });
  const m = new LocalMedia({ mic: true, cam: true });
  const p = m.init();
  m.stop(); // the user left while the permission prompt was open
  open();
  await p;
  assert.equal(made.length, 2);
  assert.ok(made.every((t) => t.stopped));
  assert.ok(!m.audioTrack && !m.videoTrack);
});
