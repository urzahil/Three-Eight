// LocalMedia asks only for the devices that are switched on, drops tracks that arrive after leaving, and
// switches devices the way phones need (the current camera is stopped before the next one is opened).
import test from 'node:test';
import assert from 'node:assert/strict';
import './browser-globals.mjs';
import { LocalMedia } from '../public/assets/js/media.js';

function fakeTrack(kind, deviceId = `default-${kind}`) {
  return { kind, deviceId, enabled: true, stopped: false, stop() { this.stopped = true; }, addEventListener() {}, getSettings: () => ({ deviceId }) };
}

const err = (name) => Object.assign(new Error(name), { name });
const requested = (c) => (c && c.deviceId?.exact) || undefined;

/**
 * Install a fake navigator.mediaDevices; `gate` (a promise) delays the answer like a permission prompt does.
 * `oneCamera`: like a phone, a camera can't be opened while another one runs. `broken`: deviceId -> error name.
 */
function fakeDevices({ fail = false, gate = null, oneCamera = false, broken = {} } = {}) {
  const calls = [];
  const made = [];
  const nav = {
    mediaDevices: {
      async getUserMedia(c) {
        calls.push(c);
        if (gate) await gate;
        if (fail) throw err('NotAllowedError');
        for (const kind of ['audio', 'video']) if (broken[requested(c[kind])]) throw err(broken[requested(c[kind])]);
        if (c.video && oneCamera && made.some((t) => t.kind === 'video' && !t.stopped)) throw err('NotReadableError');
        const tracks = [];
        if (c.audio) tracks.push(fakeTrack('audio', requested(c.audio)));
        if (c.video) tracks.push(fakeTrack('video', requested(c.video)));
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

const live = (made, kind) => made.filter((t) => t.kind === kind && !t.stopped);

test('switching cameras stops the current one first, so it works where only one camera can run', async () => {
  const { made } = fakeDevices({ oneCamera: true });
  const m = new LocalMedia({ mic: false, cam: true, videoDevice: 'front' });
  await m.init();
  const front = m.videoTrack;
  const seen = [];
  m.addEventListener('change', (e) => seen.push(e.detail.kind));
  assert.equal(await m.setDevice('video', 'back'), true);
  assert.equal(m.videoTrack.deviceId, 'back');
  assert.ok(front.stopped);
  assert.deepEqual(live(made, 'video'), [m.videoTrack]);
  assert.equal(m.currentDeviceId('video'), 'back');
  assert.deepEqual(seen, ['video']); // one change, with the new track: no "camera off" in between
});

test('a camera that cannot be opened: the previous one comes back, and setDevice says so', async () => {
  for (const error of ['NotReadableError', 'OverconstrainedError']) {
    const { made } = fakeDevices({ oneCamera: true, broken: { back: error } });
    const m = new LocalMedia({ mic: false, cam: true, videoDevice: 'front' });
    await m.init();
    assert.equal(await m.setDevice('video', 'back'), false, error);
    // Not the default camera, even for a device that is gone (OverconstrainedError).
    assert.equal(m.videoTrack.deviceId, 'front', error);
    assert.deepEqual(live(made, 'video'), [m.videoTrack]);
    assert.equal(m.deviceIds.video, 'front');
    assert.equal(m.camOn, true);
  }
});

test('if neither camera opens, the camera is off', async () => {
  const { made } = fakeDevices({ broken: { back: 'NotReadableError' } });
  const m = new LocalMedia({ mic: false, cam: true, videoDevice: 'front' });
  await m.init();
  navigator.mediaDevices.getUserMedia = async () => { throw err('NotReadableError'); };
  assert.equal(await m.setDevice('video', 'back'), false);
  assert.equal(m.videoTrack, null);
  assert.equal(m.camOn, false);
  assert.equal(live(made, 'video').length, 0);
});

test('with the camera off, choosing one only remembers it for when it is turned on', async () => {
  const { calls } = fakeDevices();
  const m = new LocalMedia({ mic: false, cam: false });
  await m.init();
  assert.equal(await m.setDevice('video', 'back'), true);
  assert.equal(calls.length, 0);
  await m.setCam(true);
  assert.equal(m.videoTrack.deviceId, 'back');
});

test('quick successive switches run one after another', async () => {
  const { made } = fakeDevices({ oneCamera: true });
  const m = new LocalMedia({ mic: false, cam: true, videoDevice: 'a' });
  await m.init();
  assert.deepEqual(await Promise.all([m.setDevice('video', 'b'), m.setDevice('video', 'c')]), [true, true]);
  assert.equal(m.videoTrack.deviceId, 'c');
  assert.deepEqual(live(made, 'video'), [m.videoTrack]);
});

test('switching microphones keeps mute; a microphone that fails leaves the previous one in use', async () => {
  const { made } = fakeDevices({ broken: { usb: 'NotReadableError' } });
  const m = new LocalMedia({ mic: true, cam: false, audioDevice: 'built-in' });
  await m.init();
  await m.setMic(false);
  assert.equal(await m.setDevice('audio', 'headset'), true);
  assert.equal(m.audioTrack.deviceId, 'headset');
  assert.equal(m.audioTrack.enabled, false);
  assert.equal(await m.setDevice('audio', 'usb'), false);
  assert.equal(m.audioTrack.deviceId, 'headset');
  assert.equal(m.audioTrack.enabled, false);
  assert.deepEqual(live(made, 'audio'), [m.audioTrack]);
});
