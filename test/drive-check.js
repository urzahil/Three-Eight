// Browser test for streaming a movie from a Google Drive folder attached to a room.
// Starts its own server (with GOOGLE_API_KEY=test-key) and mocks https://www.googleapis.com/drive/v3/**
// in the browser, so no real Google access is needed. Fixtures: `bash test/make-fixtures.sh` first.
// Usage: node test/drive-check.js
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');

const FIX = path.resolve(__dirname, 'fixtures');
const ADMIN = 'test';
const KEY = 'test-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now().toString(36);
const ROOM = 'drive-' + stamp;
const PLAIN = 'plain-' + stamp;

// ---- the fake Drive --------------------------------------------------------------------
const FOLDER = 'application/vnd.google-apps.folder';
const ID = { root: 'ROOTFOLDER_0001', sub: 'SUBFOLDER_00002', mkv: 'MKVFILE_0000003', mp4: 'MP4FILE_0000004', srt: 'SRTFILE_0000005', txt: 'TXTFILE_0000006', srtIt: 'SRTIT_00000007', other: 'SRTOTHER_00008' };
const read = (f) => fs.readFileSync(path.join(FIX, f));
const DATA = { [ID.mkv]: read('multi.mkv'), [ID.mp4]: read('single.mp4'), [ID.srt]: read('subs_en.srt'), [ID.txt]: Buffer.from('hi'),
  [ID.srtIt]: Buffer.from('1\n00:00:20,000 --> 00:00:25,000\nVentesimo secondo\n'), [ID.other]: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nUnrelated\n') };
const META = {
  [ID.root]: { id: ID.root, name: 'Movie Night Folder', mimeType: FOLDER, resourceKey: 'ROOTKEY-1' },
  [ID.sub]: { id: ID.sub, name: 'Season 1', mimeType: FOLDER, resourceKey: 'SUBKEY-1' },
  [ID.mkv]: { id: ID.mkv, name: 'multi.mkv', mimeType: 'video/x-matroska', size: String(DATA[ID.mkv].length), resourceKey: 'MKVKEY-1', videoMediaMetadata: { durationMillis: '40000' } },
  [ID.mp4]: { id: ID.mp4, name: 'single.mp4', mimeType: 'video/mp4', size: String(DATA[ID.mp4].length), videoMediaMetadata: { durationMillis: '40000' } },
  [ID.srt]: { id: ID.srt, name: 'multi.srt', mimeType: 'application/x-subrip', size: String(DATA[ID.srt].length) },
  [ID.srtIt]: { id: ID.srtIt, name: 'multi.it.srt', mimeType: 'application/x-subrip', size: String(DATA[ID.srtIt].length) },
  [ID.other]: { id: ID.other, name: 'subs_en.srt', mimeType: 'application/x-subrip', size: String(DATA[ID.other].length) },
  [ID.txt]: { id: ID.txt, name: 'notes.txt', mimeType: 'text/plain', size: '2' },
};
const CHILDREN = { [ID.root]: [[ID.sub], [ID.txt]], [ID.sub]: [[ID.mp4, ID.mkv, ID.srt, ID.srtIt, ID.other]] }; // pages of a listing

function fakeGoogle(stats, quota) {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'range,x-goog-drive-resource-keys',
    'access-control-allow-methods': 'GET, OPTIONS',
    // Like the real thing: Content-Range is not exposed to scripts.
  };
  const json = (route, status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const err = (route, status, reason, message) => json(route, status, { error: { code: status, message, errors: [{ reason, message }] } });
  return async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const h = req.headers();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    stats.requests.push({ url: req.url(), range: h.range, keys: h['x-goog-drive-resource-keys'], type: req.resourceType() });
    if (req.headers().referer) stats.referers.push(req.headers().referer);
    if (url.searchParams.get('key') !== KEY) return err(route, 400, 'keyInvalid', 'API key not valid. Please pass a valid API key.');
    const keys = h['x-goog-drive-resource-keys'] || '';
    const needs = (id) => META[id].resourceKey && !keys.split(',').includes(`${id}/${META[id].resourceKey}`);
    const m = url.pathname.match(/^\/drive\/v3\/files(?:\/([^/]+))?$/);
    if (!m) return err(route, 404, 'notFound', 'Not found');
    if (!m[1]) {
      const parent = /^'([^']+)' in parents and trashed=false$/.exec(url.searchParams.get('q') || '')?.[1];
      if (!CHILDREN[parent]) return err(route, 404, 'notFound', 'File not found');
      if (needs(parent)) return err(route, 404, 'notFound', 'File not found: ' + parent);
      assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
      const page = Number(url.searchParams.get('pageToken') || 0);
      const files = CHILDREN[parent][page].map((id) => META[id]);
      return json(route, 200, { files, ...(page + 1 < CHILDREN[parent].length ? { nextPageToken: String(page + 1) } : {}) });
    }
    const id = m[1];
    if (!META[id]) return err(route, 404, 'notFound', 'File not found: ' + id);
    if (needs(id)) return err(route, 404, 'notFound', 'File not found: ' + id);
    if (url.searchParams.get('alt') !== 'media') return json(route, 200, META[id]);
    if (quota.block && url.searchParams.get('alt') === 'media') {
      // Google's "automated queries" page for a blocked IP address comes without CORS headers (Playwright would
      // add them to a fulfilled response), so scripts only see net::ERR_FAILED / "Failed to fetch".
      return route.abort('failed');
    }
    if (quota.on && id === ID.mkv) return err(route, 403, 'downloadQuotaExceeded', 'The download quota for this file has been exceeded.');
    const data = DATA[id];
    const r = /^bytes=(\d+)-(\d*)$/.exec(h.range || '');
    const type = META[id].mimeType;
    if (!r) {
      stats.media[id] = (stats.media[id] || 0) + data.length;
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': type, 'accept-ranges': 'bytes' }, body: data });
    }
    const a = Number(r[1]);
    const b = Math.min(data.length - 1, r[2] ? Number(r[2]) : data.length - 1);
    if (a >= data.length) return route.fulfill({ status: 416, headers: cors });
    stats.media[id] = (stats.media[id] || 0) + (b - a + 1);
    return route.fulfill({ status: 206, headers: { ...cors, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${data.length}` }, body: data.subarray(a, b + 1) });
  };
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

async function startServer() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-drive-'));
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_PASSWORD: ADMIN, GOOGLE_API_KEY: KEY, TRUST_PROXY: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) return { base, child, dir };
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
  META[ID.mp4].size = String(DATA[ID.mp4].length);

  const { base: BASE, child, dir } = await startServer();
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const cleanup = async () => {
    await browser.close().catch(() => {});
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    // --- admin: rooms, one with a Drive folder (link with a resource key)
    const api = await adminApi(BASE);
    for (const name of [ROOM, PLAIN]) assert.equal((await api('POST', '/api/admin/rooms', { name, password: 'secret' })).status, 201);
    const set = await api('PUT', `/api/admin/rooms/${ROOM}/drive`, { link: `https://drive.google.com/drive/folders/${ID.root}?resourcekey=ROOTKEY-1` });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    console.log('admin: room with a Drive folder created');

    const served = [];
    async function join(room, name, { viewport, quota = { on: false } } = {}) {
      const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport });
      const stats = { requests: [], media: {}, referers: [], server: [] };
      await ctx.route('https://www.googleapis.com/drive/v3/**', fakeGoogle(stats, quota));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/403|404|Failed to load resource/.test(m.text())) console.log(`[${name} console]`, m.text()); });
      page.on('request', (r) => { if (r.url().startsWith(BASE)) stats.server.push(new URL(r.url()).pathname + new URL(r.url()).search); });
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
      assert.match(await P.page.textContent('#movie-dialog-text'), /own copy/);
      assert.strictEqual(await P.page.evaluate(() => room.drive), null);
      await sleep(300);
      assert.strictEqual(P.stats.requests.length, 0, 'no Google requests in a room without a folder');
      await P.ctx.close();
      console.log('room without a folder: no Drive UI');
    }

    // --- Alice browses: root -> Season 1 -> picks the MKV (remuxer path, needs a resource key)
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
    assert.deepStrictEqual(movie.drive, { id: ID.mkv, resourceKey: 'MKVKEY-1', folder: ID.sub, folderKey: 'SUBKEY-1' });
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
    assert.strictEqual(await bob.evaluate(() => room.drive.keys.size > 0), true);
    await waitFor(alice, () => /Everyone ready/.test(document.getElementById('m-ready').textContent));
    console.log('both ready');

    await ctl(alice, '#m-play');
    await sleep(4000);
    let a = await state(alice), b = await state(bob);
    assert(!a.paused && !b.paused, 'both play');
    // Opening the MKV (header, Cues, tracks) and 4 s of playback: measured 3 fetches (~1 MiB minimum requests,
    // two at a time) plus the 1 MiB-to-4 MiB windows for the 4 MB file. Allow some slack, but a burst of
    // small subtitle reads (the old behaviour) would blow well past it.
    const openCount = A.stats.requests.filter((r) => r.range && r.url.includes(ID.mkv)).length;
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

    // each byte of the file is downloaded once per browser (shared block cache), the server serves no media
    for (const S of [A.stats, B.stats]) {
      assert(S.media[ID.mkv] > 0 && S.media[ID.mkv] <= DATA[ID.mkv].length, `downloaded ${S.media[ID.mkv]} of ${DATA[ID.mkv].length} bytes`);
      assert(S.requests.some((r) => r.range && r.keys?.includes(`${ID.mkv}/MKVKEY-1`)), 'range requests carry the resource key');
      assert(S.requests.every((r) => !r.keys || r.keys.includes(`${ID.root}/ROOTKEY-1`)), 'root resource key always sent');
      assert(S.requests.every((r) => !r.keys || r.keys.split(',').length <= 2), 'only the item\'s and the root\'s resource keys are sent');
    }
    console.log(`media bytes: alice ${A.stats.media[ID.mkv]}, bob ${B.stats.media[ID.mkv]} of ${DATA[ID.mkv].length}`);

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
    assert(menu.includes('subs_en.srt') && !menu.includes('multi.srt'), 'drive group: other files only, the shared one is a normal entry: ' + menu);
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
    // the highlighted current movie in the dialog
    await openDialog(alice);
    await waitFor(alice, () => document.querySelectorAll('#drive-list .drive-item').length === 5);
    assert(await item(alice, 'multi.mkv').evaluate((e) => e.classList.contains('current')), 'current movie highlighted');
    await alice.keyboard.press('Escape');
    console.log('subtitles from Drive: auto-loaded, listed in the CC menu, switchable');

    // --- Carol (phone-sized, late joiner): Drive errors surface, then streaming works
    const quota = { on: true };
    const C = await join(ROOM, 'Carol', { viewport: { width: 375, height: 700 }, quota });
    const carol = C.page;
    await waitFor(carol, () => document.getElementById('movie-overlay').textContent.includes('Stream from Google Drive'));
    await carol.click('#movie-overlay button:has-text("Stream from Google Drive")');
    await waitFor(carol, () => [...document.querySelectorAll('.toast')].some((t) => /temporarily blocked downloads/.test(t.textContent)));
    await waitFor(carol, () => document.getElementById('movie-overlay').textContent.includes('Stream from Google Drive'));
    assert.strictEqual(await carol.evaluate(() => room.player.loaded), false);
    console.log('quota error surfaced as a toast, overlay offers streaming again');
    quota.on = false;
    await carol.click('#movie-overlay button:has-text("Stream from Google Drive")');
    await waitFor(carol, () => document.getElementById('movie').readyState >= 2);
    // dialog layout on a phone
    await carol.click('#t-movie');
    await carol.waitForSelector('#movie-dialog[open]');
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

    // --- Google blocks downloads for this connection (HTML page without CORS headers, the JSON API still works)
    {
      const D = await join(ROOM, 'Dan', { quota: { block: true } });
      await waitFor(D.page, () => document.getElementById('movie-overlay').textContent.includes('Stream from Google Drive'));
      await D.page.click('#movie-overlay button:has-text("Stream from Google Drive")');
      await waitFor(D.page, () => [...document.querySelectorAll('.toast')].some((t) => /temporarily blocking downloads/.test(t.textContent)), null, 30000);
      await sleep(3000);
      const media = D.stats.requests.filter((r) => r.url.includes('alt=media'));
      const diag = D.stats.requests.filter((r) => r.url.includes('fields=id') && !r.url.includes('mimeType'));
      console.log('blocked: media attempts', media.length, 'diagnosis calls', diag.length);
      assert(media.length >= 1 && media.length <= 2, `retry storm: ${media.length} media requests`);
      assert.strictEqual(diag.length, 1, 'one cheap diagnosis call');
      assert.strictEqual(await D.page.evaluate(() => room.player.loaded), false);
      assert((await D.page.textContent('#movie-overlay')).includes('Stream from Google Drive'), 'overlay offers streaming again');
      await D.ctx.close();
    }

    // --- native path: an MP4 whose <video> streams straight from Drive
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
    assert.strictEqual(await bob.evaluate(() => room.player.mode), 'native');
    await sleep(2500);
    const fetches = (S) => S.requests.filter((r) => r.url.includes(ID.mp4) && r.url.includes('alt=media') && r.type === 'fetch').length;
    const fetchesAfterOpen = fetches(B.stats);
    console.log('MEASURE mp4 native after open + 2.5s: fetch', fetchesAfterOpen, 'media', B.stats.requests.filter((r) => r.url.includes(ID.mp4) && r.type === 'media').length);
    assert(fetchesAfterOpen <= 3, `opening the MP4 should take a handful of fetches, took ${fetchesAfterOpen}`);
    assert((await bob.evaluate(() => document.getElementById('movie').currentSrc)).startsWith('https://www.googleapis.com/drive/v3/files/' + ID.mp4), 'native <video> streams from Google');
    await waitFor(alice, () => room.sync.state.movie?.name === 'single.mp4');
    // Alice still holds the MKV (a different file): she switches by streaming the MP4 too
    await openDialog(alice);
    await waitFor(alice, () => document.querySelectorAll('#drive-list .drive-item').length > 0);
    if (await item(alice, 'Season 1').count()) await item(alice, 'Season 1').click();
    await waitFor(alice, () => [...document.querySelectorAll('#drive-list .name')].some((n) => n.textContent === 'single.mp4'));
    assert(await item(alice, 'single.mp4').evaluate((e) => e.classList.contains('current')), 'new room movie highlighted');
    await item(alice, 'single.mp4').click();
    await waitFor(alice, () => document.getElementById('movie').readyState >= 2 && room.player.file?.name === 'single.mp4');
    assert.strictEqual(await alice.evaluate(() => room.player.mode), 'native');
    await waitFor(alice, () => /Everyone ready/.test(document.getElementById('m-ready').textContent));
    await ctl(alice, '#m-play');
    await sleep(3500);
    a = await state(alice); b = await state(bob);
    console.log('native playing:', a.time, b.time);
    assert(!a.paused && !b.paused && Math.abs(a.time - b.time) < 0.4, 'native playback in sync');
    await ctl(bob, '#m-play');
    await sleep(800);
    a = await state(alice); b = await state(bob);
    assert(a.paused && b.paused, 'native pause synced');
    assert.strictEqual(fetches(B.stats), fetchesAfterOpen, 'native playback: the <video> element streams, nothing else fetches');
    assert(B.stats.requests.some((r) => r.url.includes(ID.mp4) && r.type === 'media'), 'the <video> element made the media requests');
    assert(A.stats.requests.some((r) => r.range && r.url.includes(ID.mp4)), 'the browser used Range requests for the MP4');

    // --- the admin removes the folder: the Drive UI disappears, and comes back when re-added
    assert.strictEqual((await api('PUT', `/api/admin/rooms/${ROOM}/drive`, { link: '' })).status, 200);
    await waitFor(alice, () => room.drive === null);
    await openDialog(alice);
    assert(await alice.locator('#drive-section').isHidden(), 'Drive section hidden after removal');
    await alice.keyboard.press('Escape');
    assert.strictEqual((await api('PUT', `/api/admin/rooms/${ROOM}/drive`, { link: ID.root })).status, 200);
    await waitFor(alice, () => room.drive !== null);
    console.log('admin removal / re-adding is picked up live');

    // --- nothing ever came from our server
    for (const S of served) {
      const bad = S.server.filter((p) => !(p.startsWith('/assets/') || p.startsWith('/api/') || p === '/ws' || p.startsWith('/' + ROOM) || p.startsWith('/' + PLAIN) || p === '/favicon.ico' || p === '/healthz'));
      assert.deepStrictEqual(bad, [], 'unexpected requests to our server');
      assert(S.server.every((p) => !/alt=media|\.mkv|\.mp4/.test(p)), 'no media from our server');
      assert(S.referers.length === 0, 'no referrer sent to Google: ' + S.referers[0]);
    }
    console.log('DRIVE CHECK OK');
  } finally {
    await cleanup();
  }
})().catch((err) => {
  console.error('DRIVE CHECK FAILED', err);
  process.exit(1);
});
