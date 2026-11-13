// End-to-end test: admin creates a room, two participants join with fake
// camera/mic, chat, and watch a movie in sync.
// Usage: node test/e2e.js   (expects the server on BASE, default http://localhost:4567, ADMIN_PASSWORD=test)
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const BASE = process.env.BASE || 'http://localhost:4567';
const ADMIN = process.env.ADMIN_PASSWORD || 'test';
const MOVIE = path.resolve(__dirname, 'fixtures', process.env.MOVIE || 'multi.mkv');
const ROOM = 'e2e-' + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ctl(page, sel) {
  // Movie controls auto-hide; move the mouse over the player first.
  const box = await page.locator('#movie-box').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 3);
  await page.click(sel);
}

async function waitFor(page, fn, arg, timeout = 15000) {
  return page.waitForFunction(fn, arg, { timeout, polling: 200 });
}

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });

  // --- admin: create the room
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await admin.goto(BASE + '/admin');
  await admin.fill('#login-password', 'wrong');
  await admin.click('#login-form button');
  await waitFor(admin, () => !document.getElementById('login-error').hidden);
  await admin.fill('#login-password', ADMIN);
  await admin.click('#login-form button');
  await admin.waitForSelector('#panel:not([hidden])');
  await admin.fill('#create-name', ROOM);
  await admin.fill('#create-password', 'secret');
  await admin.click('#create-form button');
  await admin.waitForSelector(`#rooms a[href$="/${ROOM}"]`);
  console.log('admin: room created');

  // --- unknown room
  const anon = await browser.newPage();
  await anon.goto(BASE + '/does-not-exist-xyz');
  await anon.waitForSelector('#message:not([hidden])');
  assert.match(await anon.textContent('#message-title'), /not found/i);
  await anon.close();

  // --- participants
  const people = [];
  for (const name of ['Alice', 'Bob']) {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name} console]`, m.text()); });
    await page.goto(`${BASE}/${ROOM}?debug`);
    await page.waitForSelector('#lobby:not([hidden])');
    await page.fill('#lobby-name', name);
    await page.fill('#lobby-password', name === 'Bob' ? 'nope' : 'secret');
    await page.click('#lobby-join');
    if (name === 'Bob') {
      await waitFor(page, () => !document.getElementById('lobby-error').hidden);
      assert.match(await page.textContent('#lobby-error'), /password/i);
      await page.fill('#lobby-password', 'secret');
      await page.click('#lobby-join');
    }
    await page.waitForSelector('#room:not([hidden])');
    assert.strictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('te.name'))), name);
    people.push({ name, page, ctx });
  }
  const [alice, bob] = people.map((p) => p.page);
  console.log('both joined');

  // remote video arrives P2P
  const dump = (p) => p.evaluate(() => [...room.mesh.peers.values()].map((x) => ({ polite: x.polite, conn: x.pc.connectionState, sig: x.pc.signalingState, ice: x.pc.iceConnectionState, tx: x.pc.getTransceivers().map((t) => `${t.mid}:${t.direction}/${t.currentDirection}:${t.sender.track?.kind}`), streamTracks: x.stream.getTracks().map((t) => t.kind + ':' + t.readyState + ':' + t.muted), dc: x.dc.readyState, vw: [...document.querySelectorAll('.tile:not(.self) video')].map((v) => v.videoWidth + 'x' + v.readyState + ':' + !!v.srcObject) })));
  for (const p of [alice, bob]) {
    try {
      await waitFor(p, () => [...document.querySelectorAll('.tile:not(.self) video')].some((v) => v.videoWidth > 0), null, 20000);
    } catch (err) {
      console.log('ALICE', JSON.stringify(await dump(alice)));
      console.log('BOB', JSON.stringify(await dump(bob)));
      throw err;
    }
  }
  console.log('remote video flowing both ways');

  // mute state propagates
  await alice.click('#t-mic');
  await waitFor(bob, () => [...document.querySelectorAll('.tile:not(.self) .label svg')].some((s) => s.style.display !== 'none'));
  console.log('mute state propagated');
  await alice.click('#t-cam');
  await waitFor(bob, () => document.querySelector('.tile:not(.self)').classList.contains('no-video'));
  console.log('camera off propagated');

  // chat
  await alice.click('#t-chat');
  await alice.fill('#chat-input', 'hello bob https://example.com');
  await alice.press('#chat-input', 'Enter');
  await waitFor(bob, () => [...document.querySelectorAll('.msg .body')].some((b) => b.textContent.includes('hello bob')));
  console.log('chat delivered');

  // --- movie
  await alice.setInputFiles('#movie-file', MOVIE);
  await waitFor(alice, () => !document.getElementById('stage').hidden && document.getElementById('movie').readyState >= 2, null, 20000);
  await waitFor(bob, () => !document.getElementById('stage').hidden && document.getElementById('movie-overlay').textContent.includes('Choose'));
  console.log('bob sees movie prompt');
  await bob.setInputFiles('#movie-file', MOVIE);
  await waitFor(bob, () => document.getElementById('movie').readyState >= 2, null, 20000);
  await waitFor(alice, () => /Everyone ready/.test(document.getElementById('m-ready').textContent));
  console.log('both ready');

  const state = (p) => p.evaluate(() => {
    const v = document.getElementById('movie');
    const t = window.__room ? null : null;
    return { paused: v.paused, time: v.currentTime, rate: v.playbackRate, subs: document.getElementById('subs-layer').innerText.trim() };
  });

  await ctl(alice, '#m-play');
  await sleep(4000);
  let a = await state(alice), b = await state(bob);
  console.log('playing:', a, b);
  assert(!a.paused && !b.paused, 'both should play');
  assert(Math.abs(a.time - b.time) < 0.3, `drift too large: ${a.time} vs ${b.time}`);

  // Bob pauses -> Alice pauses
  await ctl(bob, '#m-play');
  await sleep(800);
  a = await state(alice); b = await state(bob);
  console.log('paused:', a, b);
  assert(a.paused && b.paused, 'both should be paused');
  assert(Math.abs(a.time - b.time) < 0.15, 'paused at same position');

  // Bob seeks to 19.5s via keyboard-free API (seek bar click)
  await ctl(bob, '#m-time');
  const box = await bob.locator('#m-seek').boundingBox();
  await bob.mouse.click(box.x + box.width * (19.5 / 40), box.y + box.height / 2);
  await sleep(1200);
  a = await state(alice); b = await state(bob);
  console.log('seeked:', a.time, b.time);
  assert(Math.abs(a.time - b.time) < 0.2, 'seek synced');

  // Alice selects Italian audio and English subtitles
  await ctl(alice, '#m-audio');
  await alice.click('#m-audio-menu button:nth-of-type(2)');
  await ctl(alice, '#m-subs');
  await alice.click('#m-subs-menu button:nth-of-type(2)');
  await ctl(alice, '#m-play');
  await sleep(2500);
  const tracks = await bob.evaluate(() => [...document.querySelectorAll('#m-audio-menu button.on span, #m-subs-menu button.on span')].map((s) => s.textContent));
  a = await state(alice); b = await state(bob);
  console.log('tracks on bob:', tracks, 'subs:', JSON.stringify(a.subs), JSON.stringify(b.subs), a.time, b.time);
  assert(tracks.some((t) => /Italiano/.test(t)), 'audio track synced');
  assert(/Twenty seconds/.test(b.subs) && /Twenty seconds/.test(a.subs), 'subtitles synced');
  assert(Math.abs(a.time - b.time) < 0.35, 'still in sync after track change');

  // External subtitle file shared from Bob to Alice
  await bob.setInputFiles('#sub-file', path.resolve(__dirname, 'fixtures', 'subs_it.ass'));
  await sleep(1000);
  const aliceSubs = await alice.evaluate(() => [...document.querySelectorAll('#m-subs-menu button.on span')].map((s) => s.textContent));
  console.log('alice subtitle after bob shared a file:', aliceSubs);
  assert(aliceSubs.some((t) => /subs_it/.test(t)), 'external subtitle shared');

  // Late joiner gets current state
  const ctx3 = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const carol = await ctx3.newPage();
  await carol.goto(`${BASE}/${ROOM}?debug`);
  await carol.fill('#lobby-name', 'Carol');
  await carol.fill('#lobby-password', 'secret');
  await carol.click('#lobby-join');
  await waitFor(carol, () => !document.getElementById('stage').hidden);
  await carol.setInputFiles('#movie-file', MOVIE);
  await sleep(3000);
  a = await state(alice);
  const c = await state(carol);
  console.log('late joiner:', a.time, c.time, c.paused);
  assert(!c.paused && Math.abs(a.time - c.time) < 0.4, 'late joiner synced');

  // Admin sees people online, then deletes the room -> everyone kicked
  await admin.reload();
  await admin.waitForSelector('#panel:not([hidden])');
  await sleep(1500);
  console.log('admin rows:', await admin.evaluate((room) => [...document.querySelectorAll('#rooms tr')].map((tr) => tr.textContent).filter((t) => t.includes(room)), ROOM));
  await waitFor(admin, (room) => [...document.querySelectorAll('#rooms tr')].some((tr) => tr.textContent.includes(room) && tr.textContent.includes('Alice')), ROOM);
  admin.on('dialog', (d) => d.accept());
  const row = admin.locator('#rooms tr', { hasText: ROOM });
  await row.locator('button', { hasText: 'Delete' }).click();
  await sleep(1500);
  console.log('after delete:', await admin.evaluate(async (room) => (await (await fetch('/api/rooms/' + room)).status), ROOM),
    await alice.evaluate(() => ({ msg: !document.getElementById('message').hidden, room: !document.getElementById('room').hidden, ws: window.room?.signaling.ws.readyState })));
  await waitFor(alice, () => !document.getElementById('message').hidden);
  console.log('room deleted, participants disconnected:', await alice.textContent('#message-text'));

  await browser.close();
  console.log('E2E OK');
})().catch((err) => {
  console.error('E2E FAILED', err);
  process.exit(1);
});
