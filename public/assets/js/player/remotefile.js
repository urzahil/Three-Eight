// A Blob-like object over HTTP Range requests, so the demuxers and the MSE
// engine can read a remote movie exactly like a local File: they only use
// `name`, `size` and `slice(a, b).arrayBuffer()`.
//
// Everything goes through one block cache (fixed-size blocks, LRU), so the
// video and audio cursors, which scan the same bytes of an interleaved file,
// never download anything twice. Nothing here knows where the bytes come from:
// the caller can inject how errors are worded (`explain`, `networkError`).

const MiB = 1024 * 1024;
const noop = () => {};

/** Errors that come from reading the remote file (as opposed to parsing it). */
export class RemoteError extends Error {
  constructor(message, { status = 0, permanent = false } = {}) {
    super(message);
    this.name = 'RemoteError';
    this.remote = true;
    this.status = status;
    this.permanent = permanent; // retrying the same request will not help
  }
}

export class RemoteFile {
  /**
   * @param {object} o
   * @param {string} o.name
   * @param {number} o.size
   * @param {string|null} [o.nativeUrl]  URL a <video> element can play directly
   * @param {string} [o.url]  where to send Range requests (with the default `request`)
   * @param {() => object} [o.headers]  extra request headers, evaluated per request
   * @param {(start, endInclusive, signal) => Promise<Response>} [o.request]  replaces the default fetch
   * @param {(res: Response) => Promise<Error>} [o.explain]  turns an error response into an Error
   * @param {(err: Error) => Error} [o.networkError]  rewords a failed fetch
   */
  constructor(o) {
    this.name = o.name;
    this.size = o.size;
    this.remote = true;
    this.nativeUrl = o.nativeUrl || null;
    this.blockSize = o.blockSize || 256 * 1024;
    this.cacheBytes = o.cacheBytes ?? 192 * MiB;
    this.maxRequest = Math.max(this.blockSize, o.maxRequest ?? 8 * MiB);
    this.minRequest = o.minRequest ?? MiB; // fewer, larger requests: a small read still fetches this much, if it is missing
    this.maxParallel = o.maxParallel ?? 2;
    this.networkRetryDelay = o.networkRetryDelay ?? 2000;
    this.retries = o.retries ?? 3;
    this.backoff = o.backoff ?? 400;
    this.readAhead = o.readAhead !== false;
    this.explain = o.explain || null;
    this.networkError = o.networkError || null;
    this.prefetching = false;
    this.request = o.request || ((start, end, signal) => fetch(o.url, { headers: { ...(o.headers ? o.headers() : {}), Range: `bytes=${start}-${end}` }, signal }));
    this.blocks = new Map(); // index -> Uint8Array; Map order = LRU order (oldest first)
    this.cached = 0;
    this.pending = new Map(); // index -> Promise<Uint8Array> of in-flight downloads
    this.streams = []; // recent sequential readers, for read-ahead
    this.active = 0;
    this.waiters = [];
    this.closed = false;
    this.abort = new AbortController();
    this.stats = { requests: 0, bytes: 0 };
  }

  /** Like Blob.slice(): nothing is fetched until arrayBuffer(). */
  slice(start = 0, end = this.size) {
    const a = Math.max(0, Math.min(this.size, start < 0 ? this.size + start : start));
    const b = Math.max(a, Math.min(this.size, end < 0 ? this.size + end : end));
    return { size: b - a, arrayBuffer: () => this._read(a, b) };
  }

  /**
   * A view for slow, polite reading of small pieces (embedded subtitles): shares the cache,
   * but reads exactly the blocks needed (no minimum request size, no read-ahead), waiting
   * `pace` ms before each request.
   */
  lite({ pace = 0 } = {}) {
    return {
      name: this.name,
      size: this.size,
      remote: true,
      slice: (start = 0, end = this.size) => {
        const a = Math.max(0, Math.min(this.size, start));
        const b = Math.max(a, Math.min(this.size, end));
        return { size: b - a, arrayBuffer: () => this._read(a, b, { small: true, pace }) };
      },
    };
  }

  /**
   * Native playback downloads by itself and only reports "network error". To learn whether the
   * server really is unreachable (or refusing us), read one small uncached piece ourselves:
   * returns the explaining Error, or null when the file can be read (so the failure is something else).
   */
  async diagnoseFailure() {
    const at = Math.floor(this.size / 2 / this.blockSize) * this.blockSize;
    try {
      await this.lite().slice(at, at + 1).arrayBuffer();
      return null;
    } catch (err) {
      return err?.remote ? err : null;
    }
  }

  /** Abort in-flight requests and drop the cache. The file is unusable afterwards. */
  close() {
    this.closed = true;
    this.abort.abort();
    this.blocks.clear();
    this.pending.clear();
    this.cached = 0;
    for (const w of this.waiters.splice(0)) w();
  }

  // ---- reading -------------------------------------------------------------
  async _read(start, end, { small = false, pace = 0 } = {}) {
    if (this.closed) throw new RemoteError('The movie was closed.', { permanent: true });
    if (end <= start) return new ArrayBuffer(0);
    const bs = this.blockSize;
    const first = Math.floor(start / bs);
    const last = Math.floor((end - 1) / bs);
    if (pace) {
      let need = false;
      for (let i = first; i <= last && !need; i++) need = !this.blocks.has(i) && !this.pending.has(i);
      if (need) await new Promise((r) => setTimeout(r, pace));
      if (this.closed) throw new RemoteError('The movie was closed.', { permanent: true });
    }
    const got = await Promise.all(this._blocks(first, last, small));
    const out = new Uint8Array(end - start);
    for (let i = 0; i < got.length; i++) {
      const bStart = (first + i) * bs;
      const from = Math.max(start, bStart);
      const to = Math.min(end, bStart + got[i].length);
      out.set(got[i].subarray(from - bStart, to - bStart), from - start);
    }
    if (this.readAhead && !small) this._prefetch(start, end);
    return out.buffer;
  }

  /** For blocks first..last: a cached block, or a promise of one. Starts any missing downloads. */
  _blocks(first, last, small = false) {
    const out = [];
    const missing = []; // contiguous runs of blocks nobody has asked for yet: [a, b]
    let run = null;
    for (let i = first; i <= last; i++) {
      const hit = this.blocks.get(i);
      if (hit) {
        this.blocks.delete(i); // refresh LRU position
        this.blocks.set(i, hit);
        out.push(hit);
        run = null;
        continue;
      }
      const inflight = this.pending.get(i);
      if (inflight) {
        out.push(inflight);
        run = null;
        continue;
      }
      // One request per contiguous run, but never more than maxRequest bytes.
      if (!run || (i - run[0] + 1) * this.blockSize > this.maxRequest) {
        run = [i, i];
        missing.push(run);
      } else run[1] = i;
      out.push(null);
    }
    const lastBlock = Math.ceil(this.size / this.blockSize) - 1;
    const wantBlocks = small ? 0 : Math.ceil(this.minRequest / this.blockSize);
    for (const [a, rb] of missing) {
      // Extend a short run to the minimum request size, over blocks nobody has (the next block of
      // this run, if any, is already cached or in flight, so the loop stops there).
      let b = rb;
      while (b - a + 1 < wantBlocks && b < lastBlock && !this.blocks.has(b + 1) && !this.pending.has(b + 1)) b++;
      const promises = this._download(a, b);
      for (let i = a; i <= rb; i++) out[i - first] = promises[i - a];
    }
    return out;
  }

  /** Start downloading blocks a..b with a single request; returns one promise per block. */
  _download(a, b) {
    const run = this._fetchRun(a, b).then((blocks) => {
      blocks.forEach((blk, k) => this._store(a + k, blk));
      return blocks;
    });
    const promises = [];
    for (let i = a; i <= b; i++) {
      const p = run.then((blocks) => blocks[i - a]);
      p.catch(noop); // callers that await it see the error; a prefetch nobody awaits must not be "unhandled"
      this.pending.set(i, p);
      promises.push(p);
    }
    const done = () => {
      for (let i = a; i <= b; i++) if (this.pending.get(i) === promises[i - a]) this.pending.delete(i);
    };
    run.then(done, done);
    return promises;
  }

  _store(index, blk) {
    if (this.closed) return;
    const old = this.blocks.get(index);
    if (old) this.cached -= old.length;
    this.blocks.delete(index);
    this.blocks.set(index, blk);
    this.cached += blk.length;
    while (this.cached > this.cacheBytes && this.blocks.size > 1) {
      const [k, v] = this.blocks.entries().next().value;
      this.blocks.delete(k);
      this.cached -= v.length;
    }
  }

  /**
   * When a read starts where a recent one ended, the reader is scanning
   * sequentially (the demuxer windows), so fetch the next window now: the
   * download then overlaps with the remuxing of the current one.
   */
  _prefetch(start, end) {
    const bs = this.blockSize;
    let s = this.streams.find((x) => start >= x.end - bs && start <= x.end + bs);
    if (!s) {
      s = { end };
      this.streams.push(s);
      if (this.streams.length > 4) this.streams.shift();
      return;
    }
    s.end = end;
    if (end >= this.size || this.prefetching) return; // at most one prefetch at a time
    const len = Math.min(this.maxRequest, Math.max(bs, end - start));
    const first = Math.floor(end / bs);
    const last = Math.floor((Math.min(this.size, end + len) - 1) / bs);
    this.prefetching = true;
    const done = () => { this.prefetching = false; };
    Promise.all(this._blocks(first, last)).then(done, done);
  }

  // ---- network ---------------------------------------------------------------
  async _slot() {
    while (this.active >= this.maxParallel && !this.closed) await new Promise((r) => this.waiters.push(r));
    this.active++;
  }

  _release() {
    this.active--;
    this.waiters.shift()?.();
  }

  /** Download blocks a..b (inclusive) with one Range request, retrying transient failures. */
  async _fetchRun(a, b) {
    await this._slot();
    try {
      let lastErr;
      let netFails = 0;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        if (this.closed) throw new RemoteError('The movie was closed.', { permanent: true });
        if (attempt) {
          // HTTP errors back off exponentially; a request that never got an answer is retried once, slowly.
          const wait = lastErr.network ? this.networkRetryDelay : this.backoff * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
          await new Promise((r) => setTimeout(r, wait));
          if (this.closed) throw new RemoteError('The movie was closed.', { permanent: true });
        }
        try {
          return await this._attempt(a, b);
        } catch (err) {
          lastErr = err;
          if (this.closed) throw new RemoteError('The movie was closed.', { permanent: true });
          if (err.permanent) throw err;
          if (err.network && ++netFails >= 2) throw err;
        }
      }
      throw lastErr;
    } finally {
      this._release();
    }
  }

  async _attempt(a, b) {
    const bs = this.blockSize;
    const start = a * bs;
    const end = Math.min(this.size, (b + 1) * bs); // exclusive
    const ctrl = new AbortController();
    const onClose = () => ctrl.abort();
    this.abort.signal.addEventListener('abort', onClose);
    // Give up on a stalled request, but allow slow connections (>= ~50 KB/s).
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, 20000 + ((end - start) / 51200) * 1000);
    this.stats.requests++;
    try {
      let res;
      try {
        res = await this.request(start, end - 1, ctrl.signal);
      } catch (err) {
        throw this._netError(err, timedOut);
      }
      const whole = start === 0 && end === this.size;
      if (res.status !== 206 && !(res.status === 200 && whole)) {
        if (res.status === 200) {
          ctrl.abort(); // it would send the entire file
          throw new RemoteError('The server ignored the byte range request, so this file cannot be streamed.', { status: 200, permanent: true });
        }
        const retry = res.status >= 500 || res.status === 429;
        let err = null;
        try {
          err = this.explain ? await this.explain(res) : null;
        } catch {
          /* fall back to a generic message */
        }
        if (!err) err = new Error(`The server answered with an error (${res.status}).`);
        // `explain` may already know that retrying is pointless (e.g. a quota that is used up).
        throw Object.assign(err, { remote: true, status: res.status, permanent: err.permanent ?? !retry });
      }
      let data;
      try {
        data = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        throw this._netError(err, timedOut);
      }
      if (data.length !== end - start) throw new RemoteError('The download was cut short.', { status: res.status });
      this.stats.bytes += data.length;
      const blocks = [];
      for (let o = 0; o < data.length; o += bs) blocks.push(data.slice(o, o + bs)); // copy: evicting a block must free its memory
      return blocks;
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener('abort', onClose);
    }
  }

  _netError(err, timedOut) {
    let e = err;
    if (this.networkError) {
      try {
        e = this.networkError(err);
      } catch {
        /* keep the original */
      }
    }
    if (!(e instanceof Error)) e = new Error(timedOut ? 'The download timed out.' : 'Network error.');
    return Object.assign(e, { remote: true, status: 0, permanent: false, network: true });
  }
}
