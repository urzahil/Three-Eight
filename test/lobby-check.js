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

    // The toolbar is live while the prompt is open: "Stop video" clicked then must still hold when the prompt is granted.
    const pendingPage = async (name) => {
      const c = await browser.newContext({ permissions: ['camera', 'microphone'] });
      const pg = await c.newPage();
      pg.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
      await pg.addInitScript(() => {
        const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        window.__pending = [];
        window.__tracks = []; // every track getUserMedia handed out
        navigator.mediaDevices.getUserMedia = (c) => new Promise((resolve, reject) => window.__pending.push(() => real(c).then((s) => { window.__tracks.push(...s.getTracks()); resolve(s); }, reject)));
      });
      await pg.goto(`${BASE}/${ROOM}?debug`);
      await pg.fill('#lobby-name', name);
      assert.strictEqual(await pg.evaluate(() => window.__pending.length), 1, 'the permission prompt is open');
      await pg.click('#lobby-join');
      await pg.waitForSelector('#room:not([hidden])');
      return pg;
    };
    const dave = await pendingPage('Dave');
    const daveId = await dave.evaluate(() => room.id);
    await dave.click('#t-cam'); // "Stop video" while there is no track yet
    assert.strictEqual(await dave.evaluate(() => room.media.camOn), false);
    await dave.evaluate(() => window.__pending.splice(0).forEach((f) => f()));
    await waitFor(dave, () => room.media.audioTrack && window.__tracks.length > 0);
    await sleep(1500);
    assert.strictEqual(await dave.evaluate(() => room.media.videoTrack), null, 'no local video track');
    assert.strictEqual(await dave.evaluate(() => [...room.mesh.peers.values()].every((p) => p.videoTx.sender.track === null) && room.mesh.tracks.video === null), true, 'no video track is sent');
    assert.strictEqual(await dave.evaluate(() => window.__tracks.filter((t) => t.kind === 'video').every((t) => t.readyState === 'ended')), true, 'the camera was released');
    assert.strictEqual(await dave.evaluate(() => room.media.audioTrack.enabled && room.media.audioTrack.readyState === 'live'), true, 'the microphone is kept');
    assert.strictEqual(await bob.evaluate((id) => room.profiles.get(id)?.video, daveId), false, 'the other participant is told there is no video');
    assert.strictEqual(await bob.evaluate((id) => { const t = [...document.querySelectorAll('.tile:not(.self)')]; return t.some((x) => x.querySelector('video')?.videoWidth > 0 && x.textContent.includes('Dave')); }, daveId), false);
    console.log('"Stop video" during the permission prompt is honoured: no camera track, none sent');

    // Leaving while the prompt is open: when it is granted afterwards, the devices are released at once.
    const erin = await pendingPage('Erin');
    await erin.evaluate(() => room.leave(true));
    await erin.evaluate(() => window.__pending.splice(0).forEach((f) => f()));
    await waitFor(erin, () => window.__tracks.length > 0);
    await waitFor(erin, () => window.__tracks.every((t) => t.readyState === 'ended'));
    assert.strictEqual(await erin.evaluate(() => room.media.audioTrack === null && room.media.videoTrack === null), true);
    console.log('leaving during the prompt: the devices that arrive later are stopped');

    // The same for a device request made from the room (camera button, then leave before it is granted).
    const fay = await pendingPage('Fay');
    await fay.evaluate(() => window.__pending.splice(0).forEach((f) => f()));
    await waitFor(fay, () => room.media.audioTrack && room.media.videoTrack);
    await fay.click('#t-cam'); // off
    await fay.evaluate(() => { window.__tracks.length = 0; });
    await fay.click('#t-cam'); // on again: a new request, held pending
    assert.strictEqual(await fay.evaluate(() => window.__pending.length), 1);
    await fay.evaluate(() => room.leave(true));
    await fay.evaluate(() => window.__pending.splice(0).forEach((f) => f()));
    await waitFor(fay, () => window.__tracks.length > 0);
    await waitFor(fay, () => window.__tracks.every((t) => t.readyState === 'ended'));
    console.log('leaving during a camera request: the camera is released');

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
