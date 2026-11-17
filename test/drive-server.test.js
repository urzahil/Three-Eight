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
