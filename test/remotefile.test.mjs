// Unit tests for the HTTP Range block cache behind streamed (Google Drive) movies.
// Run with: node --test test/remotefile.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteFile, RemoteError } from '../public/assets/js/player/remotefile.js';

const BS = 1024; // small blocks keep the arithmetic readable
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

function makeData(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 8)) & 255;
  return b;
}

/**
 * Install a fetch that serves `data` like a server honouring Range. `behave(call, n)` may
 * return a Response (or throw) to override a request; `delay` makes responses slow.
 */
function serve(data, { delay = 0, behave = null } = {}) {
  const calls = [];
  let active = 0;
  calls.maxActive = 0;
  globalThis.fetch = async (url, init = {}) => {
    active++;
    calls.maxActive = Math.max(calls.maxActive, active);
    try {
      return await handle(url, init);
    } finally {
      active--;
    }
  };
  const handle = async (url, init) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range || '');
    const call = { start: m ? Number(m[1]) : 0, end: m ? Number(m[2]) : data.length - 1, headers: init.headers, aborted: false };
    calls.push(call);
    init.signal?.addEventListener('abort', () => { call.aborted = true; });
    if (delay) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    }
    const custom = behave?.(call, calls.length);
    if (custom) return custom;
    if (!m) return new Response(data, { status: 200 });
    return new Response(data.subarray(call.start, call.end + 1), { status: 206 });
  };
  return calls;
}

const file = (data, o = {}) => new RemoteFile({ name: 'm.mkv', size: data.length, url: 'https://example.test/f', blockSize: BS, readAhead: false, backoff: 1, minRequest: BS, networkRetryDelay: 1, ...o });
const read = async (f, a, b) => Buffer.from(await f.slice(a, b).arrayBuffer());

test('reads across block boundaries, including the partial last block', async () => {
  const data = makeData(10 * BS + 37);
  serve(data);
  const f = file(data);
  for (const [a, b] of [[0, 10], [BS - 5, BS + 5], [3 * BS, 5 * BS], [100, 100 * 3], [10 * BS, 10 * BS + 37], [10 * BS - 1, data.length], [0, data.length]]) {
    assert.deepEqual(await read(f, a, b), data.subarray(a, b), `range ${a}-${b}`);
  }
  assert.equal(f.slice(5, 3).size, 0);
  assert.equal(f.slice(-10).size, 10);
  assert.equal((await f.slice(data.length, data.length + 50).arrayBuffer()).byteLength, 0);
});

test('one Range request per contiguous run of missing blocks', async () => {
  const data = makeData(32 * BS);
  const calls = serve(data);
  const f = file(data);
  await read(f, 2 * BS + 10, 10 * BS - 10); // blocks 2..9
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].start, calls[0].end], [2 * BS, 10 * BS - 1]);
  await read(f, 0, 14 * BS); // 0..1 and 10..13 are missing, 2..9 cached
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(1).map((c) => [c.start / BS, (c.end + 1) / BS]), [[0, 2], [10, 14]]);
  await read(f, BS, 12 * BS); // fully cached
  assert.equal(calls.length, 3);
});

test('a request never exceeds maxRequest', async () => {
  const data = makeData(32 * BS);
  const calls = serve(data);
  const f = file(data, { maxRequest: 4 * BS });
  assert.deepEqual(await read(f, 0, 10 * BS), data.subarray(0, 10 * BS));
  assert.deepEqual(calls.map((c) => c.end - c.start + 1).sort(), [2 * BS, 4 * BS, 4 * BS]);
});

test('concurrent overlapping reads never download the same bytes twice', async () => {
  const data = makeData(32 * BS);
  const calls = serve(data, { delay: 20 });
  const f = file(data);
  const [a, b, c] = await Promise.all([read(f, 0, 8 * BS), read(f, 4 * BS, 12 * BS), read(f, 6 * BS, 7 * BS)]);
  assert.deepEqual(a, data.subarray(0, 8 * BS));
  assert.deepEqual(b, data.subarray(4 * BS, 12 * BS));
  assert.deepEqual(c, data.subarray(6 * BS, 7 * BS));
  const bytes = calls.reduce((n, x) => n + (x.end - x.start + 1), 0);
  assert.equal(bytes, 12 * BS, 'union of the ranges only');
  assert.equal(calls.length, 2);
});

test('least recently used blocks are evicted first', async () => {
  const data = makeData(16 * BS);
  const calls = serve(data);
  const f = file(data, { cacheBytes: 4 * BS });
  for (let i = 0; i < 4; i++) await read(f, i * BS, (i + 1) * BS);
  await read(f, 0, BS); // block 0 is now the most recently used
  await read(f, 4 * BS, 5 * BS); // evicts block 1
  assert.equal(calls.length, 5);
  assert.ok(f.cached <= 4 * BS);
  await read(f, 0, BS);
  assert.equal(calls.length, 5, 'block 0 survived');
  await read(f, BS, 2 * BS);
  assert.equal(calls.length, 6, 'block 1 was evicted');
});

test('200 for a partial range is rejected without retrying; 200 for the whole file is fine', async () => {
  const data = makeData(8 * BS);
  const calls = serve(data, { behave: () => new Response(data, { status: 200 }) });
  const f = file(data);
  await assert.rejects(read(f, BS, 2 * BS), (e) => e instanceof RemoteError && e.permanent && /range/i.test(e.message));
  assert.equal(calls.length, 1);
  const small = makeData(300);
  serve(small, { behave: () => new Response(small, { status: 200 }) });
  assert.deepEqual(await read(file(small), 0, 300), small);
});

test('retries network errors, 5xx and 429, then succeeds', async () => {
  const data = makeData(8 * BS);
  const statuses = [503, 429];
  const calls = serve(data, {
    behave: (_c, n) => {
      if (n <= 2) return new Response('', { status: statuses[n - 1] });
      if (n === 3) throw new TypeError('network down');
      return null;
    },
  });
  const f = file(data);
  assert.deepEqual(await read(f, 0, 2 * BS), data.subarray(0, 2 * BS));
  assert.equal(calls.length, 4);
});

test('gives up after 3 retries with the explained error', async () => {
  const data = makeData(8 * BS);
  const calls = serve(data, { behave: () => new Response('', { status: 503 }) });
  const f = file(data, { explain: async (res) => new Error(`explained ${res.status}`) });
  await assert.rejects(read(f, 0, BS), /explained 503/);
  assert.equal(calls.length, 4);
});

test('does not retry other 4xx errors', async () => {
  const data = makeData(8 * BS);
  const calls = serve(data, { behave: () => new Response('{}', { status: 403 }) });
  const f = file(data, { explain: async () => new Error('quota') });
  await assert.rejects(read(f, 0, BS), (e) => e.message === 'quota' && e.remote && e.permanent && e.status === 403);
  assert.equal(calls.length, 1);
});

test('a failed download is not cached: the next read tries again', async () => {
  const data = makeData(8 * BS);
  let fail = true;
  const calls = serve(data, { behave: () => (fail ? new Response('', { status: 404 }) : null) });
  const f = file(data);
  await assert.rejects(read(f, 0, BS));
  fail = false;
  assert.deepEqual(await read(f, 0, BS), data.subarray(0, BS));
  assert.equal(calls.length, 2);
});

test('network failures use the injected wording', async () => {
  const data = makeData(4 * BS);
  serve(data, { behave: () => { throw new TypeError('Failed to fetch'); } });
  const f = file(data, { retries: 1, networkError: () => new Error('Could not reach the server.') });
  await assert.rejects(read(f, 0, BS), (e) => e.message === 'Could not reach the server.' && e.remote);
});

test('a truncated body is detected and retried', async () => {
  const data = makeData(4 * BS);
  const calls = serve(data, { behave: (c, n) => (n === 1 ? new Response(data.subarray(c.start, c.start + 10), { status: 206 }) : null) });
  assert.deepEqual(await read(file(data), 0, BS), data.subarray(0, BS));
  assert.equal(calls.length, 2);
});

test('extra request headers are sent on every request', async () => {
  const data = makeData(4 * BS);
  const calls = serve(data);
  await read(file(data, { headers: () => ({ 'X-Test': 'yes' }) }), 0, BS);
  assert.equal(calls[0].headers['X-Test'], 'yes');
});

test('close() aborts in-flight requests and rejects further reads', async () => {
  const data = makeData(8 * BS);
  const calls = serve(data, { delay: 5000 });
  const f = file(data);
  const pending = read(f, 0, 2 * BS);
  await new Promise((r) => setTimeout(r, 30));
  f.close();
  await assert.rejects(pending, (e) => e.remote);
  assert.ok(calls[0].aborted);
  await assert.rejects(read(f, 0, BS), /closed/);
  assert.equal(calls.length, 1, 'no retry after close');
});

test('a sequential reader gets the next window prefetched', async () => {
  const data = makeData(64 * BS);
  const calls = serve(data);
  const f = file(data, { readAhead: true });
  await read(f, 0, 4 * BS); // first read: nothing to infer yet
  assert.equal(calls.length, 1);
  await read(f, 4 * BS, 8 * BS); // sequential: blocks 8..11 are fetched ahead
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.map((c) => c.start / BS), [0, 4, 8]);
  const n = calls.length;
  assert.deepEqual(await read(f, 8 * BS, 12 * BS), data.subarray(8 * BS, 12 * BS));
  assert.equal(calls.length, n + 1, 'served from the prefetch, only the next window is requested');
  await read(f, 40 * BS, 41 * BS); // a seek elsewhere is not read-ahead material
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, n + 2);
});

test('at most 2 requests run in parallel by default', async () => {
  const data = makeData(32 * BS);
  const calls = serve(data, { delay: 10 });
  const f = file(data, { maxRequest: BS }); // every block is its own request
  await Promise.all([0, 1, 2, 3, 4, 5].map((i) => read(f, i * BS, (i + 1) * BS)));
  assert.equal(calls.length, 6);
  assert.equal(calls.maxActive, 2);
});

test('small reads are extended to the minimum request size, over missing blocks only, clipped to the file end', async () => {
  const data = makeData(32 * BS);
  const calls = serve(data);
  const f = file(data, { minRequest: 4 * BS });
  await read(f, 10 * BS + 5, 10 * BS + 50);
  assert.deepEqual([calls[0].start / BS, (calls[0].end + 1) / BS], [10, 14], 'one block asked for, four fetched');
  await read(f, 8 * BS, 9 * BS); // the extension stops at the cached block 10
  assert.deepEqual([calls[1].start / BS, (calls[1].end + 1) / BS], [8, 10]);
  await read(f, 12 * BS, 13 * BS);
  assert.equal(calls.length, 2, 'already cached');
  await read(f, 30 * BS, 31 * BS); // near the end
  assert.equal(calls[2].end, data.length - 1);
  assert.equal(calls[2].start, 30 * BS, 'only what is left');
  await read(f, 20 * BS, 22 * BS); // already longer than the minimum: no padding
  assert.equal(calls[3].end - calls[3].start + 1, 4 * BS, 'a 2 block read still gets the minimum');
  await read(f, 24 * BS, 29 * BS);
  assert.equal(calls[4].end - calls[4].start + 1, 5 * BS, 'bigger reads are not padded');
});

test('lite reads fetch exactly the blocks needed', async () => {
  const data = makeData(32 * BS);
  const calls = serve(data);
  const f = file(data, { minRequest: 4 * BS });
  const lite = f.lite({ pace: 1 });
  assert.deepEqual(Buffer.from(await lite.slice(5 * BS + 1, 5 * BS + 9).arrayBuffer()), data.subarray(5 * BS + 1, 5 * BS + 9));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].end - calls[0].start + 1, BS);
});

test('a request without any answer is retried exactly once, after the delay', async () => {
  const data = makeData(8 * BS);
  const calls = serve(data, { behave: () => { throw new TypeError('Failed to fetch'); } });
  const f = file(data, { networkRetryDelay: 80 });
  const t0 = Date.now();
  await assert.rejects(read(f, 0, BS), (e) => e.remote && e.network && !e.permanent);
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - t0 >= 70, 'waited before retrying');
});

test('an explanation can mark an error permanent, so it is not retried', async () => {
  const data = makeData(8 * BS);
  const calls = serve(data, { behave: () => new Response('{"error":"quota"}', { status: 503 }) });
  const f = file(data, { explain: async () => Object.assign(new Error('quota used up'), { permanent: true }) });
  await assert.rejects(read(f, 0, BS), (e) => e.message === 'quota used up' && e.permanent && e.status === 503);
  assert.equal(calls.length, 1, 'no retries');
});

test('diagnoseFailure reads one uncached piece: null if it works, the explanation if not', async () => {
  const data = makeData(8 * BS);
  serve(data);
  assert.equal(await file(data).diagnoseFailure(), null);
  serve(data, { behave: () => { throw new TypeError('x'); } });
  const f = file(data, { networkError: () => new Error('offline-ish') });
  const err = await f.diagnoseFailure();
  assert.equal(err.message, 'offline-ish');
});

test('only one read-ahead download is in flight at a time', async () => {
  const data = makeData(64 * BS);
  const calls = serve(data, { delay: 30 });
  const f = file(data, { readAhead: true, maxRequest: 4 * BS });
  await read(f, 0, 4 * BS);
  await read(f, 4 * BS, 8 * BS); // starts the prefetch of 8..11 (slow)
  await read(f, 8 * BS, 9 * BS); // joins that prefetch
  const before = calls.length;
  await read(f, 12 * BS, 16 * BS); // sequential again: new prefetch only when the earlier one is done
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(calls.length - before <= 3);
});
