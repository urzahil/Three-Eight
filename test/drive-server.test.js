// The Drive client of the server (server/drive.js) against the fake Google: limits, cancellation, listing limits,
// the folder-tree memo and Content-Range checks. Run with: node --test test/drive-server.test.js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GoogleDrive, DriveError, loadServiceAccount, MiB } = require('../server/drive');
const { startFakeGoogle } = require('./fake-google');

let google, keyDir, account;
before(async () => {
  google = await startFakeGoogle();
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-eight-drive-'));
  account = loadServiceAccount(google.writeAccount(keyDir), { testEndpoints: true });
});
after(async () => {
  await google.close();
  fs.rmSync(keyDir, { recursive: true, force: true });
});
test.afterEach(() => {
  google.mode.slowMs = 0;
  google.mode.shiftMedia = 0;
  google.mode.failMedia = 0;
  google.mode.pageLimit = 1000;
});

const makeDrive = (o = {}) => new GoogleDrive({ account, apiBase: google.url, cacheBytes: 64 * MiB, retryBackoffMs: 5, networkRetryMs: 5, ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function collect(gen) {
  const parts = [];
  for await (const c of gen) parts.push(c);
  return Buffer.concat(parts);
}
const id = (n) => `DRVTEST_${String(n).padStart(8, '0')}`;

test('the waiting queue is capped: more than maxQueue requests waiting for an upstream slot get a "busy" 503', async () => {
  const drive = makeDrive({ maxUpstream: 1, maxQueue: 2 });
  google.addFolder(id(1), 'Queue folder');
  const data = crypto.randomBytes(MiB);
  for (let i = 0; i < 4; i++) google.addFile(id(10 + i), `q${i}.mp4`, id(1), data, 'video/mp4');
  google.mode.slowMs = 150;
  const reads = [0, 1, 2, 3].map((i) => collect(drive.read(id(10 + i), data.length, 0, data.length - 1)).then((b) => ({ ok: b.equals(data) }), (e) => ({ err: e })));
  const out = await Promise.all(reads);
  const failed = out.filter((r) => r.err);
  assert.strictEqual(failed.length, 1, 'one request too many');
  assert(failed[0].err instanceof DriveError);
  assert.strictEqual(failed[0].err.status, 503);
  assert.strictEqual(failed[0].err.message, 'Google Drive is busy, try again shortly.');
  assert(!failed[0].err.retryable && !failed[0].err.permanent, 'refused at once, not retried by the server');
  assert.strictEqual(out.filter((r) => r.ok).length, 3, 'the others were served');
  assert.strictEqual(drive.queue.length, 0);
  assert.strictEqual(drive.active, 0);
});

test('a waiter whose run is aborted leaves the queue at once, not when a slot frees up', async () => {
  const drive = makeDrive({ maxUpstream: 1 });
  google.addFolder(id(2), 'Abort folder');
  const data = crypto.randomBytes(MiB);
  google.addFile(id(20), 'a.mp4', id(2), data, 'video/mp4');
  google.addFile(id(21), 'b.mp4', id(2), data, 'video/mp4');
  google.mode.slowMs = 400;
  const first = collect(drive.read(id(20), data.length, 0, data.length - 1));
  await sleep(50);
  assert.strictEqual(drive.active, 1);
  const ctrl = new AbortController();
  const second = collect(drive.read(id(21), data.length, 0, data.length - 1, ctrl.signal));
  await sleep(50);
  assert.strictEqual(drive.queue.length, 1, 'the second request waits for the slot');
  ctrl.abort();
  await sleep(20);
  assert.strictEqual(drive.queue.length, 0, 'gone as soon as it was aborted, while the first still holds the slot');
  assert.strictEqual(drive.active, 1);
  assert.strictEqual((await second).length, 0, 'an aborted read just ends');
  assert((await first).equals(data));
  assert.strictEqual(google.entries('media', id(21)).length, 0, 'nothing was asked of Google for it');
  assert.strictEqual(drive.active, 0);
});

test('a folder listing stops at maxListItems and says so; pages are capped too', async () => {
  google.addFolder(id(3), 'Big folder');
  for (let i = 0; i < 12; i++) google.addFile(id(30 + i), `m${String(i).padStart(2, '0')}.mp4`, id(3), Buffer.from('x'), 'video/mp4');
  for (let i = 0; i < 6; i++) google.addFile(id(50 + i), `notes${i}.txt`, id(3), Buffer.from('x'), 'text/plain');

  const all = await makeDrive().listing(id(3));
  assert.deepStrictEqual([all.items.length, all.truncated], [12, false]);

  const d5 = makeDrive({ maxListItems: 5 });
  const cut = await d5.listing(id(3));
  assert.strictEqual(cut.items.length, 5);
  assert.strictEqual(cut.truncated, true);
  assert.strictEqual((await d5.list(id(3))).length, 5, 'list() is the same items');

  const exact = await makeDrive({ maxListItems: 12 }).listing(id(3));
  assert.deepStrictEqual([exact.items.length, exact.truncated], [12, false], 'exactly at the limit is not truncated');

  // pages: 18 files at 4 per page is 5 pages; reading at most 2 of them leaves most out
  google.mode.pageLimit = 4;
  const before = google.entries('list').length;
  const paged = await makeDrive({ maxListPages: 2 }).listing(id(3));
  assert.strictEqual(google.entries('list').length - before, 2, 'it stopped asking for pages');
  assert.strictEqual(paged.truncated, true);
  assert(paged.items.length < 12);
  const full = await makeDrive().listing(id(3));
  assert.deepStrictEqual([full.items.length, full.truncated], [12, false], 'without the cap all pages are read');
});

test('a 206 with the right length but another offset is refused (and retried); a persistent one fails with a 502', async () => {
  const drive = makeDrive();
  google.addFolder(id(4), 'Range folder');
  const data = crypto.randomBytes(2 * MiB + 100);
  google.addFile(id(40), 'r.mp4', id(4), data, 'video/mp4');
  google.mode.shiftMedia = 1;
  const got = await collect(drive.read(id(40), data.length, 0, data.length - 1));
  assert(got.equals(data), 'the shifted answer was not used: the retry brought the right bytes');
  assert.strictEqual(google.entries('media', id(40)).filter((e) => e.shifted).length, 1);
  assert(google.entries('media', id(40)).length >= 2);

  // every answer shifted: after the retries the error reaches the caller, and nothing wrong is cached
  const drive2 = makeDrive();
  google.mode.shiftMedia = 100;
  await assert.rejects(collect(drive2.read(id(40), data.length, 0, data.length - 1)), (e) => e instanceof DriveError && e.status === 502 && /different part/.test(e.message));
  assert.strictEqual(drive2.cached, 0);
  google.mode.shiftMedia = 0;
  assert((await collect(drive2.read(id(40), data.length, 1000, 5000))).equals(data.subarray(1000, 5001)));
});

test('the folder-tree memo: "inside" is believed for 60 s, "not inside" for 5 minutes', async () => {
  const drive = makeDrive();
  google.addFolder(id(5), 'Tree root');
  google.addFolder(id(6), 'Tree sub', id(5));
  google.addFile(id(60), 't.mp4', id(6), Buffer.from('x'), 'video/mp4');
  google.addFolder(id(7), 'Elsewhere');
  google.addFile(id(70), 'e.mp4', id(7), Buffer.from('x'), 'video/mp4');
  const metas = () => google.entries('meta').length;
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    assert.strictEqual(await drive.inTree(id(5), id(60)), true);
    let m = metas();
    assert(m > 0);
    now += 59_000;
    assert.strictEqual(await drive.inTree(id(5), id(60)), true);
    assert.strictEqual(metas(), m, 'still remembered after 59 s');
    now += 2_000;
    assert.strictEqual(await drive.inTree(id(5), id(60)), true);
    assert(metas() > m, 'asked Google again after 61 s');
    // children of a listed folder are marked inside too, with the same short life
    drive.markInTree(id(5), [id(61)]);
    m = metas();
    assert.strictEqual(await drive.inTree(id(5), id(61)), true);
    assert.strictEqual(metas(), m);
    now += 61_000;
    google.addFile(id(61), 'late.mp4', id(7), Buffer.from('x'), 'video/mp4'); // moved out of the room's folder meanwhile
    assert.strictEqual(await drive.inTree(id(5), id(61)), false, 'a positive answer does not outlive its 60 s');

    // negative answers keep their 5 minutes
    assert.strictEqual(await drive.inTree(id(5), id(70)), false);
    m = metas();
    now += 4 * 60_000;
    assert.strictEqual(await drive.inTree(id(5), id(70)), false);
    assert.strictEqual(metas(), m, 'a negative answer is still remembered after 4 minutes');
    now += 61_000;
    assert.strictEqual(await drive.inTree(id(5), id(70)), false);
    assert(metas() > m, 'and checked again after 5');
  } finally {
    Date.now = realNow;
  }
});

test('the tree walk stops at an ancestor already known to be inside, and skips one known to be outside', async () => {
  const drive = makeDrive();
  google.addFolder(id(800), 'Walk root');
  google.addFolder(id(801), 'Walk a', id(800));
  google.addFolder(id(802), 'Walk b', id(801));
  google.addFolder(id(803), 'Walk c', id(802));
  google.addFile(id(810), 'deep.mp4', id(803), Buffer.from('x'), 'video/mp4');
  drive.markInTree(id(800), [id(803)]); // as a listing of folder b would
  const before = google.entries('meta').length;
  assert.strictEqual(await drive.inTree(id(800), id(810)), true);
  assert.strictEqual(google.entries('meta').length - before, 1, 'only the file itself was looked up');

  google.addFolder(id(820), 'Outside');
  google.addFolder(id(821), 'Outside sub', id(820));
  google.addFile(id(830), 'out.mp4', id(821), Buffer.from('x'), 'video/mp4');
  assert.strictEqual(await drive.inTree(id(800), id(821)), false);
  const mid = google.entries('meta').length;
  assert.strictEqual(await drive.inTree(id(800), id(830)), false);
  assert.strictEqual(google.entries('meta').length - mid, 1, 'its parent is known to be outside: no walk above it');
});

test('a long stream lets go of the runs it has read past (their blocks are not pinned in memory)', async () => {
  const drive = makeDrive({ cacheBytes: 4 * MiB });
  google.addFolder(id(60), 'Long stream');
  const data = crypto.randomBytes(24 * MiB);
  google.addFile(id(61), 'long.mp4', id(60), data, 'video/mp4');
  const runs = [];
  const startRun = drive._startRun.bind(drive);
  drive._startRun = (...a) => {
    const run = startRun(...a);
    runs.push(run);
    return run;
  };
  const gen = drive.read(id(61), data.length, 0, data.length - 1);
  const parts = [];
  for (let i = 0; i < 20; i++) parts.push((await gen.next()).value);
  // Every run that ended before the current block is released by the reader and holds no blocks any more.
  const behind = runs.filter((r) => r.done && r.b < 19);
  assert(behind.length >= 1, 'some runs were already read past');
  for (const r of behind) {
    // (Boolean checks: a diff of the run would try to print its megabytes of blocks.)
    assert(r.promise === null, `the finished run ${r.a}..${r.b} drops its blocks`);
    assert(r.refs === 0, `and the reader no longer holds run ${r.a}..${r.b}`);
  }
  for (;;) {
    const { value, done } = await gen.next();
    if (done) break;
    parts.push(value);
  }
  assert(Buffer.concat(parts).equals(data));
  assert.strictEqual(drive.active, 0);
});

test('metadata calls share one rate for all callers; past the waiting room they are refused as "busy" at once', async () => {
  const drive = makeDrive({ metaRate: 20, metaBurst: 3, metaQueue: 2 }); // one call every 50 ms after a burst of 3
  google.addFolder(id(900), 'Meta folder');
  for (let i = 0; i < 8; i++) google.addFile(id(901 + i), `meta${i}.mp4`, id(900), Buffer.from('x'), 'video/mp4');
  const t0 = Date.now();
  const out = await Promise.all([...Array(8).keys()].map((i) => drive.fileMeta(id(901 + i)).then(
    () => ({ at: Date.now() - t0 }),
    (err) => ({ err, at: Date.now() - t0 }),
  )));
  const served = out.filter((o) => !o.err).map((o) => o.at).sort((a, b) => a - b);
  const busy = out.filter((o) => o.err);
  assert.strictEqual(served.length, 5, 'three at once, two after waiting');
  assert.strictEqual(busy.length, 3);
  for (const b of busy) {
    assert(b.err instanceof DriveError);
    assert.strictEqual(b.err.status, 503);
    assert.match(b.err.message, /busy/);
    assert(b.at < 40, 'refused without waiting');
  }
  assert(served[3] >= 40, `the first waiting call went out after a token was refilled (${served[3]} ms)`);
  assert(served[4] >= 90, `and the second one 50 ms later (${served[4]} ms)`);
  // The bucket refills: after a pause there is room for a burst again.
  await sleep(200);
  google.addFile(id(910), 'later.mp4', id(900), Buffer.from('x'), 'video/mp4');
  assert.strictEqual((await drive.fileMeta(id(910))).name, 'later.mp4');
});

test('kindOf: a shortcut is never a video or subtitle, whatever its name', () => {
  const { kindOf } = require('../server/drive');
  const SHORTCUT = 'application/vnd.google-apps.shortcut';
  assert.strictEqual(kindOf({ name: 'movie.mkv', mimeType: SHORTCUT }), null);
  assert.strictEqual(kindOf({ name: 'movie.srt', mimeType: SHORTCUT }), null);
  assert.strictEqual(kindOf({ name: 'movie.mkv', mimeType: 'application/octet-stream' }), 'video');
  assert.strictEqual(kindOf({ name: 'x', mimeType: 'application/vnd.google-apps.folder' }), 'folder');
  // Formats no browser plays are listed as such, not offered as films.
  assert.strictEqual(kindOf({ name: 'old.avi', mimeType: 'video/x-msvideo' }), 'unsupported');
  assert.strictEqual(kindOf({ name: 'rec.ts', mimeType: 'video/mp2t' }), 'unsupported');
  assert.strictEqual(kindOf({ name: 'clip', mimeType: 'video/x-ms-wmv' }), 'unsupported');
  assert.strictEqual(kindOf({ name: 'film', mimeType: 'video/mp4' }), 'video', 'a playable type without an extension');
  assert.strictEqual(kindOf({ name: 'film.MKV', mimeType: 'video/x-matroska' }), 'video');
});

test('a file replaced in Drive (same ID) is never served as a mix of the old and the new bytes', async () => {
  const drive = makeDrive();
  google.addFolder(id(950), 'Replaced folder');
  const v1 = crypto.randomBytes(3 * MiB);
  google.addFile(id(951), 'film.mkv', id(950), v1, 'video/x-matroska');
  const m1 = await drive.fileMeta(id(951));
  assert.match(m1.rev, /^[0-9a-f]{32}$/, 'the content revision is the MD5');
  assert((await collect(drive.read(id(951), m1.size, 0, m1.size - 1, undefined, m1.rev))).equals(v1));
  // Someone uploads a new version of the same size ("Manage versions" keeps the ID); the metadata is asked again later.
  const v2 = crypto.randomBytes(3 * MiB);
  google.files.get(id(951)).data = v2;
  drive._metas.delete(id(951));
  const m2 = await drive.fileMeta(id(951));
  assert.notStrictEqual(m2.rev, m1.rev);
  const before = google.entries('media', id(951)).length;
  assert((await collect(drive.read(id(951), m2.size, 0, m2.size - 1, undefined, m2.rev))).equals(v2), 'the new bytes, none from the cache of the old');
  assert(google.entries('media', id(951)).length > before, 'fetched again from Google');
  // A shorter new version: its size alone is enough to tell it apart, even when Drive gives no revision.
  const v3 = crypto.randomBytes(2 * MiB);
  google.files.get(id(951)).data = v3;
  assert((await collect(drive.read(id(951), v3.length, 0, v3.length - 1))).equals(v3));
});
