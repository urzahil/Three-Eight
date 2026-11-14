// Google Drive access for the server.
//
// The server signs in to Google as a service account and reads the folders
// that were shared with it. Room members never talk to Google: they fetch
// folder listings and file bytes from our HTTP endpoints (see server.js),
// which are served from here.
//
//   - ServiceAccount: loads the JSON key file.
//   - GoogleDrive:    OAuth (JWT bearer), listing, metadata, the folder-tree
//                     check, and a block cache for media with request
//                     coalescing, so Google sees each byte about once even
//                     when several people watch the same film.
//
// Nothing here ever logs or returns a private key, an access token or a
// room token.

'use strict';

const crypto = require('crypto');
const fs = require('fs');

const MiB = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const FOLDER = 'application/vnd.google-apps.folder';
const VIDEO_EXT = new Set(['mkv', 'mp4', 'm4v', 'mov', 'webm', 'avi']);
const SUB_EXT = new Set(['srt', 'vtt', 'ass', 'ssa']);
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

const BLOCK = MiB; // cache granularity
const MAX_RUN_BLOCKS = 8; // one upstream request fetches at most 8 MiB
const TREE_DEPTH = 32;

const noop = () => {};
const ext = (name) => (String(name).match(/\.([A-Za-z0-9]+)$/)?.[1] || '').toLowerCase();

/** What a Drive entry is for us: 'folder', 'video', 'subtitle', or null (documents, images, shortcuts, ...). */
function kindOf(f) {
  if (f.mimeType === FOLDER) return 'folder';
  const e = ext(f.name);
  if (String(f.mimeType).startsWith('video/') || VIDEO_EXT.has(e)) return 'video';
  if (SUB_EXT.has(e)) return 'subtitle';
  return null;
}

/** An error whose message is meant for people. `status` is the HTTP status we answer with. */
class DriveError extends Error {
  constructor(message, status = 502, extra = {}) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    Object.assign(this, extra); // permanent, retryable, network, aborted
  }
}

// ---- service account key -------------------------------------------------------------------
/**
 * Reads the key file. Throws an Error with a message that is safe to log (it never contains file
 * contents). Returns { email, privateKey, tokenUri }.
 */
function loadServiceAccount(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`the file could not be read (${err.code || 'error'})`);
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('the file is not valid JSON');
  }
  if (!j || typeof j !== 'object' || typeof j.client_email !== 'string' || !j.client_email.includes('@') || typeof j.private_key !== 'string') {
    throw new Error('the file is not a service account key (client_email or private_key is missing)');
  }
  try {
    crypto.createPrivateKey(j.private_key);
  } catch {
    throw new Error('the private_key in the file is not a valid key');
  }
  const tokenUri = typeof j.token_uri === 'string' && j.token_uri ? j.token_uri : DEFAULT_TOKEN_URI;
  let u;
  try {
    u = new URL(tokenUri);
  } catch {
    throw new Error('token_uri in the file is not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('token_uri in the file is not a valid URL');
  return { email: j.client_email, privateKey: j.private_key, tokenUri };
}

const b64u = (x) => Buffer.from(x).toString('base64url');

/** A signed JWT assertion for the OAuth "jwt-bearer" grant. */
function makeAssertion(account, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({ iss: account.email, scope: SCOPE, aud: account.tokenUri, iat, exp: iat + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), account.privateKey);
  return `${head}.${claims}.${b64u(sig)}`;
}

// ---- small TTL memo (shares in-flight work, never keeps failures) ---------------------------------
class Memo {
  constructor(ttlMs, max = 500) {
    this.ttl = ttlMs;
    this.max = max;
    this.map = new Map(); // key -> { p, exp }
  }

  run(key, fn) {
    const e = this.map.get(key);
    if (e && e.exp > Date.now()) return e.p;
    const entry = { p: Promise.resolve().then(fn), exp: Date.now() + this.ttl };
    this.map.set(key, entry);
    entry.p.catch(() => { if (this.map.get(key) === entry) this.map.delete(key); });
    this._prune();
    return entry.p;
  }

  put(key, value) {
    this.map.set(key, { p: Promise.resolve(value), exp: Date.now() + this.ttl });
    this._prune();
  }

  delete(key) {
    this.map.delete(key);
  }

  _prune() {
    if (this.map.size <= this.max) return;
    const now = Date.now();
    for (const [k, e] of this.map) if (e.exp <= now) this.map.delete(k);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

/** Parse a `Range` header. null: none (or another unit, which is ignored); 'invalid'; or { start, end } (inclusive). */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(.*)$/i.exec(String(header).trim());
  if (!m) return null;
  const spec = /^(\d*)-(\d*)$/.exec(m[1].trim()); // a list of ranges does not match: unsupported
  if (!spec || (spec[1] === '' && spec[2] === '')) return 'invalid';
  if (size <= 0) return 'invalid';
  if (spec[1] === '') {
    const n = Number(spec[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return 'invalid';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(spec[1]);
  const end = spec[2] === '' ? size - 1 : Number(spec[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DriveError('Cancelled', 499, { aborted: true }));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DriveError('Cancelled', 499, { aborted: true })); }, { once: true });
});

// ---- the Drive client ------------------------------------------------------------------------------
class GoogleDrive {
  /**
   * @param {object} o
   * @param {{email, privateKey, tokenUri}} o.account
   * @param {string} [o.apiBase]  https://www.googleapis.com (tests point it at a fake)
   * @param {number} [o.cacheBytes]  block cache budget
   * @param {number} [o.maxUpstream]  concurrent media requests to Google, across all clients
   */
  constructor({ account, apiBase = 'https://www.googleapis.com', cacheBytes = 256 * MiB, maxUpstream = 4, retryBackoffMs = 400, networkRetryMs = 1000 }) {
    this.account = account;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.cacheBytes = cacheBytes;
    this.maxUpstream = maxUpstream;
    this.retryBackoffMs = retryBackoffMs;
    this.networkRetryMs = networkRetryMs;

    this._tok = null; // { value, exp }
    this._refreshing = null;

    this._lists = new Memo(60_000, 200); // folder id -> items
    this._infos = new Memo(60_000, 500); // id -> { id, name, mimeType }
    this._metas = new Memo(60_000, 2000); // id -> file metadata (name, mimeType, size, trashed)
    this._tree = new Memo(5 * 60_000, 20_000); // "<room folder>/<id>" -> boolean

    this.blocks = new Map(); // "<file>:<index>" -> Buffer; Map order = LRU order (oldest first)
    this.cached = 0;
    this.pending = new Map(); // "<file>:<index>" -> { run, promise }
    this.active = 0;
    this.queue = [];
  }

  // ---- authentication -----------------------------------------------------------------------
  /** A valid access token. `rejected`: a token Google just refused, which is dropped. */
  async _accessToken(rejected = null) {
    if (rejected && this._tok && this._tok.value === rejected) this._tok = null;
    if (this._tok && this._tok.exp - 60_000 > Date.now()) return this._tok.value;
    if (!this._refreshing) this._refreshing = this._fetchToken().finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async _fetchToken() {
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: makeAssertion(this.account) });
    let res;
    try {
      res = await fetch(this.account.tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new DriveError('Could not reach Google to sign in.', 502, { network: true });
    }
    let j = null;
    try {
      j = await res.json();
    } catch { /* not JSON */ }
    if (!res.ok || !j || typeof j.access_token !== 'string') {
      const code = String(j?.error || res.status);
      if (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client') {
        throw new DriveError('Google rejected the service account key. It may have been deleted or disabled, or the server\'s clock is wrong.', 502, { permanent: true });
      }
      throw new DriveError(`Google sign-in failed (${code}).`, 502, { retryable: res.status >= 500 || res.status === 429 });
    }
    const ttl = Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600;
    this._tok = { value: j.access_token, exp: Date.now() + ttl * 1000 };
    return this._tok.value;
  }

  // ---- HTTP ------------------------------------------------------------------------------------
  /**
   * An authorized request to the API. Refreshes the token and retries once on a 401. Redirects are
   * refused so the bearer token can never be sent anywhere else. Returns the Response (any status);
   * a failure to get an answer throws a network DriveError.
   */
  async _request(url, { headers = {}, signal, timeoutMs = 30_000 } = {}) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) ctrl.abort();
    try {
      let token = await this._accessToken();
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await fetch(url, { headers: { ...headers, Authorization: `Bearer ${token}` }, redirect: 'error', signal: ctrl.signal });
        } catch (err) {
          if (signal?.aborted) throw new DriveError('Cancelled', 499, { aborted: true });
          const redirected = /redirect/i.test(String(err?.cause?.message || err?.message));
          throw new DriveError('Could not reach Google Drive.', 502, { network: true, noRetry: redirected, timedOut });
        }
        if (res.status === 401 && attempt === 0) {
          await res.body?.cancel().catch(noop);
          token = await this._accessToken(token);
          continue;
        }
        // The body is read by the caller; keep the timer and the abort link until it is done.
        res.finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
        return res;
      }
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      throw err;
    }
  }

  /** Retry transient failures: no answer (once, after a pause), 5xx and 429 (backoff, up to 3 times). */
  async _retrying(fn, signal) {
    let netRetried = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (signal?.aborted || !(err instanceof DriveError) || err.aborted) throw err;
        if (err.network && !err.noRetry) {
          if (netRetried) throw err;
          netRetried = true;
          await sleep(this.networkRetryMs, signal);
          continue;
        }
        if (err.retryable && attempt < 3) {
          await sleep(this.retryBackoffMs * 2 ** attempt * (0.75 + Math.random() * 0.5), signal);
          continue;
        }
        throw err;
      }
    }
  }

  /** Turn an error response from Google into a DriveError with a readable message. */
  async _errorFrom(res) {
    let body = null;
    try {
      body = await res.json();
    } catch { /* not JSON */ }
    res.finish?.();
    const e = body?.error || {};
    const reason = e.errors?.[0]?.reason || e.status || '';
    const message = String(e.message || '');
    const status = res.status;
    const retryable = status >= 500 || status === 429;
    const mail = this.account.email;
    if (reason === 'downloadQuotaExceeded') return new DriveError('Google Drive has temporarily blocked downloads of this file because it was downloaded too often. Try again later or use your own copy.', 503, { permanent: true });
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'sharingRateLimitExceeded' || status === 429) return new DriveError('Google Drive is rate limiting requests, try again in a minute.', 503, { retryable });
    if (reason === 'dailyLimitExceeded' || reason === 'quotaExceeded') return new DriveError('The server\'s Google Drive quota has been used up for today. Try again later.', 503, { permanent: true });
    if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(message)) return new DriveError('The Google Drive API is not enabled for the service account\'s Google Cloud project.', 503, { permanent: true });
    if (status === 404 || reason === 'notFound' || reason === 'forbidden' || reason === 'insufficientFilePermissions') return new DriveError(`The file or folder was not found, or it isn't shared with the service account ${mail}.`, 404, { permanent: true });
    if (status === 401 || status === 403) return new DriveError('Google Drive denied access. Check the service account key and that the Drive API is enabled for its project.', 502, { permanent: true });
    if (status >= 500) return new DriveError(`Google Drive had a problem (error ${status}). Try again in a moment.`, 502, { retryable });
    if (status === 416) return new DriveError('Google Drive could not serve that part of the file.', 502, { permanent: true });
    return new DriveError(message ? `Google Drive said: ${message}` : `Google Drive returned an error (${status}).`, 502, { permanent: true });
  }

  async _json(pathAndQuery) {
    return this._retrying(async () => {
      const res = await this._request(`${this.apiBase}/drive/v3/${pathAndQuery}`);
      if (!res.ok) throw await this._errorFrom(res);
      try {
        return await res.json();
      } catch {
        throw new DriveError('Google Drive sent an unreadable answer.', 502, { retryable: true });
      } finally {
        res.finish?.();
      }
    });
  }

  static _id(id) {
    if (!ID_RE.test(String(id))) throw new DriveError('That is not a valid Google Drive ID.', 404);
    return encodeURIComponent(id);
  }

  // ---- metadata --------------------------------------------------------------------------------
  /** { id, name, mimeType } */
  folderInfo(id) {
    const eid = GoogleDrive._id(id);
    return this._infos.run(id, async () => {
      const f = await this._json(`files/${eid}?${new URLSearchParams({ fields: 'id,name,mimeType', supportsAllDrives: 'true' })}`);
      return { id: f.id, name: String(f.name), mimeType: f.mimeType };
    });
  }

  /** { id, name, mimeType, size, trashed } of any file. */
  fileMeta(id) {
    const eid = GoogleDrive._id(id);
    return this._metas.run(id, async () => {
      const f = await this._json(`files/${eid}?${new URLSearchParams({ fields: 'id,name,mimeType,size,trashed', supportsAllDrives: 'true' })}`);
      return { id: f.id, name: String(f.name), mimeType: String(f.mimeType || ''), size: Number(f.size), trashed: !!f.trashed };
    });
  }

  /** IDs of the folders that contain this file (usually one). */
  async parents(id) {
    const eid = GoogleDrive._id(id);
    const f = await this._json(`files/${eid}?${new URLSearchParams({ fields: 'parents', supportsAllDrives: 'true' })}`);
    return Array.isArray(f.parents) ? f.parents.filter((p) => ID_RE.test(String(p))) : [];
  }

  /** Folders, videos and subtitle files in a folder: folders first, then by name. Cached for 60 s. */
  list(folderId) {
    GoogleDrive._id(folderId);
    return this._lists.run(folderId, () => this._list(folderId));
  }

  async _list(folderId) {
    const out = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken,files(id,name,mimeType,size,videoMediaMetadata(durationMillis),parents)',
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await this._json(`files?${params}`);
      for (const f of data.files || []) {
        if (!ID_RE.test(String(f.id))) continue;
        const kind = kindOf(f);
        if (!kind) continue;
        const size = Number(f.size) || 0;
        out.push({ id: f.id, name: String(f.name), kind, size, durationMs: Number(f.videoMediaMetadata?.durationMillis) || 0 });
        // Lets a following request for this file skip the metadata call.
        if (kind !== 'folder') this._metas.put(f.id, { id: f.id, name: String(f.name), mimeType: String(f.mimeType || ''), size: Number(f.size), trashed: false });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    const rank = (f) => (f.kind === 'folder' ? 0 : 1);
    out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return out;
  }

  /** Forget cached answers about a folder (after the admin attaches it). */
  forget(folderId) {
    this._lists.delete(folderId);
    this._infos.delete(folderId);
  }

  // ---- the folder-tree check ---------------------------------------------------------------------
  /** Is `id` the room folder or somewhere below it? Walks `parents` upwards (depth <= 32). Cached either way. */
  async inTree(root, id) {
    if (id === root) return true;
    return this._tree.run(`${root}/${id}`, () => this._walk(root, id));
  }

  /** The children of a folder we already know to be inside `root` are inside it too. */
  markInTree(root, ids) {
    for (const id of ids) this._tree.put(`${root}/${id}`, true);
  }

  async _walk(root, start) {
    const via = new Map(); // ancestor -> the node below it on the way from `start`
    const visited = new Set([start]);
    let frontier = [start];
    for (let depth = 0; depth < TREE_DEPTH && frontier.length; depth++) {
      const next = [];
      for (const node of frontier) {
        let ps;
        try {
          ps = await this.parents(node);
        } catch (err) {
          if (err instanceof DriveError && err.status === 404) continue; // not visible to us: a dead end, not an error
          throw err;
        }
        for (const p of ps) {
          if (p === root) {
            for (let n = node; n !== undefined; n = via.get(n)) this._tree.put(`${root}/${n}`, true);
            return true;
          }
          if (!visited.has(p)) {
            visited.add(p);
            via.set(p, node);
            next.push(p);
          }
        }
      }
      frontier = next;
    }
    if (!frontier.length) for (const n of visited) this._tree.put(`${root}/${n}`, false); // searched everything
    return false;
  }

  // ---- media: block cache ------------------------------------------------------------------------
  _cacheGet(key) {
    const b = this.blocks.get(key);
    if (b) {
      this.blocks.delete(key);
      this.blocks.set(key, b); // most recently used
    }
    return b;
  }

  _cacheSet(key, buf) {
    const old = this.blocks.get(key);
    if (old) this.cached -= old.length;
    this.blocks.delete(key);
    this.blocks.set(key, buf);
    this.cached += buf.length;
    while (this.cached > this.cacheBytes && this.blocks.size) {
      const [k, v] = this.blocks.entries().next().value;
      this.blocks.delete(k);
      this.cached -= v.length;
    }
  }

  async _acquire(run) {
    if (this.active < this.maxUpstream) {
      this.active++;
      return;
    }
    await new Promise((resolve, reject) => this.queue.push({ run, resolve, reject }));
  }

  _release() {
    this.active--;
    while (this.queue.length && this.active < this.maxUpstream) {
      const w = this.queue.shift();
      if (w.run.aborted) {
        w.reject(new DriveError('Cancelled', 499, { aborted: true }));
        continue;
      }
      this.active++;
      w.resolve();
    }
  }

  /**
   * Start fetching blocks a..b of a file with one upstream request. A "run" is shared by everyone who
   * wants any of its blocks; `refs` counts them, and the request is cancelled when nobody is left.
   */
  _startRun(fileId, size, a, b) {
    const run = { fileId, a, b, refs: 0, done: false, aborted: false, ctrl: new AbortController() };
    run.promise = this._fetchRun(run, size);
    const finish = () => {
      run.done = true;
      for (let i = run.a; i <= run.b; i++) {
        const k = `${fileId}:${i}`;
        if (this.pending.get(k)?.run === run) this.pending.delete(k);
      }
    };
    run.promise.then((blocks) => {
      blocks.forEach((blk, k) => this._cacheSet(`${fileId}:${a + k}`, blk)); // cached before it stops being pending
      finish();
    }, finish);
    for (let i = a; i <= b; i++) {
      const promise = run.promise.then((blocks) => blocks[i - a]);
      promise.catch(noop); // a block nobody waits for any more must not be an unhandled rejection
      this.pending.set(`${fileId}:${i}`, { run, promise });
    }
    return run;
  }

  _abortRun(run) {
    run.aborted = true;
    run.ctrl.abort();
    for (let i = run.a; i <= run.b; i++) {
      const k = `${run.fileId}:${i}`;
      if (this.pending.get(k)?.run === run) this.pending.delete(k);
    }
  }

  async _fetchRun(run, size) {
    await this._acquire(run);
    try {
      if (run.aborted) throw new DriveError('Cancelled', 499, { aborted: true });
      const start = run.a * BLOCK;
      const end = Math.min(size, (run.b + 1) * BLOCK) - 1; // inclusive
      const data = await this._retrying(() => this._mediaOnce(run.fileId, start, end, size, run.ctrl.signal), run.ctrl.signal);
      const blocks = [];
      for (let o = 0; o < data.length; o += BLOCK) blocks.push(Buffer.from(data.subarray(o, o + BLOCK))); // copies: evicting a block frees its memory
      return blocks;
    } finally {
      this._release();
    }
  }

  /** One upstream Range request for bytes start..end (inclusive). */
  async _mediaOnce(fileId, start, end, size, signal) {
    const len = end - start + 1;
    const url = `${this.apiBase}/drive/v3/files/${GoogleDrive._id(fileId)}?alt=media&supportsAllDrives=true`;
    const res = await this._request(url, { headers: { Range: `bytes=${start}-${end}` }, signal, timeoutMs: 60_000 + len / 20_000 });
    try {
      if (res.status !== 206 && !(res.status === 200 && start === 0 && end === size - 1)) {
        if (res.ok) {
          await res.body?.cancel().catch(noop);
          throw new DriveError('Google Drive ignored the byte range request.', 502, { permanent: true });
        }
        throw await this._errorFrom(res);
      }
      let buf;
      try {
        buf = Buffer.from(await res.arrayBuffer());
      } catch {
        if (signal?.aborted) throw new DriveError('Cancelled', 499, { aborted: true });
        throw new DriveError('Could not reach Google Drive.', 502, { network: true });
      }
      if (buf.length !== len) throw new DriveError('Google Drive sent an incomplete answer.', 502, { retryable: true });
      return buf;
    } finally {
      res.finish?.();
    }
  }

  /** Make sure blocks a..b are cached or being fetched. Returns the runs covering the ones that are not cached. */
  _ensure(fileId, size, a, b) {
    const runs = [];
    const fresh = [];
    let cur = null;
    for (let i = a; i <= b; i++) {
      const key = `${fileId}:${i}`;
      if (this.blocks.has(key)) {
        cur = null;
        continue;
      }
      const p = this.pending.get(key);
      if (p) {
        if (!runs.includes(p.run)) runs.push(p.run);
        cur = null;
        continue;
      }
      if (!cur || cur.b - cur.a + 1 >= MAX_RUN_BLOCKS) {
        cur = { a: i, b: i };
        fresh.push(cur);
      } else cur.b = i;
    }
    for (const r of fresh) runs.push(this._startRun(fileId, size, r.a, r.b));
    return runs;
  }

  /**
   * Bytes start..end (inclusive) of a file, as an async generator of Buffers. Blocks come from the
   * cache, from a download another client already started, or from a new upstream request of up to
   * 8 MiB. Stops upstream work nobody else needs when `signal` aborts or the consumer stops.
   */
  async *read(fileId, size, start, end, signal) {
    const first = Math.floor(start / BLOCK);
    const last = Math.floor(end / BLOCK);
    const held = new Set();
    let requested = first - 1;
    const request = (upto) => {
      const hi = Math.min(last, upto);
      if (hi <= requested) return;
      for (const run of this._ensure(fileId, size, requested + 1, hi)) {
        if (!held.has(run)) {
          held.add(run);
          run.refs++;
        }
      }
      requested = hi;
    };
    let onAbort;
    const aborted = new Promise((resolve) => {
      onAbort = () => resolve(null);
      if (signal) {
        if (signal.aborted) resolve(null);
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      for (let i = first; i <= last; i++) {
        if (signal?.aborted) return;
        if (i > requested - 3) request(requested + MAX_RUN_BLOCKS); // keep about one window ahead
        const key = `${fileId}:${i}`;
        let buf = this._cacheGet(key);
        while (!buf) {
          let p = this.pending.get(key);
          if (!p) {
            // Cached when we asked, evicted since (or its download was cancelled): ask again.
            for (const run of this._ensure(fileId, size, i, i)) {
              if (!held.has(run)) {
                held.add(run);
                run.refs++;
              }
            }
            p = this.pending.get(key);
          }
          buf = p ? await Promise.race([p.promise, aborted]) : this._cacheGet(key);
          if (buf === null) return; // aborted
        }
        const from = i === first ? start - i * BLOCK : 0;
        const to = i === last ? end - i * BLOCK + 1 : buf.length;
        yield buf.subarray(from, to);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      for (const run of held) {
        run.refs--;
        if (run.refs <= 0 && !run.done) this._abortRun(run);
      }
    }
  }
}

module.exports = { ID_RE, FOLDER, DriveError, GoogleDrive, loadServiceAccount, makeAssertion, kindOf, parseRange, MiB, BLOCK };
