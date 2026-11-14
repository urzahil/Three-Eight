// A fake Google for the tests: the OAuth token endpoint (it verifies the service account's JWT with the
// public key) and the parts of the Drive API v3 that the server uses (files.list, files.get metadata,
// files.get alt=media with Range). Every request is logged, and failures can be switched on.
//
//   const g = await startFakeGoogle();
//   g.addFolder(id, name, parentId); g.addFile(id, name, parentId, buffer, mimeType);
//   // g.url is the API base (GOOGLE_API_BASE); g.writeAccount(dir) writes the service account JSON
//   // (GOOGLE_SERVICE_ACCOUNT) whose token_uri is this server's /token.
//
// Failure modes (properties of g.mode): quotaIds (Set of file ids whose media gets a 403
// downloadQuotaExceeded), failMedia (number of next media requests that answer 500), slowMs (delay
// of media responses), tokenTtl (expires_in of new tokens, seconds), pageLimit (items per list page).
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FOLDER = 'application/vnd.google-apps.folder';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startFakeGoogle() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const email = 'movies@fake-project.iam.gserviceaccount.com';
  const files = new Map(); // id -> { id, name, mimeType, parents, data? }
  const tokens = new Map(); // access token -> expiry ms
  const log = []; // { type: 'token'|'list'|'meta'|'media', ... }
  const mode = { quotaIds: new Set(), failMedia: 0, slowMs: 0, tokenTtl: 3600, pageLimit: 1000 };
  let issued = 0;
  let url = '';

  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  const gerr = (res, status, reason, message) => sendJson(res, status, { error: { code: status, message, errors: [{ reason, message }] } });

  function verifyAssertion(jwt) {
    const [h, c, s] = String(jwt).split('.');
    if (!h || !c || !s) return 'malformed assertion';
    const head = JSON.parse(Buffer.from(h, 'base64url'));
    const claims = JSON.parse(Buffer.from(c, 'base64url'));
    if (head.alg !== 'RS256') return 'alg is not RS256';
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'))) return 'Invalid JWT Signature.';
    if (claims.iss !== email) return 'wrong iss';
    if (claims.scope !== SCOPE) return 'wrong scope';
    if (claims.aud !== `${url}/token`) return 'wrong aud';
    if (claims.exp - claims.iat !== 3600) return 'exp must be iat + 3600';
    const now = Date.now() / 1000;
    if (Math.abs(claims.iat - now) > 120 || claims.exp < now) return 'stale assertion';
    return null;
  }

  const authorized = (req) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    const exp = m && tokens.get(m[1]);
    return !!exp && exp > Date.now();
  };

  const toApi = (f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    parents: f.parents,
    trashed: false,
    ...(f.data ? { size: String(f.data.length) } : {}),
    ...(f.durationMillis ? { videoMediaMetadata: { durationMillis: String(f.durationMillis) } } : {}),
  });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname === '/token' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
          log.push({ type: 'token', ok: false });
          return sendJson(res, 400, { error: 'unsupported_grant_type' });
        }
        const problem = verifyAssertion(form.get('assertion'));
        log.push({ type: 'token', ok: !problem });
        if (problem) return sendJson(res, 400, { error: 'invalid_grant', error_description: problem });
        const token = `ya29.fake-${++issued}`;
        tokens.set(token, Date.now() + mode.tokenTtl * 1000);
        return sendJson(res, 200, { access_token: token, expires_in: mode.tokenTtl, token_type: 'Bearer' });
      }

      const m = u.pathname.match(/^\/drive\/v3\/files(?:\/([^/]+))?$/);
      if (!m) return gerr(res, 404, 'notFound', 'Not found');
      if (!authorized(req)) return gerr(res, 401, 'authError', 'Invalid Credentials');
      const bearer = req.headers.authorization.slice(7);

      if (!m[1]) {
        const parent = /^'([^']+)' in parents and trashed=false$/.exec(u.searchParams.get('q') || '')?.[1];
        log.push({ type: 'list', parent, pageToken: u.searchParams.get('pageToken') || '', bearer });
        if (!parent || files.get(parent)?.mimeType !== FOLDER) return gerr(res, 404, 'notFound', 'File not found: ' + parent);
        if (u.searchParams.get('supportsAllDrives') !== 'true' || u.searchParams.get('includeItemsFromAllDrives') !== 'true') return gerr(res, 400, 'badRequest', 'shared drive flags missing');
        const kids = [...files.values()].filter((f) => f.parents.includes(parent));
        const size = Math.min(Number(u.searchParams.get('pageSize')) || 1000, mode.pageLimit);
        const page = Number(u.searchParams.get('pageToken') || 0);
        const slice = kids.slice(page * size, (page + 1) * size);
        return sendJson(res, 200, { files: slice.map(toApi), ...((page + 1) * size < kids.length ? { nextPageToken: String(page + 1) } : {}) });
      }

      const f = files.get(m[1]);
      if (u.searchParams.get('alt') !== 'media') {
        log.push({ type: 'meta', id: m[1], fields: u.searchParams.get('fields'), bearer });
        if (!f) return gerr(res, 404, 'notFound', 'File not found: ' + m[1]);
        const full = toApi(f);
        const wanted = String(u.searchParams.get('fields') || '').split(',').filter(Boolean);
        return sendJson(res, 200, wanted.length ? Object.fromEntries(Object.entries(full).filter(([k]) => wanted.includes(k))) : full);
      }

      // ---- media
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const entry = { type: 'media', id: m[1], range: range ? [Number(range[1]), range[2] ? Number(range[2]) : null] : null, auth: req.headers.authorization, bearer };
      log.push(entry);
      res.on('close', () => { if (!res.writableEnded) entry.aborted = true; }); // the caller gave up
      if (!f || !f.data) return gerr(res, 404, 'notFound', 'File not found: ' + m[1]);
      if (mode.slowMs) await sleep(mode.slowMs);
      if (mode.quotaIds.has(f.id)) {
        entry.status = 403;
        return gerr(res, 403, 'downloadQuotaExceeded', 'The download quota for this file has been exceeded.');
      }
      if (mode.failMedia > 0) {
        mode.failMedia--;
        entry.status = 500;
        return gerr(res, 500, 'backendError', 'Internal error');
      }
      const data = f.data;
      if (!range) {
        entry.status = 200;
        res.writeHead(200, { 'Content-Type': f.mimeType, 'Content-Length': data.length, 'Accept-Ranges': 'bytes' });
        return res.end(data);
      }
      const a = Number(range[1]);
      const b = Math.min(data.length - 1, range[2] ? Number(range[2]) : data.length - 1);
      if (a >= data.length) {
        entry.status = 416;
        return gerr(res, 416, 'requestedRangeNotSatisfiable', 'Range not satisfiable');
      }
      entry.status = 206;
      entry.end = b;
      res.writeHead(206, { 'Content-Type': f.mimeType, 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Accept-Ranges': 'bytes' });
      return res.end(data.subarray(a, b + 1));
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: { code: 500, message: String(err.message) } });
      else res.destroy();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    email,
    log,
    mode,
    files,
    addFolder(id, name, parent) {
      files.set(id, { id, name, mimeType: FOLDER, parents: parent ? [parent] : [] });
    },
    addFile(id, name, parent, data, mimeType = 'application/octet-stream', durationMillis = 0) {
      files.set(id, { id, name, mimeType, parents: parent ? [parent] : [], data, durationMillis });
    },
    /** Requests of one type, optionally for one file. */
    entries(type, id) {
      return log.filter((e) => e.type === type && (id === undefined || e.id === id));
    },
    /** Make every access token issued so far invalid (Google revoked them). */
    revokeTokens() {
      tokens.clear();
    },
    /** Writes a service account key file for this fake; returns its path. */
    writeAccount(dir, { badKey = false } = {}) {
      const file = path.join(dir, 'google-service-account.json');
      const pem = badKey ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : privateKey;
      fs.writeFileSync(file, JSON.stringify({
        type: 'service_account',
        project_id: 'fake-project',
        private_key_id: 'abc123',
        private_key: pem.export({ type: 'pkcs8', format: 'pem' }),
        client_email: email,
        token_uri: `${url}/token`,
      }), { mode: 0o600 });
      return file;
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startFakeGoogle, FOLDER };
