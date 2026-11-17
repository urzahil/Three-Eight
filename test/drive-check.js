// Browser test for streaming a movie from a Google Drive folder attached to a room.
// Starts the real server as a Google service account against a fake Google (test/fake-google.js), so
// no real Google access is needed. The browser only ever talks to our server. Fixtures: `bash test/make-fixtures.sh` first.
// Usage: node test/drive-check.js
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');
const { startFakeGoogle } = require('./fake-google');

const FIX = path.resolve(__dirname, 'fixtures');
const ADMIN = 'test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now().toString(36);
const ROOM = 'drive-' + stamp;
const PLAIN = 'plain-' + stamp;
const SWARM = 'swarm-' + stamp;

// ---- the fake Drive (served by fake-google.js to the real server) ---------------------------------------
const ID = { root: 'ROOTFOLDER_0001', sub: 'SUBFOLDER_00002', mkv: 'MKVFILE_0000003', mp4: 'MP4FILE_0000004', srt: 'SRTFILE_0000005', txt: 'TXTFILE_0000006', srtIt: 'SRTIT_00000007', other: 'SRTOTHER_00008', bigFolder: 'BIGFOLDER_00009', big: 'BIGMKV_0000010' };
const read = (f) => fs.readFileSync(path.join(FIX, f));
const DATA = { [ID.mkv]: read('multi.mkv'), [ID.mp4]: read('single.mp4'), [ID.srt]: read('subs_en.srt'), [ID.txt]: Buffer.from('hi'),
  [ID.srtIt]: Buffer.from('1\n00:00:20,000 --> 00:00:25,000\nVentesimo secondo\n'), [ID.other]: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nUnrelated\n') };

function fillFakeGoogle(g) {
  g.addFolder(ID.root, 'Movie Night Folder');
  g.addFolder(ID.sub, 'Season 1', ID.root);
  g.addFile(ID.txt, 'notes.txt', ID.root, DATA[ID.txt], 'text/plain');
  g.addFile(ID.mkv, 'multi.mkv', ID.sub, DATA[ID.mkv], 'video/x-matroska', 40000);
  g.addFile(ID.mp4, 'single.mp4', ID.sub, DATA[ID.mp4], 'video/mp4', 40000);
  g.addFile(ID.srt, 'multi.srt', ID.sub, DATA[ID.srt], 'application/x-subrip');
  g.addFile(ID.srtIt, 'multi.it.srt', ID.sub, DATA[ID.srtIt], 'application/x-subrip');
  g.addFile(ID.other, 'subs_en.srt', ID.sub, DATA[ID.other], 'application/x-subrip');
  g.addFolder(ID.bigFolder, 'Big Movies'); // a film of about 55 pieces for the swarm test, in a room of its own
  g.addFile(ID.big, 'big.mkv', ID.bigFolder, DATA[ID.big], 'video/x-matroska', 40000);
  g.mode.pageLimit = 2; // listings come in several pages
}

// ---- helpers (same style as e2e.js) ---------------------------------------------------------
async function ctl(page, sel) {
  const box = await page.locator('#movie-box').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 3);
  await page.click(sel);
}
const waitFor = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });
const state = (p) => p.evaluate(() => {
  const v = document.getElementById('movie');
  return { paused: v.paused, time: window.room.player.time, subs: document.getElementById('subs-layer').innerText.trim() };
});

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer(google) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-drive-'));
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_PASSWORD: ADMIN, GOOGLE_SERVICE_ACCOUNT: google.writeAccount(dir), GOOGLE_API_BASE: google.url, DRIVE_DEBUG: '1', TRUST_PROXY: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) return { base, child, dir, log: () => log };
    } catch { /* not up yet */ }
    await sleep(100);
  }
  child.kill();
  throw new Error('server did not start:\n' + log);
}

async function adminApi(base) {
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
  assert.equal(login.status, 200, 'admin login');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

(async () => {
  if (!fs.existsSync(path.join(FIX, 'multi.mkv'))) throw new Error('fixtures missing: run `bash test/make-fixtures.sh` first');
  if (!fs.existsSync(path.join(FIX, 'single.mp4'))) {
    // One video + one audio track, moov first: plays natively without the remuxer.
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(FIX, 'multi.mp4'), '-map', '0:v', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', path.join(FIX, 'single.mp4')]);
  }
  Object.assign(DATA, { [ID.mp4]: read('single.mp4') });
  if (!fs.existsSync(path.join(FIX, 'big.mkv'))) {
    // Noisy video, about 60 MB for 160 s: longer than the 40 s the player buffers ahead, so seeking reaches pieces nobody has.
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=160', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=160', '-vf', 'noise=alls=60:allf=t+u', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3M', '-g', '48', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', path.join(FIX, 'big.mkv')]);
  }
  DATA[ID.big] = read('big.mkv');

  const google = await startFakeGoogle();
  fillFakeGoogle(google);
  const { base: BASE, child, dir, log: serverLog } = await startServer(google);
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const cleanup = async () => {
    await browser.close().catch(() => {});
    child.kill();
    await google.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    // --- admin: rooms, one with a Drive folder (the link may carry a resource key: it is ignored)
    const api = await adminApi(BASE);
    for (const name of [ROOM, PLAIN, SWARM]) assert.equal((await api('POST', '/api/admin/rooms', { name, password: 'secret' })).status, 201);
    const set = await api('PUT', `/api/admin/rooms/${ROOM}/drive`, { link: `https://drive.google.com/drive/folders/${ID.root}?resourcekey=ignored-1` });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepStrictEqual(set.body.check, { name: 'Movie Night Folder', items: 1 }, 'the admin check lists the folder (the subfolder; notes.txt is skipped)');
    assert.equal((await api('GET', '/api/admin/rooms')).body.serviceAccount, google.email);
    console.log('admin: room with a Drive folder created, check:', JSON.stringify(set.body.check));

    assert.equal((await api('PUT', `/api/admin/rooms/${SWARM}/drive`, { link: ID.bigFolder })).status, 200);
    const served = [];
    const googleAttempts = []; // anything the browsers try to fetch from Google (must stay empty)
    async function join(room, name, { viewport, noMse = false } = {}) {
      const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport });
      if (noMse) await ctx.addInitScript(() => { delete window.MediaSource; delete window.ManagedMediaSource; });
      const stats = { requests: [], server: [] };
      await ctx.route(/googleapis\.com|googleusercontent\.com|drive\.google\.com|accounts\.google\.com|gstatic\.com/, (route) => {
        googleAttempts.push(route.request().url());
        return route.abort('blockedbyclient');
      });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/403|404|503|Failed to load resource/.test(m.text())) console.log(`[${name} console]`, m.text()); });
      page.on('request', (r) => {
        if (!r.url().startsWith(BASE)) return;
        const u = new URL(r.url());
        stats.server.push(u.pathname + u.search);
        if (u.pathname.includes('/drive/')) stats.requests.push({ url: r.url(), path: u.pathname, method: r.method(), t: u.searchParams.get('t'), auth: r.headers().authorization, range: r.headers().range, type: r.resourceType() });
      });
      await page.goto(`${BASE}/${room}?debug`);
      await page.fill('#lobby-name', name);
      await page.fill('#lobby-password', 'secret');
      await page.click('#lobby-join');
      await page.waitForSelector('#room:not([hidden])');
      served.push(stats);
      return { page, ctx, stats, name };
    }
    const openDialog = async (page) => {
      await page.click('#t-movie');
      await page.waitForSelector('#movie-dialog[open]');
    };
    const item = (page, text) => page.locator('#drive-list .drive-item', { hasText: text });

    const A = await join(ROOM, 'Alice');
    const B = await join(ROOM, 'Bob');
    const [alice, bob] = [A.page, B.page];
    console.log('both joined');

    // --- the plain room shows nothing new
    {
      const P = await join(PLAIN, 'Pat');
      await openDialog(P.page);
      assert(await P.page.locator('#drive-section').isHidden(), 'no Drive section without a folder');
      assert.match(await P.page.textContent('#movie-dialog-text'), /stream it from your copy/);
      assert.doesNotMatch(await P.page.textContent('#movie-dialog-text'), /everyone needs/i);
      assert.strictEqual(await P.page.evaluate(() => room.drive), null);
      await sleep(300);
      assert.strictEqual(P.stats.requests.length, 0, 'no Drive requests in a room without a folder');
      await P.ctx.close();
      console.log('room without a folder: no Drive UI');
    }

    // --- Carol (phone-sized): Google's download quota error is shown as a readable message, then streaming works
    {
      google.mode.quotaIds.add(ID.mkv);
      const C = await join(ROOM, 'Carol', { viewport: { width: 375, height: 700 } });
      const carol = C.page;
      await openDialog(carol);
      await waitFor(carol, () => document.querySelectorAll('#drive-list .drive-item').length === 1);
      await item(carol, 'Season 1').click();
      await waitFor(carol, () => document.querySelectorAll('#drive-list .drive-item').length === 5);
      await item(carol, 'multi.mkv').click();
      await waitFor(carol, () => [...document.querySelectorAll('.toast')].some((t) => /temporarily blocked downloads/.test(t.textContent)));
      assert.strictEqual(await carol.evaluate(() => room.player.loaded), false);
      assert(await carol.locator('#stage').isHidden(), 'no movie stage after the failed attempt');
      console.log('quota error surfaced as a toast');
      google.mode.quotaIds.delete(ID.mkv);
      // dialog layout on a phone
      await openDialog(carol);
      await waitFor(carol, () => document.querySelectorAll('#drive-list .drive-item').length > 0);
      const fit = await carol.evaluate(() => {
        const d = document.getElementById('movie-dialog');
        const r = d.getBoundingClientRect();
        return { left: r.left, right: window.innerWidth - r.right, dialogOverflow: d.scrollWidth - d.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth };
      });
      assert(fit.left >= 15 && fit.right >= 15 && fit.dialogOverflow <= 1 && fit.page <= 0, 'dialog fits a phone: ' + JSON.stringify(fit));
      await carol.keyboard.press('Escape');
      await C.ctx.close();
      console.log('phone layout ok');
    }

    // --- Alice browses: root -> Season 1 -> picks the MKV (remuxer path)
    await openDialog(alice);
    await alice.waitForSelector('#drive-section:not([hidden])');
    await waitFor(alice, () => document.querySelectorAll('#drive-list .drive-item').length === 1);
    let names = await alice.$$eval('#drive-list .drive-item .name', (els) => els.map((e) => e.textContent));
    assert.deepStrictEqual(names, ['Season 1'], 'folders only here: other files hidden, second page merged');
    assert.match(await alice.textContent('#drive-crumbs'), /Movie Night Folder/);
    await item(alice, 'Season 1').click();
    await waitFor(alice, () => document.querySelectorAll('#drive-list .drive-item').length === 5);
    names = await alice.$$eval('#drive-list .drive-item .name', (els) => els.map((e) => e.textContent));
    assert.deepStrictEqual(names, ['multi.it.srt', 'multi.mkv', 'multi.srt', 'single.mp4', 'subs_en.srt']);
    assert(await item(alice, 'subs_en.srt').isDisabled(), 'subtitles need a movie first');
    console.log('browsing works:', names);
    await item(alice, 'multi.mkv').click();
    await waitFor(alice, () => !document.getElementById('stage').hidden && document.getElementById('movie').readyState >= 2);
    assert.strictEqual(await alice.evaluate(() => room.player.mode), 'mse');
    const movie = await alice.evaluate(() => room.sync.state.movie);
    assert.deepStrictEqual(movie.drive, { id: ID.mkv, folder: ID.sub });
    console.log('alice streams the MKV from Drive:', JSON.stringify(movie));
    // the matching subtitle file next to it (exact base name beats multi.it.srt) is shared automatically
    await waitFor(alice, () => room.sync.state.sub && room.sync.state.subFiles.length === 1);
    assert.deepStrictEqual(await alice.evaluate(() => room.sync.state.subFiles.map((f) => f.name)), ['multi.srt']);

    // --- Bob: one-click streaming
    await waitFor(bob, () => document.getElementById('movie-overlay').textContent.includes('Stream from Google Drive'));
    assert((await bob.textContent('#movie-overlay')).includes('Use my own copy'));
    await bob.click('#movie-overlay button:has-text("Stream from Google Drive")');
    await waitFor(bob, () => document.getElementById('movie').readyState >= 2);
    await waitFor(bob, () => [...document.querySelectorAll('#m-subs-menu button.on span')].some((s) => /^multi$/.test(s.textContent)));
    await waitFor(alice, () => /Everyone ready/.test(document.getElementById('m-ready').textContent));
    console.log('both ready');

    await ctl(alice, '#m-play');
    await sleep(4000);
    let a = await state(alice), b = await state(bob);
    assert(!a.paused && !b.paused, 'both play');
    // Opening the MKV (header, Cues, tracks) and 4 s of playback: measured 3 fetches (~1 MiB minimum requests,
    // two at a time) plus the 1 MiB-to-4 MiB windows for the 4 MB file. Allow some slack, but a burst of
    // small subtitle reads (the old behaviour) would blow well past it.
    const openCount = A.stats.requests.filter((r) => r.range && r.path.endsWith('/files/' + ID.mkv)).length;
    console.log('MEASURE mkv range requests after open + ~4s play:', openCount);
    assert(openCount <= 8, `too many requests to open and play the MKV: ${openCount}`);
    assert(Math.abs(a.time - b.time) < 0.4, `drift ${a.time} vs ${b.time}`);
    await ctl(bob, '#m-play');
    await sleep(800);
    a = await state(alice); b = await state(bob);
    assert(a.paused && b.paused && Math.abs(a.time - b.time) < 0.15, 'pause synced');
    await ctl(bob, '#m-time');
    const box = await bob.locator('#m-seek').boundingBox();
    await bob.mouse.click(box.x + box.width * (30 / 40), box.y + box.height / 2);
    await sleep(1500);
    a = await state(alice); b = await state(bob);
    console.log('seek to ~30s:', a.time, b.time);
    assert(a.time > 28 && Math.abs(a.time - b.time) < 0.2, 'seek synced');
    // audio track switching works on the remuxed stream
    await ctl(alice, '#m-audio');
    await alice.click('#m-audio-menu button:nth-of-type(2)');
    await sleep(1500);
    assert((await bob.$$eval('#m-audio-menu button.on span', (s) => s.map((x) => x.textContent))).some((t) => /Italiano/.test(t)), 'audio track synced');
    // embedded subtitles are not downloaded while streaming
    const embedded = await alice.evaluate(() => room.player.info.subtitleTracks.filter((t) => t.source === 'embedded').map((t) => t.unsupported || 'ok'));
    console.log('embedded subtitle tracks while streaming:', embedded);
    assert.deepStrictEqual(await alice.evaluate(() => room.player.info.subtitleTracks.filter((t) => t.source === 'embedded').map((t) => [t.waiting, t.progress, room.player.subtitles.get(t.id).cues.length])), [[true, 0, 0], [true, 0, 0]], 'embedded subtitle tracks are not read until selected');
    assert.match(await alice.evaluate(() => document.getElementById('m-subs-menu').innerText), /loads when selected/);
    // a track that would need many separate downloads (or a whole-file scan) is skipped, not fetched
    const skipped = await alice.evaluate(() => room.player.demux.extractSubtitles(() => {}, () => {}, null, { remote: true, maxRemoteCues: 1 }));
    assert.strictEqual(skipped.length, 2, 'over-budget subtitle tracks are skipped when streaming');

    // The server reads each byte of the film from Google about once, although two viewers stream it:
    // no overlapping upstream ranges (block cache + shared in-flight downloads).
    {
      const ranges = google.entries('media', ID.mkv).filter((e) => e.status === 206 || e.status === 200)
        .map((e) => [e.range ? e.range[0] : 0, e.end ?? DATA[ID.mkv].length - 1]).sort((x, y) => x[0] - y[0]);
      assert(ranges.length > 0, 'the server fetched the film from the fake Google');
      for (let k = 1; k < ranges.length; k++) assert(ranges[k][0] > ranges[k - 1][1], `fake Google saw overlapping ranges: ${JSON.stringify(ranges.slice(k - 1, k + 1))}`);
      const total = ranges.reduce((n, r) => n + r[1] - r[0] + 1, 0);
      assert(total <= DATA[ID.mkv].length, `fetched ${total} of ${DATA[ID.mkv].length} bytes`);
      const viewers = [A, B].map((V) => V.stats.requests.filter((r) => r.path.endsWith('/files/' + ID.mkv) && r.range).length);
      assert(viewers.every((n) => n > 0), 'both viewers streamed the MKV through our server');
      console.log(`two viewers streamed the MKV (${viewers} browser requests); fake Google served ${ranges.length} ranges, ${total} of ${DATA[ID.mkv].length} bytes, none twice`);
    }

    // --- the auto-loaded subtitles show for both without anyone clicking
    const seekBob = async (sec) => {
      await ctl(bob, '#m-time');
      const bx = await bob.locator('#m-seek').boundingBox();
      await bob.mouse.click(bx.x + bx.width * (sec / 40), bx.y + bx.height / 2);
      await sleep(1500);
    };
    await seekBob(21);
    a = await state(alice); b = await state(bob);
    assert(/Twenty seconds/.test(a.subs) && /Twenty seconds/.test(b.subs), `auto subtitles shown: ${JSON.stringify([a.subs, b.subs])}`);
    // Bob never browsed the folder, yet his CC menu lists the subtitle files next to the movie
    await ctl(bob, '#m-subs');
    await waitFor(bob, () => [...document.querySelectorAll('#m-subs-menu button span')].some((s) => s.textContent === 'multi.it.srt'));
    const menu = await bob.$$eval('#m-subs-menu button span', (els) => els.map((e) => e.textContent));
    assert(menu.includes('multi.it.srt') && !menu.includes('multi.srt'), 'drive group: the shared one is a normal entry: ' + menu);
    assert(!menu.includes('subs_en.srt'), 'subtitle files of other films are not listed: ' + menu);
    assert.match(await bob.textContent('#m-subs-menu'), /From Google Drive[\s\S]*Load subtitle file/, 'local file option kept below the Drive group');
    assert.match(await bob.textContent('#m-subs-menu'), /From Google Drive/);
    await bob.click('#m-subs-menu button:has-text("multi.it.srt")');
    await seekBob(21);
    await sleep(500);
    a = await state(alice); b = await state(bob);
    assert(/Ventesimo/.test(a.subs) && /Ventesimo/.test(b.subs), `chosen Drive subtitles switch for both: ${JSON.stringify([a.subs, b.subs])}`);
    assert.strictEqual(await alice.evaluate(() => room.sync.state.subFiles.length), 2);
    // an embedded track is read when it is selected: then its cues arrive for both peers
    await ctl(bob, '#m-subs');
    await bob.click('#m-subs-menu button:has-text("loads when selected") >> nth=0');
    await waitFor(bob, () => room.player.subtitles.get(room.sync.state.sub)?.cues.length > 0);
    await waitFor(alice, () => room.player.subtitles.get(room.sync.state.sub)?.cues.length > 0);
    assert.strictEqual(await bob.evaluate(() => room.player.subtitles.get(room.sync.state.sub).source), 'embedded');
    await seekBob(21);
    a = await state(alice); b = await state(bob);
    assert(/Twenty seconds/.test(a.subs) && /Twenty seconds/.test(b.subs), `embedded subtitles read on demand: ${JSON.stringify([a.subs, b.subs])}`);
    // --- a third viewer joins while an embedded subtitle track is selected: the cues come from Alice and Bob, it extracts nothing
    {
      const small = (S) => S.requests.filter((r) => r.path.endsWith('/files/' + ID.mkv) && r.range && /bytes=(\d+)-(\d+)/.test(r.range) && (() => { const m = /bytes=(\d+)-(\d+)/.exec(r.range); return Number(m[2]) - Number(m[1]) + 1 <= 262144; })()).length;
      const E = await join(ROOM, 'Erin');
      const erin = E.page;
      await waitFor(erin, () => document.getElementById('movie-overlay').textContent.includes('Stream from Google Drive'));
      await erin.click('#movie-overlay button:has-text("Stream from Google Drive")');
      await waitFor(erin, () => document.getElementById('movie').readyState >= 2 && room.player.file?.name === 'multi.mkv');
      await waitFor(erin, () => { const t = room.player.subtitles.get(room.sync.state.sub); return !!t && t.source === 'embedded' && t.complete; });
      await waitFor(erin, () => /Twenty seconds/.test(document.getElementById('subs-layer').innerText));
      console.log('MEASURE subtitle reads of the MKV (small ranges): Alice', small(A.stats), 'Bob', small(B.stats), 'Erin', small(E.stats));
      assert(small(A.stats) + small(B.stats) > 0, 'somebody extracted the track');
      assert.strictEqual(small(E.stats), 0, 'Erin made no subtitle reads: the cues came from the others');
      await E.ctx.close();
    }

    // the highlighted current movie in the dialog
    await openDialog(alice);
    await waitFor(alice, () => document.querySelectorAll('#drive-list .drive-item').length === 5);
    assert(await item(alice, 'multi.mkv').evaluate((e) => e.classList.contains('current')), 'current movie highlighted');
    await alice.keyboard.press('Escape');
    console.log('subtitles from Drive: auto-loaded, listed in the CC menu, switchable');

    // --- an MP4 from Drive: a swarm film always plays through the remuxer (pieces from friends can't feed a <video src>)
    await openDialog(bob);
    await bob.waitForSelector('#drive-section:not([hidden])');
    await waitFor(bob, () => document.querySelectorAll('#drive-list .drive-item').length > 0);
    if (await item(bob, 'Season 1').count()) await item(bob, 'Season 1').click();
    await waitFor(bob, () => [...document.querySelectorAll('#drive-list .name')].some((n) => n.textContent === 'single.mp4'));
    await item(bob, 'single.mp4').click();
    await bob.waitForSelector('#mismatch-dialog[open]');
    assert.match(await bob.textContent('#mismatch-text'), /multi\.mkv.*single\.mp4/);
    await bob.click('#mismatch-dialog button[value=room]');
    await waitFor(bob, () => document.getElementById('movie').readyState >= 2 && room.player.file?.name === 'single.mp4');
    assert.strictEqual(await bob.evaluate(() => room.player.mode), 'mse', 'swarm films use MSE');
    await waitFor(alice, () => room.sync.state.movie?.name === 'single.mp4');
    // Alice still holds the MKV (a different file): she switches by streaming the MP4 too
    await openDialog(alice);
    await waitFor(alice, () => document.querySelectorAll('#drive-list .drive-item').length > 0);
    if (await item(alice, 'Season 1').count()) await item(alice, 'Season 1').click();
    await waitFor(alice, () => [...document.querySelectorAll('#drive-list .name')].some((n) => n.textContent === 'single.mp4'));
    assert(await item(alice, 'single.mp4').evaluate((e) => e.classList.contains('current')), 'new room movie highlighted');
    await item(alice, 'single.mp4').click();
    await waitFor(alice, () => document.getElementById('movie').readyState >= 2 && room.player.file?.name === 'single.mp4');
    assert.strictEqual(await alice.evaluate(() => room.player.mode), 'mse');
    await waitFor(alice, () => /Everyone ready/.test(document.getElementById('m-ready').textContent));
    await ctl(alice, '#m-play');
    await sleep(3500);
    a = await state(alice); b = await state(bob);
    console.log('MP4 through the swarm, playing:', a.time, b.time);
    assert(!a.paused && !b.paused && Math.abs(a.time - b.time) < 0.4, 'playback in sync');
    await ctl(bob, '#m-play');
    await sleep(800);
    a = await state(alice); b = await state(bob);
    assert(a.paused && b.paused, 'pause synced');
    // no subtitle file matches single.mp4: the Drive group lists nothing (subtitles of other films stay hidden)
    await ctl(bob, '#m-subs');
    await waitFor(bob, () => {
      const t = [...document.querySelectorAll('#m-subs-menu button, #m-subs-menu h4')].map((e) => e.textContent);
      return t.some((x) => x.includes('Load subtitle file')) && !t.some((x) => x.includes('Loading…'));
    });
    const all = await bob.$$eval('#m-subs-menu button, #m-subs-menu h4', (els) => els.map((e) => e.textContent));
    assert(!all.some((t) => /multi\.srt|multi\.it\.srt|subs_en\.srt|From Google Drive/.test(t)), 'nothing from Drive listed when no file matches: ' + all);
    await bob.keyboard.press('Escape');
    assert(A.stats.requests.some((r) => r.range && r.path.endsWith('/files/' + ID.mp4)), 'the browser used Range requests for the MP4');

    // --- a browser without MSE (old iOS) plays a Drive film natively from our server, and does not share it
    {
      const D = await join(ROOM, 'Dave', { noMse: true });
      const dave = D.page;
      await waitFor(dave, () => document.getElementById('movie-overlay').textContent.includes('Stream from Google Drive'));
      await dave.click('#movie-overlay button:has-text("Stream from Google Drive")');
      await waitFor(dave, () => document.getElementById('movie').readyState >= 2 && room.player.file?.name === 'single.mp4');
      assert.strictEqual(await dave.evaluate(() => room.player.mode), 'native');
      assert((await dave.evaluate(() => document.getElementById('movie').currentSrc)).startsWith(`${BASE}/api/rooms/${ROOM}/drive/files/${ID.mp4}`), 'native <video> streams from our server');
      assert(!(await dave.evaluate(() => document.getElementById('movie').currentSrc)).includes('t='), 'no token in the URL');
      assert.strictEqual(await dave.evaluate(() => room.swarm.film), null, 'a native player does not take part in sharing');
      await waitFor(alice, () => room.sync.peerStatus.size >= 2 && [...room.sync.peerStatus.values()].every((x) => x.matches));
      await ctl(alice, '#m-play');
      await sleep(3500);
      const d = await state(dave);
      a = await state(alice);
      console.log('native (no MSE) playing:', a.time, d.time);
      assert(!a.paused && !d.paused && Math.abs(a.time - d.time) < 0.4, 'native playback in sync with the swarm viewers');
      assert(D.stats.requests.some((r) => r.type === 'media'), 'the <video> element made the media requests');
      await ctl(alice, '#m-play');
      await sleep(800);
      await D.ctx.close();
    }

    // --- a reconnect brings a fresh token; the same client (listings, open files) keeps working with it
    {
      const before = await alice.evaluate(() => { window.__drive = room.drive; return room.drive.token; });
      await alice.evaluate(() => room.signaling.ws.close());
      await waitFor(alice, (t) => room.drive.token !== t, before);
      assert.strictEqual(await alice.evaluate(() => room.drive === window.__drive), true, 'the DriveClient is kept');
      assert.strictEqual(await alice.evaluate(async () => (await room.drive._getJson('/folders/root')).name), 'Movie Night Folder', 'the new token works');
      console.log('reconnect: fresh token picked up by the existing client');
    }

    // --- the admin changes the folder: members switch live (the old tokens are void), then removes it, then re-adds it
    assert.strictEqual((await api('PUT', `/api/admin/rooms/${ROOM}/drive`, { link: ID.sub })).status, 200);
    await waitFor(alice, (id) => room.drive && room.drive.folder === id, ID.sub);
    await openDialog(alice);
    await waitFor(alice, () => document.querySelectorAll('#drive-list .drive-item').length === 5);
    assert.match(await alice.textContent('#drive-crumbs'), /Season 1/, 'the dialog now shows the new root');
    await alice.keyboard.press('Escape');
    assert.strictEqual((await api('PUT', `/api/admin/rooms/${ROOM}/drive`, { link: '' })).status, 200);
    await waitFor(alice, () => room.drive === null);
    await openDialog(alice);
    assert(await alice.locator('#drive-section').isHidden(), 'Drive section hidden after removal');
    await alice.keyboard.press('Escape');
    assert.strictEqual((await api('PUT', `/api/admin/rooms/${ROOM}/drive`, { link: ID.root })).status, 200);
    await waitFor(alice, () => room.drive !== null);
    console.log('admin folder change / removal / re-adding is picked up live');


    // --- three viewers stream the same Drive MKV: the server sends each piece about once, the viewers share the rest
    {
      const big = DATA[ID.big];
      const viewers = [];
      const bytes = { total: 0, ranges: [] }; // what our server sent to all browsers for this film
      for (const name of ['Alice', 'Bob', 'Carol']) {
        const V = await join(SWARM, name);
        V.page.on('response', (res) => {
          const u = new URL(res.url());
          if (!u.pathname.endsWith('/drive/files/' + ID.big)) return;
          const n = Number(res.headers()['content-length'] || 0);
          bytes.total += n;
          const m = /bytes=(\d+)-(\d+)/.exec(res.request().headers().range || '');
          if (m) bytes.ranges.push([Number(m[1]), Number(m[2])]);
        });
        viewers.push(V);
      }
      const [va, vb, vc] = viewers.map((v) => v.page);
      await vb.waitForSelector('#room:not([hidden])');
      await openDialog(va);
      await waitFor(va, () => document.querySelectorAll('#drive-list .drive-item').length === 1);
      await item(va, 'big.mkv').click();
      await waitFor(va, () => document.getElementById('movie').readyState >= 2 && !document.getElementById('stage').hidden);
      const fresh = (p) => waitFor(p, () => document.getElementById('movie-overlay').textContent.includes('Stream from Google Drive'));
      await Promise.all([fresh(vb), fresh(vc)]);
      // Bob and Carol click at the same moment
      await Promise.all([vb, vc].map((p) => p.click('#movie-overlay button:has-text("Stream from Google Drive")')));
      await Promise.all([vb, vc].map((p) => waitFor(p, () => document.getElementById('movie').readyState >= 2 && room.player.file?.name === 'big.mkv')));
      for (const p of [va, vb, vc]) assert.strictEqual(await p.evaluate(() => room.player.mode), 'mse');
      await waitFor(va, () => /Everyone ready/.test(document.getElementById('m-ready').textContent));
      await ctl(va, '#m-play');
      await sleep(7000);
      let t = await Promise.all([va, vb, vc].map(state));
      assert(t.every((x) => !x.paused) && Math.max(...t.map((x) => x.time)) - Math.min(...t.map((x) => x.time)) < 0.5, 'three viewers play in sync: ' + JSON.stringify(t.map((x) => x.time)));
      // everybody jumps to the same place at the same time
      const seekAll = async (sec) => {
        await ctl(vb, '#m-time');
        const bx = await vb.locator('#m-seek').boundingBox();
        await vb.mouse.click(bx.x + bx.width * (sec / 160), bx.y + bx.height / 2);
        await sleep(3500);
      };
      // (after a jump the slower viewer catches up by playing a little faster, so allow it a few seconds)
      const settle = async (pages, min, tol = 0.5, tries = 60) => {
        for (let i = 0; i < tries; i++) {
          const ts = await Promise.all(pages.map(state));
          const spread = Math.max(...ts.map((x) => x.time)) - Math.min(...ts.map((x) => x.time));
          if (ts.every((x) => !x.paused && x.time > min) && spread < tol) return ts;
          await sleep(500);
        }
        return Promise.all(pages.map(state));
      };
      await seekAll(100);
      t = await settle([va, vb, vc], 99.5);
      assert(t.every((x) => x.time > 99.5) && Math.max(...t.map((x) => x.time)) - Math.min(...t.map((x) => x.time)) < 0.5, 'seek in sync: ' + JSON.stringify(t.map((x) => x.time)));
      await sleep(3000);
      const unique = (() => {
        const r = [...bytes.ranges].sort((x, y) => x[0] - y[0]);
        let n = 0, hi = -1;
        for (const [a0, b0] of r) { n += Math.max(0, b0 - Math.max(a0, hi + 1) + 1); hi = Math.max(hi, b0); }
        return n;
      })();
      const stats = await Promise.all([va, vb, vc].map((p) => p.evaluate(() => ({ ...room.swarm.stats, cached: room.player.file.cachedPieces(1048576) }))));
      // The film as far as the three of them have watched: the pieces cached by any viewer.
      const needed = new Set();
      for (const x of stats) for (const [f0, l0] of x.cached) for (let k = f0; k <= l0; k++) needed.add(k);
      const neededBytes = [...needed].reduce((n, k) => n + Math.min(1048576, big.length - k * 1048576), 0);
      const ratio = bytes.total / big.length;
      console.log(`MEASURE 3 viewers, ${(big.length / 1048576).toFixed(1)} MiB film: our server sent ${(bytes.total / 1048576).toFixed(2)} MiB in ${bytes.ranges.length} requests = ${ratio.toFixed(2)} x the file size; the viewers needed ${(neededBytes / 1048576).toFixed(2)} MiB of it, so ${(bytes.total / neededBytes).toFixed(2)} x what was needed; duplicated bytes: ${(bytes.total / unique).toFixed(2)} x`);
      console.log('MEASURE swarm per viewer (bytes from server / from friends / served to friends):', stats.map((x) => `${x.server}/${x.peers}/${x.served}`).join('  '), ' pieces cached:', JSON.stringify(stats.map((x) => x.cached)));
      // the people list says where each viewer gets the film from
      await va.evaluate(() => document.querySelector('.tab[data-tab="people"]').click());
      await waitFor(va, () => [...document.querySelectorAll('#people li small')].filter((e) => e.textContent === 'streaming (Drive)').length === 3);
      assert.strictEqual(await va.$$eval('#people li small', (els) => els.map((e) => e.textContent).join('|')), 'streaming (Drive)|streaming (Drive)|streaming (Drive)');
      await va.evaluate(() => document.querySelector('.tab[data-tab="chat"]').click());
      assert(ratio <= 1.4, `the server sent ${ratio.toFixed(2)} x the film`);
      assert(bytes.total / neededBytes <= 1.4, `the server sent ${(bytes.total / neededBytes).toFixed(2)} x what the viewers needed`);
      assert(bytes.total / unique <= 1.4, 'the same bytes were sent more than ~once');
      assert(stats.every((x) => x.peers > 0 || x.server > 0) && stats.reduce((n, x) => n + x.peers, 0) > 0, 'viewers got pieces from each other');

      // A viewer freezes (stops answering friends, like a stuck tab): the others fall back for the pieces it was meant to
      // fetch (planning again without it, so one of them fetches each piece from the server) and keep playing.
      const before = bytes.total;
      await vc.evaluate(() => { room.swarm._onFilm = () => {}; });
      await seekAll(66); // the film between the part the viewers read from the start and the part they read after the jump: nobody has it
      t = await settle([va, vb], 68);
      const fb = await Promise.all([va, vb].map((p) => p.evaluate(() => room.swarm.stats.fallbacks + room.swarm.bad.size))); // a fallback, or the frozen friend marked as failing (its pieces were then relayed by the other)
      console.log('MEASURE after one viewer froze: times', JSON.stringify(t.map((x) => x.time)), '| fallbacks', fb.join(','), '| server bytes for the rest of the film:', ((bytes.total - before) / 1048576).toFixed(2), 'MiB');
      assert(t.every((x) => !x.paused) && Math.abs(t[0].time - t[1].time) < 0.5, 'the others keep playing in sync: ' + JSON.stringify(t.map((x) => x.time)));
      assert(fb[0] + fb[1] >= 1, 'the frozen friend was skipped (fallback)');
      assert(bytes.total / big.length <= 1.4, 'still about one copy: ' + (bytes.total / big.length).toFixed(2));
      // Carol leaves in the middle of the stream
      await viewers[2].ctx.close();
      await seekAll(20);
      t = await settle([va, vb], 20.5, 0.5, 20); // within 10 s: a gap in the buffer once left a viewer stuck for good
      assert(t.every((x) => !x.paused && x.time > 20.5 && x.time < 40) && Math.abs(t[0].time - t[1].time) < 0.5, 'still playing after she left: ' + JSON.stringify(t.map((x) => x.time)));
      // The admin changes the room password without kicking while the film plays: every Drive token (and any response still
      // streaming under it) is void, the members get a fresh token, and playback goes on, also into a part nobody has yet.
      const oldTokens = await Promise.all([va, vb].map((p) => p.evaluate(() => room.drive.token)));
      assert.equal((await api('PUT', `/api/admin/rooms/${SWARM}`, { password: 'secret2' })).status, 200);
      await Promise.all([va, vb].map((p, i) => waitFor(p, (old) => room.drive && room.drive.token !== old, oldTokens[i])));
      await seekAll(130);
      t = await settle([va, vb], 130.5, 0.5, 30);
      assert(t.every((x) => !x.paused && x.time > 130.5) && Math.abs(t[0].time - t[1].time) < 0.5, 'still playing after the password changed: ' + JSON.stringify(t.map((x) => x.time)));
      console.log('password changed without kick: members got a fresh token and playback continued', JSON.stringify(t.map((x) => x.time)));
      for (const v of viewers.slice(0, 2)) await v.ctx.close();
      console.log('three viewers share the film; a frozen and a departed viewer did not stop the others');
    }

    // --- the browser never contacted Google, and everything it fetched from our server carried the room token
    assert.deepStrictEqual(googleAttempts, [], 'the browser tried to contact Google');
    let driveRequests = 0;
    for (const S of served) {
      const bad = S.server.filter((p) => !(p.startsWith('/assets/') || p.startsWith('/api/') || p === '/ws' || p.startsWith('/' + ROOM) || p.startsWith('/' + PLAIN) || p.startsWith('/' + SWARM) || p === '/favicon.ico' || p === '/healthz'));
      assert.deepStrictEqual(bad, [], 'unexpected requests to our server');
      for (const r of S.requests) {
        driveRequests++;
        if (r.type === 'media') assert(!r.t && !r.auth && !r.url.includes('t='), `a <video> request carries no token in the URL or a header (the session cookie authorizes it): ${r.url}`);
        else if (r.path.endsWith('/drive/session') && r.method === 'DELETE') assert(!r.t && !r.auth, 'clearing the cookie on leaving sends no token');
        else if (r.path.endsWith('/drive/session')) assert(/^Bearer \S{20,}$/.test(r.auth || '') && !r.t, 'the session is opened with the token in the Authorization header');
        else assert(/^Bearer \S{20,}$/.test(r.auth || '') && !r.t, `a fetch carries the token in the Authorization header: ${r.url}`);
      }
    }
    assert(driveRequests > 20, 'drive requests were observed');
    assert(!/BEGIN PRIVATE KEY|ya29\./.test(serverLog()), 'the server log holds no secrets');
    console.log(`the page made ${driveRequests} requests to our Drive endpoints, all authorized by header or cookie (never the URL), and none to Google`);
    console.log('DRIVE CHECK OK');
  } finally {
    await cleanup();
  }
})().catch((err) => {
  console.error('DRIVE CHECK FAILED', err);
  process.exit(1);
});
