// Browser test for screen sharing: Alice shares her screen and Bob sees it on the stage; Carol, who joins
// during the share, sees it too; only one person can share at a time; a movie and a share exclude each other;
// stopping (from the room or from the browser's own "Stop sharing") clears it for everyone.
// Chromium's fake capture devices stand in for the screen and the camera.
// Usage: node test/screen-check.js   (expects the server on BASE, default http://localhost:4567, ADMIN_PASSWORD=test)
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const BASE = process.env.BASE || 'http://localhost:4567';
const ADMIN = process.env.ADMIN_PASSWORD || 'test';
const MOVIE = path.resolve(__dirname, 'fixtures', 'multi.mkv');
const ROOM = 'screen-' + Date.now().toString(36);
const waitFor = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });

// The stage shows a picture: a shared screen with frames.
const seesScreen = (label) => {
  const v = document.getElementById('screen-video');
  return !document.getElementById('screen-stage').hidden && v.videoWidth > 0 && v.readyState >= 2 && (!label || document.getElementById('screen-label').textContent.includes(label));
};
const noScreen = () => document.getElementById('screen-stage').hidden;
const lastToast = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ');

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const admin = await browser.newPage();
    await admin.goto(BASE + '/admin');
    await admin.fill('#login-password', ADMIN);
    await admin.click('#login-form button');
    await admin.waitForSelector('#panel:not([hidden])');
    await admin.fill('#create-name', ROOM);
    await admin.fill('#create-password', 'secret');
    await admin.click('#create-form button');
    await admin.waitForSelector(`#rooms a[href$="/${ROOM}"]`);
    await admin.close();

    const join = async (name) => {
      const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
      page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name} console]`, m.text()); });
      await page.goto(`${BASE}/${ROOM}?debug`);
      await page.waitForSelector('#lobby:not([hidden])');
      await page.fill('#lobby-name', name);
      await page.fill('#lobby-password', 'secret');
      await page.click('#lobby-join');
      await page.waitForSelector('#room:not([hidden])');
      return page;
    };
    const cameras = (page, n) => waitFor(page, (n) => [...document.querySelectorAll('.tile:not(.self) video')].filter((v) => v.videoWidth > 0).length >= n, n);

    const alice = await join('Alice');
    const bob = await join('Bob');
    await cameras(alice, 1);
    await cameras(bob, 1);
    assert.strictEqual(await alice.isVisible('#t-share'), true, 'the share button shows where sharing is supported');
    assert.strictEqual(await bob.evaluate(noScreen), true);
    console.log('both joined, cameras flowing');

    // --- Alice shares
    await alice.click('#t-share');
    await waitFor(alice, () => window.room.screen.active && !document.getElementById('screen-mine').hidden);
    assert.match(await alice.textContent('#t-share span'), /Stop sharing/);
    await waitFor(bob, seesScreen, 'Alice');
    assert.strictEqual(await bob.evaluate(() => document.getElementById('main').classList.contains('watching')), true, 'the share takes the stage');
    assert.strictEqual(await bob.evaluate(() => document.getElementById('screen-mine').hidden), true);
    // Bob still sees Alice's camera in her tile: the screen did not replace it.
    await cameras(bob, 1);
    const ids = await bob.evaluate(() => {
      const p = [...window.room.mesh.peers.values()][0];
      return { cam: p.stream.getVideoTracks()[0]?.id, screen: p.screenStream.getVideoTracks()[0]?.id, tile: document.querySelector('.tile:not(.self) video').srcObject?.getVideoTracks()[0]?.id };
    });
    assert.ok(ids.cam && ids.screen && ids.cam !== ids.screen, 'camera and screen are separate tracks: ' + JSON.stringify(ids));
    assert.strictEqual(ids.tile, ids.cam, 'the tile shows the camera');
    console.log('Bob sees Alice’s screen on the stage, and her camera in her tile');

    // --- Carol joins during the share
    const carol = await join('Carol');
    await waitFor(carol, seesScreen, 'Alice');
    console.log('Carol, joining mid-share, sees it');

    // --- one share at a time
    await bob.click('#t-share');
    await waitFor(bob, (s) => document.body.textContent.includes(s), 'Alice is sharing their screen');
    assert.strictEqual(await bob.evaluate(() => window.room.screen.active), false);
    console.log('a second share is refused');

    // --- no movie during a share
    await bob.click('#t-movie');
    await waitFor(bob, (s) => document.body.textContent.includes(s), 'Start the movie when they stop');
    assert.strictEqual(await bob.evaluate(() => document.getElementById('movie-dialog').open), false);
    await bob.setInputFiles('#movie-file', MOVIE); // even the file input is refused
    await bob.waitForTimeout(500);
    assert.strictEqual(await bob.evaluate(() => !!window.room.sync.localFile || !!window.room.loadingMovie), false);
    console.log('a movie is refused during a share');

    // --- the People list shows the sharer
    await bob.click('#t-chat');
    await bob.click('.tab[data-tab="people"]');
    await waitFor(bob, () => [...document.querySelectorAll('#people li')].some((li) => li.textContent.includes('Alice') && li.querySelector('use[href="#i-screen"]')));

    // --- Alice stops from the room
    await alice.click('#screen-stop');
    for (const p of [alice, bob, carol]) await waitFor(p, noScreen);
    assert.match(await alice.textContent('#t-share span'), /Share screen/);
    console.log('stopping clears the stage for everyone');

    // --- Bob shares now; the browser's own "Stop sharing" (the track ends) also stops it
    await bob.click('#t-share');
    await waitFor(alice, seesScreen, 'Bob');
    await waitFor(carol, seesScreen, 'Bob');
    await bob.evaluate(() => {
      const t = window.room.screen.track;
      t.stop();
      t.dispatchEvent(new Event('ended')); // stop() alone does not fire it; the browser's button does
    });
    for (const p of [alice, bob, carol]) await waitFor(p, noScreen);
    console.log('a second share works on the same links, and the browser’s stop ends it');

    // --- no share during a movie
    await alice.setInputFiles('#movie-file', MOVIE);
    await waitFor(bob, () => !document.getElementById('stage').hidden);
    await bob.click('#t-share');
    await waitFor(bob, (s) => document.body.textContent.includes(s), 'Close the movie first');
    assert.strictEqual(await bob.evaluate(() => window.room.screen.active), false);
    console.log('a share is refused during a movie');

    console.log('OK screen-check');
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
