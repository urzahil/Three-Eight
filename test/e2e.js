// End-to-end test: admin creates a room, two participants join with fake
// camera/mic, chat, and watch a movie in sync.
// Usage: node test/e2e.js   (expects the server on BASE, default http://localhost:4567, ADMIN_PASSWORD=test-admin-password)
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const BASE = process.env.BASE || 'http://localhost:4567';
const ADMIN = process.env.ADMIN_PASSWORD || 'test-admin-password';
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
  await waitFor(bob, () => !document.getElementById('stage').hidden && document.getElementById('movie-overlay').textContent.includes("Stream from Alice's copy"));
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

  // Space on a focused toolbar button presses that button: it must not start the movie for everyone.
  await bob.focus('#t-chat');
  for (let i = 0; i < 2; i++) { // twice, so the chat panel ends up as it was; checked after each press
    await bob.keyboard.press(' ');
    await sleep(1000);
    a = await state(alice);
    assert(a.paused, 'Space on a focused button must not toggle the room\'s playback');
  }
  // Letter shortcuts work with Caps Lock on ("K" without Shift).
  await bob.evaluate(() => document.activeElement.blur());
  await bob.keyboard.press('K');
  await sleep(1200);
  a = await state(alice);
  assert(!a.paused, '"K" toggles playback like "k"');
  await bob.keyboard.press('k');
  await sleep(800);
  a = await state(alice); b = await state(bob);
  assert(a.paused && b.paused, 'paused again');
  console.log('keyboard: Space on a button and Caps Lock shortcuts ok');

  // ↑ / ↓ change Bob's movie volume (only his, remembered, shown over the picture); j / l seek the room like ← / →;
  // "?" lists the shortcuts.
  const vol = (p) => p.evaluate(() => ({ v: document.getElementById('movie').volume, slider: Number(document.getElementById('m-volume').value), saved: JSON.parse(localStorage.getItem('te.movieVolume')) }));
  await bob.keyboard.press('ArrowDown');
  await bob.keyboard.press('ArrowDown');
  assert.deepStrictEqual(await vol(bob), { v: 0.9, slider: 0.9, saved: 0.9 });
  assert.strictEqual(await bob.textContent('#m-note'), 'Volume 90%');
  assert(await bob.isVisible('#m-note'), 'the volume is shown over the picture');
  await bob.keyboard.press('ArrowUp');
  assert.deepStrictEqual(await vol(bob), { v: 0.95, slider: 0.95, saved: 0.95 });
  assert.strictEqual((await vol(alice)).v, 1, 'Alice keeps her volume');
  const before = (await state(alice)).time;
  await bob.keyboard.press('l');
  await waitFor(alice, (t) => Math.abs(document.getElementById('movie').currentTime - (t + 10)) < 0.3, before);
  await bob.keyboard.press('j');
  await waitFor(alice, (t) => Math.abs(document.getElementById('movie').currentTime - t) < 0.3, before);
  await bob.keyboard.press('?');
  await bob.waitForSelector('#keys-dialog[open]');
  const rows = await bob.evaluate(() => [...document.querySelectorAll('#keys-list tr')].map((tr) => tr.textContent));
  assert(rows.some((r) => /↑ \/ ↓/.test(r) && /volume/i.test(r)) && rows.some((r) => /Back \/ forward 10 s/.test(r)), `shortcut list: ${rows.join(' | ')}`);
  await bob.keyboard.press('k');
  await sleep(800);
  assert((await state(alice)).paused, 'with the list open, the keys do nothing else');
  await bob.keyboard.press('Escape');
  await waitFor(bob, () => !document.getElementById('keys-dialog').open);
  await bob.keyboard.press('ArrowUp'); // back to full volume for the rest of the test
  console.log('keyboard: ↑ / ↓ volume, j / l seek, ? lists the shortcuts');

  // Clicks on the picture: a click plays (after a moment: it waits for a second click), a double-click only goes full
  // screen, and a tap (touch) only shows or hides the controls. None of the last two may change the room's playback.
  const seqOf = (p) => p.evaluate(() => room.sync.state.seq);
  const pic = await alice.locator('#movie').boundingBox();
  let seq = await seqOf(bob);
  await alice.mouse.dblclick(pic.x + pic.width / 2, pic.y + pic.height / 2);
  await sleep(1200);
  a = await state(alice);
  assert(a.paused && (await seqOf(bob)) === seq, 'a double-click on the picture does not pause and resume the room');
  await alice.evaluate(() => document.fullscreenElement && document.exitFullscreen());
  await bob.evaluate(() => {
    const v = document.getElementById('movie');
    v.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    v.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
  await sleep(1000);
  a = await state(alice);
  assert(a.paused && (await seqOf(alice)) === seq, 'a tap on the picture does not play the room');
  await alice.mouse.click(pic.x + pic.width / 2, pic.y + pic.height / 2);
  await sleep(1500);
  a = await state(alice); b = await state(bob);
  assert(!a.paused && !b.paused, 'a single click plays for everyone');
  await ctl(alice, '#m-play');
  await sleep(800);
  a = await state(alice); b = await state(bob);
  assert(a.paused && b.paused, 'paused again');
  console.log('clicks on the picture: click plays, double-click and tap leave the room alone');

  // The movie dialog acts on its returnValue when it closes. A close without one (Esc, per the HTML spec, which
  // Firefox and Safari follow) must not repeat the choice made the last time, here "Close the movie for everyone".
  await bob.evaluate(() => { document.getElementById('movie-dialog').returnValue = 'close'; });
  await bob.click('#t-movie');
  await bob.waitForSelector('#movie-dialog[open]');
  await bob.evaluate(() => document.getElementById('movie-dialog').close());
  await sleep(800);
  assert(await alice.evaluate(() => !!room.sync.state.movie), 'the movie is still open for the room');
  assert(await bob.evaluate(() => !!room.sync.localFile && room.player.loaded), 'and Bob still has his copy open');
  console.log('movie dialog: closing without a choice does nothing');

  // Bob seeks to 19.5s via keyboard-free API (seek bar click)
  await ctl(bob, '#m-time');
  const box = await bob.locator('#m-seek').boundingBox();
  await bob.mouse.click(box.x + box.width * (19.5 / 40), box.y + box.height / 2);
  await sleep(1200);
  a = await state(alice); b = await state(bob);
  console.log('seeked:', a.time, b.time);
  assert(Math.abs(a.time - b.time) < 0.2, 'seek synced');

  // Clicking the length at the right end of the seek bar shows the time remaining, and back; the choice is remembered.
  const secs = (s) => s.replace('−', '').split(':').reduce((acc, x) => acc * 60 + Number(x), 0);
  const length = await bob.textContent('#m-duration');
  await ctl(bob, '#m-duration');
  const left = await bob.textContent('#m-duration');
  assert(left.startsWith('−'), `remaining time shown: ${left}`);
  assert(Math.abs(secs(await bob.textContent('#m-time')) + secs(left) - secs(length)) <= 1, `elapsed + remaining = length (${left} of ${length})`);
  assert.strictEqual(await bob.evaluate(() => localStorage.getItem('te.movieRemaining')), 'true');
  await ctl(bob, '#m-duration');
  assert.strictEqual(await bob.textContent('#m-duration'), length, 'clicking again shows the length');
  assert.strictEqual(await bob.evaluate(() => localStorage.getItem('te.movieRemaining')), null);
  console.log('length / remaining toggle ok');

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

  // Bob hides the subtitles just for himself: Alice keeps hers; "Same as everyone" brings them back
  const mine = (page, label) => page.locator('#m-subs-menu h4:text-is("Just for me") ~ button', { hasText: label }).first();
  await ctl(bob, '#m-subs');
  await mine(bob, 'Off').click();
  await sleep(500);
  a = await state(alice); b = await state(bob);
  console.log('bob hid subtitles for himself:', JSON.stringify(a.subs), JSON.stringify(b.subs));
  assert(b.subs === '' && /seconds/.test(a.subs), 'subtitles off only for bob');
  await ctl(bob, '#m-subs');
  await mine(bob, 'Same as everyone').click();
  await sleep(500);
  b = await state(bob);
  assert(b.subs !== '', 'bob follows the room again');

  // Bob loads a subtitle file just for himself: it is on for him, and Alice never hears of it
  await bob.setInputFiles('#my-sub-file', path.resolve(__dirname, 'fixtures', 'subs_en.srt'));
  await sleep(800);
  const subOf = (page) => page.evaluate(() => ({ id: window.room.player.subtitleId, menu: document.getElementById('m-subs-menu').innerText }));
  const bobMine = await subOf(bob);
  const aliceView = await subOf(alice);
  console.log('bob loaded a file for himself:', bobMine.id, aliceView.id);
  assert(/^p/.test(bobMine.id) && /Just for me[\s\S]*subs_en[\s\S]*Load a file just for me/.test(bobMine.menu), 'private file on for bob');
  assert(!/^p/.test(aliceView.id) && !/subs_en/.test(aliceView.menu), 'alice does not get bob\'s private file');
  await ctl(bob, '#m-subs');
  await mine(bob, 'Same as everyone').click();

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
  // Another film under the room movie's file name: once its content is known to differ, Carol is asked (she
  // cancels) instead of quietly watching it alone.
  const fs = require('fs');
  const os = require('os');
  const odd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-e2e-')), path.basename(MOVIE));
  fs.copyFileSync(path.resolve(__dirname, 'fixtures', 'single.mp4'), odd);
  await carol.setInputFiles('#movie-file', odd);
  await waitFor(carol, () => document.getElementById('mismatch-dialog').open, null, 20000);
  console.log('mismatch asked after load:', await carol.evaluate(() => document.getElementById('mismatch-text').textContent));
  await carol.click('#mismatch-dialog button[value="cancel"]');
  await waitFor(carol, () => !window.room.player.file && !window.room.sync.localFile);
  fs.rmSync(path.dirname(odd), { recursive: true, force: true });
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
