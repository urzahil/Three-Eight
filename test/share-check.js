// Browser test for watching from a friend's copy: a room WITHOUT a Google Drive folder. Alice opens a local file;
// Bob has none, sees "Stream from Alice's copy", and plays it in sync with her, streamed over WebRTC from her
// browser (nothing goes through our server). Also: the Settings opt-out, and a friend leaving.
// Starts its own server. Fixtures: `bash test/make-fixtures.sh` first.
// Usage: node test/share-check.js
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');

const FIX = path.resolve(__dirname, 'fixtures');
const MOVIE = path.join(FIX, 'multi.mkv');
const ADMIN = 'test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOM = 'share-' + Date.now().toString(36);
const ROOM2 = ROOM + '-relay';
const MEASURE_ONLY = !!process.env.MEASURE_ONLY; // only the upload measurement (to run it against an older commit)
const waitFor = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });
const state = (p) => p.evaluate(() => ({ paused: document.getElementById('movie').paused, time: window.room.player.time }));
async function ctl(page, sel) {
  const box = await page.locator('#movie-box').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 3);
  await page.click(sel);
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-share-'));
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_PASSWORD: ADMIN, TRUST_PROXY: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) return { base, child, dir };
    } catch { /* not up yet */ }
    await sleep(100);
  }
  child.kill();
  throw new Error('server did not start');
}

(async () => {
  if (!fs.existsSync(MOVIE)) throw new Error('fixtures missing: run `bash test/make-fixtures.sh` first');
  const { base: BASE, child, dir } = await startServer();
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const login = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const made = await fetch(BASE + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: ROOM, password: 'secret' }) });
    assert.equal(made.status, 201);
    assert.equal((await fetch(BASE + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: ROOM2, password: 'secret' }) })).status, 201);

    const pages = [];
    async function join(name, room = ROOM) {
      const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
      const page = await ctx.newPage();
      const movieBytes = []; // anything our server sends that looks like movie data
      page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
      page.on('response', (res) => {
        const u = new URL(res.url());
        if (u.origin === BASE && /\/drive\/|\.mkv|\.mp4/.test(u.pathname)) movieBytes.push(u.pathname);
      });
      await page.goto(`${BASE}/${room}?debug`);
      await page.fill('#lobby-name', name);
      await page.fill('#lobby-password', 'secret');
      await page.click('#lobby-join');
      await page.waitForSelector('#room:not([hidden])');
      const v = { page, ctx, movieBytes, name };
      pages.push(v);
      return v;
    }
    basic: {
    if (MEASURE_ONLY) break basic;
    const A = await join('Alice');
    const B = await join('Bob');
    const [alice, bob] = [A.page, B.page];
    await waitFor(alice, () => room.mesh.peers.size === 1 && [...room.mesh.peers.values()].every((p) => p.filmOpen));
    await waitFor(bob, () => room.mesh.peers.size === 1 && [...room.mesh.peers.values()].every((p) => p.filmOpen));
    console.log('both joined; the film channel is open');

    // --- Alice opens her file: the room's movie. Bob has no file and is offered her copy.
    await alice.click('#t-movie');
    await alice.waitForSelector('#movie-dialog[open]');
    assert.match(await alice.textContent('#movie-dialog-text'), /stream it from your copy/i);
    assert.doesNotMatch(await alice.textContent('#movie-dialog-text'), /everyone needs/i);
    await alice.setInputFiles('#movie-file', MOVIE);
    await waitFor(alice, () => document.getElementById('movie').readyState >= 2);
    await waitFor(bob, () => document.getElementById('movie-overlay').textContent.includes("Stream from Alice's copy"));
    const overlay = await bob.textContent('#movie-overlay');
    assert(overlay.includes('Use my own copy') && !overlay.includes('Google Drive'), 'the overlay: ' + overlay);

    // --- Bob streams from her copy
    await bob.click('#movie-overlay button:has-text("Stream from Alice\'s copy")');
    await waitFor(bob, () => document.getElementById('movie').readyState >= 2 && room.player.file?.peerOnly);
    assert.strictEqual(await bob.evaluate(() => room.player.mode), 'mse', 'a film from a friend always plays through the remuxer');
    await waitFor(alice, () => /Everyone ready/.test(document.getElementById('m-ready').textContent));
    const people = await bob.evaluate(() => {
      room._renderPeople();
      return room._sourceText(room.id, 'peers') + ' | ' + room._sourceText([...room.mesh.peers.keys()][0], 'file');
    });
    assert.match(people, /streaming \(from Alice\) \| own copy/);
    console.log('bob streams from alice:', people);

    await ctl(alice, '#m-play');
    await sleep(4000);
    let a = await state(alice), b = await state(bob);
    assert(!a.paused && !b.paused && Math.abs(a.time - b.time) < 0.4 && b.time > 2, `playing in sync: ${a.time} ${b.time}`);
    await ctl(bob, '#m-play');
    await sleep(800);
    a = await state(alice); b = await state(bob);
    assert(a.paused && b.paused && Math.abs(a.time - b.time) < 0.15, 'pause synced');
    // seek (Bob's player reads a region it has not fetched yet)
    await ctl(bob, '#m-time');
    const box = await bob.locator('#m-seek').boundingBox();
    await bob.mouse.click(box.x + box.width * (30 / 40), box.y + box.height / 2);
    await sleep(2500);
    a = await state(alice); b = await state(bob);
    assert(a.time > 28 && Math.abs(a.time - b.time) < 0.2, `seek synced: ${a.time} ${b.time}`);
    // audio track change
    await ctl(bob, '#m-audio');
    await bob.click('#m-audio-menu button:nth-of-type(2)');
    await sleep(1500);
    assert((await alice.$$eval('#m-audio-menu button.on span', (s) => s.map((x) => x.textContent))).some((t) => /Italiano/.test(t)), 'audio track synced to Alice');
    assert((await bob.$$eval('#m-audio-menu button.on span', (s) => s.map((x) => x.textContent))).some((t) => /Italiano/.test(t)), 'and Bob\'s own player switched');
    await ctl(alice, '#m-play');
    await sleep(3500);
    a = await state(alice); b = await state(bob);
    assert(!a.paused && !b.paused && Math.abs(a.time - b.time) < 0.4, `still in sync after the audio change: ${a.time} ${b.time}`);

    const swarm = await Promise.all([alice, bob].map((p) => p.evaluate(() => ({ ...room.swarm.stats, cached: room.player.file.cachedPieces?.(1048576) || null }))));
    console.log(`swarm: alice served ${swarm[0].served} bytes; bob received ${swarm[1].peers} bytes from her; pieces bob holds: ${JSON.stringify(swarm[1].cached)}`);
    assert(swarm[0].served > 1000000 && swarm[1].peers > 1000000, 'the film travelled from Alice to Bob');
    assert.strictEqual(swarm[1].server, 0);
    assert.deepStrictEqual(B.movieBytes, [], 'nothing of the film came from our server');
    assert.deepStrictEqual(A.movieBytes, []);

    // --- a third friend with the Settings opt-out: she keeps her own copy private. With sharing off, no one is offered it.
    await alice.click('#t-settings');
    await alice.waitForSelector('#settings-dialog[open]');
    assert.strictEqual(await alice.isChecked('#set-share'), true, 'sharing is on by default');
    await alice.uncheck('#set-share');
    await alice.keyboard.press('Escape');
    assert.strictEqual(await alice.evaluate(() => JSON.parse(localStorage.getItem('te.shareFile'))), false, 'the choice is remembered');
    const C = await join('Carol');
    await sleep(1500);
    await waitFor(C.page, () => !document.getElementById('movie-overlay').hidden && document.getElementById('movie-overlay').textContent.includes('Choose file'));
    const ov = await C.page.textContent('#movie-overlay');
    assert(!ov.includes('Stream from') && ov.includes('Choose file'), 'with sharing off, Carol is not offered a stream: ' + ov);
    assert.deepStrictEqual(await C.page.evaluate(() => room.swarm.holders(room.sync.state.movie)), []);
    // Bob (already streaming) is not affected beyond new requests, and Alice's own movie keeps playing
    assert.deepStrictEqual(await alice.evaluate(() => room.swarm._haveMessage()), { type: 'film-have', key: null, local: false, ranges: [], via: '' });
    // Carol asks anyway (a modified client): Alice does not serve her file
    const aliceId = await alice.evaluate(() => room.id);
    const servedBefore = await alice.evaluate(() => room.swarm.stats.served);
    const denied = await C.page.evaluate(async (aliceId) => {
      const m = room.sync.state.movie;
      room.swarm.have.clear(); // Bob would relay what he has: only Alice is asked here
      room.swarm.have.set(aliceId, { key: `s:${m.size}`, local: true, ranges: [[0, 4]], via: 'file' }); // as if she still advertised it
      const rf = room.swarm.openRemote({ name: m.name, size: m.size });
      rf.swarm.activate();
      try {
        await rf.slice(0, 1000).arrayBuffer();
        return 'served';
      } catch (err) {
        return err.message;
      } finally {
        rf.close();
      }
    }, aliceId);
    assert.match(denied, /Could not get this part of the movie from your friends/);
    assert.strictEqual(await alice.evaluate(() => room.swarm.stats.served), servedBefore, 'Alice did not serve a byte of her file');
    console.log('opt-out: no stream button, and the file is not served:', denied);
    // switching it on again offers it again
    await alice.click('#t-settings');
    await alice.check('#set-share');
    await alice.keyboard.press('Escape');
    await waitFor(C.page, () => document.getElementById('movie-overlay').textContent.includes("Stream from Alice's copy"));
    console.log('opt-in again: the button is back');

    // --- Alice leaves: Bob, who has fetched what he plays, keeps the picture until he needs more; the room carries on
    await A.ctx.close();
    await waitFor(bob, () => room.mesh.peers.size === 1);
    assert.strictEqual(await bob.evaluate(() => room.swarm.holders(room.sync.state.movie).length), 0);
    }

    // --- one sharer, three streamers: friends pass pieces on, so Alice uploads about one copy, not one per friend
    {
      const BIG = path.join(FIX, 'big.mkv');
      if (!fs.existsSync(BIG)) {
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=160', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=160', '-vf', 'noise=alls=60:allf=t+u', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3M', '-g', '48', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', BIG]);
      }
      const bigSize = fs.statSync(BIG).size;
      const A2 = await join('Alice', ROOM2);
      const others = [];
      for (const n of ['Bob', 'Carol', 'Dave']) others.push(await join(n, ROOM2));
      const alice = A2.page;
      const ps = others.map((o) => o.page);
      await alice.setInputFiles('#movie-file', BIG);
      await waitFor(alice, () => document.getElementById('movie').readyState >= 2);
      await Promise.all(ps.map((p) => waitFor(p, () => document.getElementById('movie-overlay').textContent.includes("Stream from Alice's copy"))));
      await Promise.all(ps.map((p) => p.click('#movie-overlay button:has-text("Stream from Alice\'s copy")')));
      await Promise.all(ps.map((p) => waitFor(p, () => document.getElementById('movie').readyState >= 2 && room.player.file?.peerOnly)));
      await waitFor(alice, () => /Everyone ready/.test(document.getElementById('m-ready').textContent));
      const all = [alice, ...ps];
      const settle = async (pages, min, tol = 0.5) => {
        for (let i = 0; i < 60; i++) {
          const ts = await Promise.all(pages.map(state));
          const spread = Math.max(...ts.map((x) => x.time)) - Math.min(...ts.map((x) => x.time));
          if (ts.every((x) => !x.paused && x.time > min) && spread < tol) return ts;
          await sleep(500);
        }
        return Promise.all(pages.map(state));
      };
      const seekAll = async (sec) => {
        await ctl(ps[0], '#m-time');
        const bx = await ps[0].locator('#m-seek').boundingBox();
        await ps[0].mouse.click(bx.x + bx.width * (sec / 160), bx.y + bx.height / 2);
        await sleep(3000);
      };
      await ctl(alice, '#m-play');
      await sleep(7000);
      let t = await settle(all, 5);
      assert(t.every((x) => !x.paused) && Math.max(...t.map((x) => x.time)) - Math.min(...t.map((x) => x.time)) < 0.5, 'four viewers in sync: ' + JSON.stringify(t.map((x) => x.time)));
      await seekAll(100);
      t = await settle(all, 99.5);
      assert(t.every((x) => x.time > 99.5) && Math.max(...t.map((x) => x.time)) - Math.min(...t.map((x) => x.time)) < 0.5, 'seek in sync: ' + JSON.stringify(t.map((x) => x.time)));
      await sleep(3000);
      const st = await Promise.all(ps.map((p) => p.evaluate(() => ({ ...room.swarm.stats, cached: room.player.file.cachedPieces(1048576) }))));
      const needed = new Set();
      for (const x of st) for (const [f0, l0] of x.cached) for (let k = f0; k <= l0; k++) needed.add(k);
      const neededBytes = [...needed].reduce((n, k) => n + Math.min(1048576, bigSize - k * 1048576), 0);
      const streamed = st.reduce((n, x) => n + x.peers, 0);
      const up = await alice.evaluate(() => room.swarm.stats.served);
      console.log(`MEASURE sharer upload, 3 streamers: Alice uploaded ${(up / 1048576).toFixed(1)} MiB; the streamers needed ${(neededBytes / 1048576).toFixed(1)} MiB of the film (they received ${(streamed / 1048576).toFixed(1)} MiB in all) = ${(up / neededBytes).toFixed(2)} x the needed bytes; per streamer received: ${st.map((x) => (x.peers / 1048576).toFixed(1)).join(' / ')} MiB`);
      if (MEASURE_ONLY) {
        console.log('MEASURE ONLY done');
      } else {
        assert(up <= 1.4 * neededBytes, `Alice uploaded ${(up / neededBytes).toFixed(2)} x what the streamers needed`);
        assert(st.every((x) => x.server === 0));
        // Alice leaves in the middle of the film: what the others have cached keeps playing, the rest fails with a message
        await A2.ctx.close();
        await Promise.all(ps.map((p) => waitFor(p, () => room.mesh.peers.size === 2)));
        await seekAll(20);
        t = await settle(ps, 20.5);
        assert(t.every((x) => !x.paused && x.time > 20.5), 'cached part keeps playing without Alice: ' + JSON.stringify(t.map((x) => x.time)));
        // a part that nobody fetched: not hanging; a message, and the page still answers
        await seekAll(75);
        await waitFor(ps[0], () => [...document.querySelectorAll('.toast')].some((x) => /Could not get this part of the movie|Nobody is sharing/.test(x.textContent)), undefined, 45000);
        assert.strictEqual(await ps[0].evaluate(() => 1 + 1), 2, 'the page is responsive');
        await seekAll(30);
        t = await settle(ps, 30.5);
        assert(t.every((x) => !x.paused), 'and playback resumes in the cached part: ' + JSON.stringify(t.map((x) => x.time)));
        console.log('Alice left: cached parts kept playing, the missing part failed with a message');
      }
    }
    console.log('SHARE CHECK OK');
  } finally {
    await browser.close().catch(() => {});
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('SHARE CHECK FAILED', err);
  process.exit(1);
});
