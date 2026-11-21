// LocalMedia asks only for the devices that are switched on, drops tracks that arrive after leaving, and
// switches devices the way phones need (the current camera is stopped before the next one is opened).
import test from 'node:test';
import assert from 'node:assert/strict';
import './browser-globals.mjs';
import { LocalMedia } from '../public/assets/js/media.js';

function fakeTrack(kind, deviceId = `default-${kind}`) {
  const ended = [];
  return {
    kind, deviceId, enabled: true, stopped: false,
    stop() { this.stopped = true; }, // like the real thing: stop() fires no 'ended'
    end() { this.stopped = true; for (const fn of ended) fn(); }, // the browser ends the track
    addEventListener(type, fn) { if (type === 'ended') ended.push(fn); },
    getSettings: () => ({ deviceId }),
  };
}

const err = (name) => Object.assign(new Error(name), { name });
const requested = (c) => (c && c.deviceId?.exact) || undefined;

/**
 * Install a fake navigator.mediaDevices; `gate` (a promise) delays the answer like a permission prompt does.
 * `oneCamera`: like Android, a camera can't be opened while another one runs. `endsOtherCamera`: like Safari on
 * iOS, opening a camera ends the one that runs (WebKit bug 264288). `broken`: deviceId -> error name.
 */
function fakeDevices({ fail = false, gate = null, oneCamera = false, endsOtherCamera = false, broken = {} } = {}) {
  const calls = [];
  const made = [];
  const listeners = new Set();
  const nav = {
    mediaDevices: {
      addEventListener(type, fn) { if (type === 'devicechange') listeners.add(fn); },
      removeEventListener(type, fn) { if (type === 'devicechange') listeners.delete(fn); },
      async getUserMedia(c) {
        calls.push(c);
        if (gate) await gate;
        if (fail) throw err('NotAllowedError');
        for (const kind of ['audio', 'video']) if (broken[requested(c[kind])]) throw err(broken[requested(c[kind])]);
        if (c.video && oneCamera && made.some((t) => t.kind === 'video' && !t.stopped)) throw err('NotReadableError');
        if (c.video && endsOtherCamera) for (const t of made) if (t.kind === 'video' && !t.stopped) t.end();
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
  // devicechange(): the system's device list changed (a headset was plugged in or removed).
  return { calls, made, listeners, devicechange: () => { for (const fn of [...listeners]) fn(); } };
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

test('switching cameras in Safari on iOS, where opening a camera ends the running one', async () => {
  const { made } = fakeDevices({ endsOtherCamera: true });
  const m = new LocalMedia({ mic: false, cam: true, videoDevice: 'front' });
  await m.init();
  const seen = [];
  m.addEventListener('change', (e) => seen.push(e.detail.kind));
  assert.equal(await m.setDevice('video', 'back'), true);
  assert.equal(m.camOn, true);
  assert.equal(m.videoTrack?.deviceId, 'back');
  assert.deepEqual(live(made, 'video'), [m.videoTrack]);
  assert.deepEqual(seen, ['video']);
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

test('unmute right after the microphone was blocked asks for it at once (not on a second press)', async () => {
  fakeDevices({ fail: true });
  const m = new LocalMedia({ mic: true, cam: false });
  await m.init();
  assert.equal(m.micOn, true, 'the preference stays on');
  assert.equal(m.micActive, false, 'but there is no microphone: the button shows "Unmute"');
  const { calls } = fakeDevices();
  assert.equal(await m.toggleMic(), true);
  assert.equal(calls.length, 1, 'the first press requests the microphone');
  assert.equal(m.micActive, true);
  await m.toggleMic();
  assert.equal(m.micActive, false, 'and the next one mutes');
});

test('unmute after the microphone was unplugged (and none could be reopened) opens one again at once', async () => {
  fakeDevices();
  const m = new LocalMedia({ mic: true, cam: false });
  await m.init();
  navigator.mediaDevices.getUserMedia = async () => { throw err('NotFoundError'); };
  m.audioTrack.end(); // unplugged, and no other microphone
  assert.equal(m.audioTrack, null);
  await settle();
  assert.equal(m.micActive, false);
  fakeDevices(); // a microphone is plugged in
  await m.toggleMic();
  assert.ok(m.audioTrack && m.audioTrack.enabled, 'a new track, enabled');
});

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('devicechange bursts become one "devices" event; none after stop()', async () => {
  const { listeners, devicechange } = fakeDevices();
  const m = new LocalMedia({ mic: false, cam: false });
  let n = 0;
  m.addEventListener('devices', () => n++);
  devicechange();
  devicechange();
  await settle(100);
  devicechange();
  assert.equal(n, 0, 'waits for the burst to settle');
  await settle(450);
  assert.equal(n, 1);
  devicechange();
  m.stop();
  await settle(450);
  assert.equal(n, 1, 'no event after leaving');
  assert.equal(listeners.size, 0, 'the listener is removed');
});

test('an unplugged microphone that is on is replaced by the default one, with one request and one change', async () => {
  // The saved microphone is gone: the reopen falls back to the default one (an exact request, then the default).
  const broken = {};
  const { calls } = fakeDevices({ broken });
  const m = new LocalMedia({ mic: true, cam: false, audioDevice: 'usb' });
  await m.init();
  assert.equal(m.audioTrack.deviceId, 'usb');
  broken.usb = 'OverconstrainedError'; // unplugged
  const before = calls.length;
  const seen = [];
  m.addEventListener('change', (e) => seen.push([e.detail.kind, m.audioTrack?.deviceId, e.detail.ended]));
  const old = m.audioTrack;
  old.end();
  await settle();
  assert.deepEqual(calls.slice(before).map((c) => requested(c.audio) || 'default'), ['usb', 'default']);
  assert.ok(m.audioTrack && m.audioTrack !== old && m.audioTrack.enabled);
  assert.equal(m.deviceIds.audio, '', 'the default device is used from now on');
  assert.deepEqual(seen, [['audio', 'default-audio', true]], 'one change, with the new track (and "ended": the room says so)');
});

test('a microphone that cannot be reopened is not asked for again, nor one whose new track ends at once', async () => {
  const { calls } = fakeDevices();
  const m = new LocalMedia({ mic: true, cam: false });
  await m.init();
  const seen = [];
  m.addEventListener('change', (e) => seen.push(e.detail.kind));
  // 1. The new track ends right away (a device that keeps failing): it is not reopened a second time.
  m.audioTrack.end();
  await settle();
  assert.equal(calls.length, 2, 'one request after the first end');
  m.audioTrack.end();
  await settle();
  assert.equal(calls.length, 2, 'no request after the second end');
  assert.equal(m.audioTrack, null);
  assert.deepEqual(seen, ['audio', 'audio'], 'the mesh hears of each change');
  // 2. The request fails: nothing more is asked.
  const again = fakeDevices({ fail: true });
  const m2 = new LocalMedia({ mic: true, cam: false });
  navigator.mediaDevices.getUserMedia = async () => fakeStream('audio');
  await m2.init();
  navigator.mediaDevices.getUserMedia = async (c) => { again.calls.push(c); throw err('NotReadableError'); };
  m2.audioTrack.end();
  await settle(50);
  assert.equal(again.calls.length, 1);
  assert.equal(m2.audioTrack, null);
  assert.equal(m2.micOn, true, 'the preference stays on: the button offers "Unmute"');
});

test('a muted microphone or a camera that is off is not reopened; a camera that is on is, or goes off', async () => {
  const { calls } = fakeDevices();
  const m = new LocalMedia({ mic: true, cam: true });
  await m.init();
  await m.setMic(false);
  m.audioTrack.end();
  await settle();
  assert.equal(calls.length, 1, 'muted: no request (unmuting asks for one, see above)');
  m.videoTrack.end();
  await settle();
  assert.equal(calls.length, 2, 'the camera is reopened');
  assert.ok(m.videoTrack && m.camOn);
  // The camera is gone for good: it is off, as before.
  navigator.mediaDevices.getUserMedia = async () => { throw err('NotFoundError'); };
  m._reopenedAt.video = -Infinity; // past the cooldown
  const seen = [];
  m.addEventListener('change', (e) => seen.push(e.detail.kind));
  m.videoTrack.end();
  await settle();
  assert.equal(m.videoTrack, null);
  assert.equal(m.camOn, false);
  assert.deepEqual(seen, ['video']);
});

test('a track that ends after leaving is not reopened', async () => {
  const { calls } = fakeDevices();
  const m = new LocalMedia({ mic: true, cam: false });
  await m.init();
  const t = m.audioTrack;
  m.stop();
  t.end();
  await settle();
  assert.equal(calls.length, 1);
});

function fakeStream(kind) {
  const t = fakeTrack(kind);
  return { getTracks: () => [t], getAudioTracks: () => (kind === 'audio' ? [t] : []), getVideoTracks: () => (kind === 'video' ? [t] : []) };
}
