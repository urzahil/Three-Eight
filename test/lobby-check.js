// Browser test for the lobby: clicking "Join room" while the camera/microphone permission prompt is still
// unanswered must join the room (without devices) and must not reload the page; the devices attach when
// the prompt is answered later. Starts its own server. No fixtures needed.
// Usage: node test/lobby-check.js   (PORT, default 4753)
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = Number(process.env.PORT || 4753);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test';
const ROOM = 'lobby-' + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-lobby-'));

(async () => {
  const server = spawn(process.execPath, [path.resolve(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, ADMIN_PASSWORD: ADMIN, TRUST_PROXY: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(BASE + '/healthz')).ok) break;
      } catch { /* not up yet */ }
      if (i > 50) throw new Error('server did not start');
      await sleep(100);
    }
    const login = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const made = await fetch(BASE + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: ROOM }) });
    assert.equal(made.status, 201);

    browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    // getUserMedia stays pending (like an open permission prompt) until the test answers it.
    await page.addInitScript(() => {
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__pending = [];
      navigator.mediaDevices.getUserMedia = (c) => new Promise((resolve, reject) => window.__pending.push(() => real(c).then(resolve, reject)));
    });
    let navigations = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });

    await page.goto(`${BASE}/${ROOM}?debug`);
    await page.waitForSelector('#lobby:not([hidden])');
    assert.strictEqual(navigations, 1);
    await page.fill('#lobby-name', 'Alice');
    assert.strictEqual(await page.evaluate(() => window.__pending.length), 1, 'the permission prompt is open');
    await page.click('#lobby-join');
    await page.waitForSelector('#room:not([hidden])');
    await sleep(500);
    assert.strictEqual(navigations, 1, 'the page did not navigate');
    assert.strictEqual(page.url(), `${BASE}/${ROOM}?debug`);
    assert.strictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('te.name'))), 'Alice');
    assert.strictEqual(await page.evaluate(() => [window.room.media.audioTrack, window.room.media.videoTrack].filter(Boolean).length), 0, 'joined without devices');
    console.log('joined while the permission prompt was open, no navigation');

    // The prompt is answered now: the devices attach to the room.
    await page.evaluate(() => window.__pending.splice(0).forEach((f) => f()));
    await waitFor(page, () => room.media.audioTrack && room.media.videoTrack && document.querySelector('.tile.self video').srcObject && !document.querySelector('.tile.self').classList.contains('no-video'));
    assert.strictEqual(await page.evaluate(() => room.mesh.tracks.audio === room.media.audioTrack && room.mesh.tracks.video === room.media.videoTrack), true, 'the mesh sends the new tracks');
    console.log('devices attached after the prompt was answered');

    // A second participant sees the video of the one who joined without devices.
    const ctx2 = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const bob = await ctx2.newPage();
    await bob.goto(`${BASE}/${ROOM}?debug`);
    await bob.fill('#lobby-name', 'Bob');
    await bob.click('#lobby-join');
    await bob.waitForSelector('#room:not([hidden])');
    await waitFor(bob, () => [...document.querySelectorAll('.tile:not(.self) video')].some((v) => v.videoWidth > 0), null, 20000);
    console.log('the other side receives the late video');

    // The permission prompt never settles and the user leaves: nothing hangs, no navigation either.
    const ctx3 = await browser.newContext();
    const p3 = await ctx3.newPage();
    await p3.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => new Promise(() => {}); });
    let nav3 = 0;
    p3.on('framenavigated', (f) => { if (f === p3.mainFrame()) nav3++; });
    await p3.goto(`${BASE}/${ROOM}`);
    await p3.fill('#lobby-name', 'Carol');
    await p3.click('#lobby-join');
    await p3.waitForSelector('#room:not([hidden])');
    await sleep(500);
    assert.strictEqual(nav3, 1, 'no navigation (a native form submit)');
    console.log('a prompt that never settles does not block joining');

    console.log('LOBBY OK');
  } finally {
    await browser?.close();
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('LOBBY FAILED', err);
  process.exit(1);
});
