// Picture-in-picture test (Chromium): Document PiP keeps our subtitles and
// controls and drives the room; without it, the native video PiP gets the
// subtitles as a caption track; the compact style draws video + subtitles on a
// canvas that plays in native PiP.
// Usage: node test/pip-check.js   (server on BASE, default http://localhost:4567, ADMIN_PASSWORD=test)
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const BASE = process.env.BASE || 'http://localhost:4567';
const ADMIN = process.env.ADMIN_PASSWORD || 'test';
const MOVIE = path.resolve(__dirname, 'fixtures', 'multi.mkv');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });

async function ctl(page, sel) {
  // Movie controls auto-hide; move the mouse over the player first.
  const box = await page.locator('#movie-box').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 3);
  await page.click(sel);
}

// Click something inside the Document PiP window (it is not a Playwright page).
const pipClick = (page, sel) => page.evaluate((s) => documentPictureInPicture.window.document.querySelector(s).click(), sel);
const pipText = (page, sel) => page.evaluate((s) => documentPictureInPicture.window.document.querySelector(s).textContent.trim(), sel);
const movie = (page) => page.evaluate(() => {
  const v = document.getElementById('movie') || documentPictureInPicture.window?.document.getElementById('movie');
  return { paused: v.paused, time: room.player.time };
});

async function createRoom(browser, name) {
  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(BASE + '/admin');
  await admin.fill('#login-password', ADMIN);
  await admin.click('#login-form button');
  await admin.waitForSelector('#panel:not([hidden])');
  await admin.fill('#create-name', name);
  await admin.fill('#create-password', 'secret');
  await admin.click('#create-form button');
  await admin.waitForSelector(`#rooms a[href$="/${name}"]`);
  await ctx.close();
}

// Alice and Bob in a fresh room, both with the movie loaded and ready.
async function pair(browser, label, { aliceInit } = {}) {
  const room = `pip-${label}-${Date.now().toString(36)}`;
  await createRoom(browser, room);
  const pages = [];
  for (const name of ['Alice', 'Bob']) {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
    if (name === 'Alice' && aliceInit) await ctx.addInitScript(aliceInit);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
    await page.goto(`${BASE}/${room}?debug`);
    await page.fill('#lobby-name', name);
    await page.fill('#lobby-password', 'secret');
    await page.click('#lobby-join');
    await page.waitForSelector('#room:not([hidden])');
    pages.push(page);
  }
  const [alice, bob] = pages;
  await alice.setInputFiles('#movie-file', MOVIE);
  await waitFor(alice, () => !document.getElementById('stage').hidden && document.getElementById('movie').readyState >= 2, null, 20000);
  await waitFor(bob, () => document.getElementById('movie-overlay').textContent.includes('Choose'));
  await bob.setInputFiles('#movie-file', MOVIE);
  await waitFor(bob, () => document.getElementById('movie').readyState >= 2, null, 20000);
  await waitFor(alice, () => /Everyone ready/.test(document.getElementById('m-ready').textContent));
  return { alice, bob };
}

async function chooseEnglish(page, click) {
  await click('#m-subs');
  await page.evaluate(() => {
    const doc = document.getElementById('m-subs-menu') ? document : documentPictureInPicture.window.document;
    [...doc.querySelectorAll('#m-subs-menu button')].find((b) => /English/.test(b.textContent)).click();
  });
}

async function documentPip(browser) {
  console.log('--- Document Picture-in-Picture');
  const { alice, bob } = await pair(browser, 'doc');
  assert(await alice.evaluate(() => !document.getElementById('m-pip').hidden), '#m-pip should be visible');

  await ctl(alice, '#m-pip'); // real click: requestWindow needs a user gesture
  await waitFor(alice, () => !!documentPictureInPicture.window?.document.getElementById('movie-box'));
  const where = await alice.evaluate(() => {
    const win = documentPictureInPicture.window;
    return {
      inPip: !!win.document.getElementById('movie-box'),
      inMain: !!document.getElementById('movie-box'),
      bodyClass: win.document.body.className,
      icons: win.document.querySelectorAll('symbol').length > 10,
      styled: getComputedStyle(win.document.getElementById('movie-box')).position === 'fixed',
      placeholder: document.getElementById('stage').textContent,
      renderOwner: room.player._rafWin === win,
    };
  });
  console.log('after open:', where);
  assert(where.inPip && !where.inMain, 'movie box moved into the PiP window');
  assert.match(where.bodyClass, /pip-window/);
  assert(where.icons && where.styled, 'PiP document has the icon sprite and styles');
  assert.match(where.placeholder, /Playing in a floating window/);
  assert(where.renderOwner, 'subtitle render loop runs on the PiP window');

  // Play from inside the PiP window.
  await pipClick(alice, '#m-play');
  await sleep(3000);
  const t1 = await movie(alice);
  const b1 = await movie(bob);
  console.log('playing:', t1, b1);
  assert(!t1.paused && !b1.paused, 'both playing');
  await sleep(1000);
  const t2 = await movie(alice);
  assert(t2.time > t1.time + 0.8, 'Alice keeps advancing inside PiP');
  const b2 = await movie(bob);
  assert(Math.abs(t2.time - b2.time) < 0.3, `in sync: ${t2.time} vs ${b2.time}`);

  // Subtitles through the PiP menus, then seek with the PiP seek bar.
  await chooseEnglish(alice, (sel) => pipClick(alice, sel));
  await alice.evaluate(() => {
    const doc = documentPictureInPicture.window.document;
    const bar = doc.getElementById('m-seek');
    const r = bar.getBoundingClientRect();
    const x = r.left + r.width * (20.5 / room.sync.state.movie.duration);
    const ev = (type) => new PointerEvent(type, { clientX: x, clientY: r.top + 5, pointerId: 1, bubbles: true });
    bar.dispatchEvent(ev('pointerdown'));
    bar.dispatchEvent(ev('pointerup'));
  });
  await waitFor(alice, () => documentPictureInPicture.window.document.getElementById('subs-layer').textContent.includes('Twenty seconds'));
  console.log('PiP subtitles:', await pipText(alice, '#subs-layer'));
  await waitFor(bob, () => room.player.time > 20);

  // Pause from inside the PiP window pauses Bob.
  await pipClick(alice, '#m-play');
  await waitFor(bob, () => document.getElementById('movie').paused);
  assert((await movie(alice)).paused, 'Alice paused');
  console.log('PiP pause reached Bob');

  // Resume, close the window: box returns, playback continues.
  await pipClick(alice, '#m-play');
  await waitFor(bob, () => !document.getElementById('movie').paused);
  await sleep(1000);
  await alice.evaluate(() => documentPictureInPicture.window.close());
  await waitFor(alice, () => document.getElementById('stage').contains(document.getElementById('movie-box')));
  const back = await alice.evaluate(() => ({ placeholder: !!document.getElementById('pip-placeholder'), pip: !!documentPictureInPicture.window, paused: room.sync.state.paused, icon: document.querySelector('#m-pip use').getAttribute('href') }));
  assert(!back.placeholder && !back.pip && !back.paused && back.icon === '#i-pip', JSON.stringify(back));
  await sleep(2000);
  const a3 = await movie(alice), b3 = await movie(bob);
  console.log('after close:', a3, b3);
  assert(!a3.paused && !b3.paused, 'still playing after closing PiP');
  assert(Math.abs(a3.time - b3.time) < 0.35, 'still in sync after closing PiP');
  assert.strictEqual(await alice.evaluate(() => navigator.mediaSession.metadata?.title), 'multi.mkv', 'media session metadata');

  // The "p" shortcut opens it too.
  await alice.mouse.move(300, 300);
  await alice.keyboard.press('p');
  await waitFor(alice, () => !!documentPictureInPicture.window?.document.getElementById('m-pip'));
  await pipClick(alice, '#m-pip');
  await waitFor(alice, () => !documentPictureInPicture.window && document.getElementById('stage').contains(document.getElementById('movie-box')));
  console.log('"p" shortcut and return button OK');
  await alice.context().close();
  await bob.context().close();
}

async function nativePip(browser) {
  console.log('--- Native video Picture-in-Picture + caption track');
  const { alice, bob } = await pair(browser, 'native', { aliceInit: () => { delete window.documentPictureInPicture; } });
  assert(await alice.evaluate(() => !('documentPictureInPicture' in window)), 'Document PiP should be removed for Alice');
  assert(await alice.evaluate(() => !document.getElementById('m-pip').hidden), '#m-pip should be visible with native PiP');

  await ctl(alice, '#m-play');
  await waitFor(bob, () => !document.getElementById('movie').paused);
  await chooseEnglish(alice, (sel) => ctl(alice, sel));
  await alice.evaluate(() => room.sync.seek(20.5));
  const track = (page) => page.evaluate(() => {
    const t = [...document.getElementById('movie').textTracks].find((x) => x.label === 'Subtitles');
    return t ? { mode: t.mode, cues: [...(t.cues || [])].map((c) => c.text), first: t.cues?.[0] && [t.cues[0].startTime, t.cues[0].endTime] } : null;
  });
  await waitFor(alice, () => [...document.getElementById('movie').textTracks].some((x) => x.label === 'Subtitles' && x.cues.length > 1));
  let tr = await track(alice);
  console.log('track before PiP:', tr);
  assert.strictEqual(tr.mode, 'hidden', 'caption track is hidden while in the page');
  assert(tr.cues.some((c) => c.includes('Twenty seconds')), 'track mirrors our cues');

  await ctl(alice, '#m-pip');
  const entered = await alice.waitForFunction(() => document.pictureInPictureElement === document.getElementById('movie'), null, { timeout: 5000 }).then(() => true, () => false);
  if (entered) {
    tr = await track(alice);
    console.log('native PiP entered; track:', tr.mode);
    assert.strictEqual(tr.mode, 'showing', 'caption track is showing in PiP');
  } else {
    console.log('NOTE: headless Chromium refused native PiP; checking the "showing" mode through setNativeCaptionsMode instead');
    await alice.evaluate(() => room.player.setNativeCaptionsMode('showing'));
    tr = await track(alice);
    assert.strictEqual(tr.mode, 'showing');
  }
  assert(tr.cues.some((c) => c.includes('Twenty seconds')));

  // A pause made by the PiP UI toggles the element directly, not through sync.
  await sleep(2500); // let the load-time self-change window (priming, caption setup) pass
  await alice.evaluate(() => document.getElementById('movie').pause());
  await waitFor(bob, () => document.getElementById('movie').paused, null, 5000);
  assert(await alice.evaluate(() => room.sync.state.paused), 'Alice committed the pause');
  await sleep(800); // past our own self-change window
  await alice.evaluate(() => document.getElementById('movie').play());
  await waitFor(bob, () => !document.getElementById('movie').paused, null, 5000);
  console.log('native pause/play reached Bob');

  if (entered) {
    await alice.evaluate(() => document.exitPictureInPicture());
    await waitFor(alice, () => !document.pictureInPictureElement);
    assert.strictEqual((await track(alice)).mode, 'hidden', 'back to hidden after leaving PiP');
  }
  await alice.context().close();
  await bob.context().close();
}

async function compactPip(browser) {
  console.log('--- Compact Picture-in-Picture (canvas stream in native PiP)');
  const { alice, bob } = await pair(browser, 'compact');
  // The style is chosen in the settings dialog (Document PiP is available in Chromium).
  await alice.click('#t-settings');
  await alice.waitForSelector('#settings-dialog[open]');
  assert(await alice.isVisible('#set-pipstyle'), '#set-pipstyle should be visible in Chromium');
  assert.strictEqual(await alice.inputValue('#set-pipstyle'), 'floating', 'floating is the default');
  await alice.selectOption('#set-pipstyle', 'compact');
  assert.strictEqual(await alice.evaluate(() => localStorage.getItem('te.pipStyle')), '"compact"');
  await alice.click('#settings-dialog button.primary');
  await alice.waitForSelector('#settings-dialog:not([open])');

  await ctl(alice, '#m-play');
  await waitFor(bob, () => !document.getElementById('movie').paused);
  await chooseEnglish(alice, (sel) => ctl(alice, sel));

  await ctl(alice, '#m-pip');
  await waitFor(alice, () => document.pictureInPictureElement?.srcObject instanceof MediaStream, null, 8000);
  const where = await alice.evaluate(() => ({
    movieInPage: !!document.getElementById('stage').contains(document.getElementById('movie-box')),
    docPip: !!documentPictureInPicture.window,
    active: document.getElementById('m-pip').classList.contains('active'),
    icon: document.querySelector('#m-pip use').getAttribute('href'),
    playbackState: navigator.mediaSession.playbackState,
  }));
  console.log('compact open:', where);
  assert(where.movieInPage && !where.docPip, 'compact mode keeps the movie in the page');
  assert(where.active && where.icon === '#i-pip-exit', 'PiP button shows the active state');
  assert.strictEqual(where.playbackState, 'playing');
  await sleep(1500);
  const a1 = await movie(alice), b1 = await movie(bob);
  assert(!a1.paused && !b1.paused, 'both still playing');
  assert(Math.abs(a1.time - b1.time) < 0.3, `in sync: ${a1.time} vs ${b1.time}`);

  // Our subtitles are drawn into the canvas.
  await alice.evaluate(() => room.sync.seek(21));
  await waitFor(alice, () => room.compactPip.lastText.includes('Twenty seconds'));
  await sleep(500);
  const px = await alice.evaluate(() => {
    const c = room.compactPip.canvas;
    const ctx = c.getContext('2d');
    const stat = (x, y, w, h) => {
      const d = ctx.getImageData(Math.round(x), Math.round(y), Math.round(w), Math.round(h)).data;
      let bright = 0, nonBlack = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 60) nonBlack++;
        if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) bright++;
      }
      return { nonBlack, bright, n: d.length / 4 };
    };
    return {
      w: c.width, h: c.height,
      video: stat(0, c.height * 0.15, c.width, c.height * 0.5),
      band: stat(c.width * 0.2, c.height * 0.8, c.width * 0.6, c.height * 0.14),
    };
  });
  console.log('canvas pixels:', px);
  assert(px.video.nonBlack > px.video.n * 0.05, 'video area has picture');
  assert(px.band.bright > 50, 'subtitle band has white text pixels');

  // A pause made on the proxy element (what the PiP button may do) reaches the room.
  await sleep(700);
  await alice.evaluate(() => document.pictureInPictureElement.pause());
  await waitFor(bob, () => document.getElementById('movie').paused, null, 5000);
  await waitFor(alice, () => navigator.mediaSession.playbackState === 'paused');
  assert(await alice.evaluate(() => room.sync.state.paused), 'Alice committed the pause');
  await sleep(800);
  assert(await alice.evaluate(() => !document.pictureInPictureElement.paused), 'proxy resumed so the picture keeps updating');
  console.log('compact pause reached Bob');
  await alice.evaluate(() => document.pictureInPictureElement.play()); // a play we did not cause
  await waitFor(bob, () => !document.getElementById('movie').paused, null, 5000);
  await waitFor(alice, () => navigator.mediaSession.playbackState === 'playing');

  // Leaving PiP removes the proxy and stops the loop.
  await alice.evaluate(() => { window.__cp = room.compactPip; });
  await alice.evaluate(() => document.exitPictureInPicture());
  await waitFor(alice, () => !document.pictureInPictureElement && !room.compactPip);
  const after = await alice.evaluate(() => ({
    videos: [...document.querySelectorAll('video')].filter((v) => v.srcObject instanceof MediaStream).length,
    active: window.__cp.active,
    worker: !!window.__cp._worker,
    canvas: !!window.__cp.canvas,
    btn: document.getElementById('m-pip').classList.contains('active'),
  }));
  assert.deepStrictEqual(after, { videos: 0, active: false, worker: false, canvas: false, btn: false });

  // Changing the setting while PiP is open closes it.
  await ctl(alice, '#m-pip');
  await waitFor(alice, () => document.pictureInPictureElement?.srcObject instanceof MediaStream, null, 8000);
  await alice.click('#t-settings');
  await alice.selectOption('#set-pipstyle', 'floating');
  await waitFor(alice, () => !document.pictureInPictureElement && !room.compactPip);
  console.log('setting change closed compact PiP');
  await alice.context().close();
  await bob.context().close();
}

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  await documentPip(browser);
  await nativePip(browser);
  await compactPip(browser);
  await browser.close();
  console.log('PIP OK');
})().catch((err) => {
  console.error('PIP FAILED', err);
  process.exit(1);
});
