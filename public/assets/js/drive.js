// Minimal Google Drive API v3 client for browsing a shared folder and
// streaming files from it. The browser talks to Google directly with an API
// key (the server never fetches or proxies media). Used by the room page and
// the admin page.

import { RemoteFile } from './player/remotefile.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const FOLDER = 'application/vnd.google-apps.folder';
const VIDEO_EXT = new Set(['mkv', 'mp4', 'm4v', 'mov', 'webm', 'avi']);
const SUB_EXT = new Set(['srt', 'vtt', 'ass', 'ssa']);

const ext = (name) => (String(name).match(/\.([A-Za-z0-9]+)$/)?.[1] || '').toLowerCase();

function kindOf(f) {
  if (f.mimeType === FOLDER) return 'folder';
  const e = ext(f.name);
  if (String(f.mimeType).startsWith('video/') || VIDEO_EXT.has(e)) return 'video';
  if (SUB_EXT.has(e)) return 'subtitle';
  return null; // documents, images, shortcuts, ...
}

function checkId(id) {
  if (!ID_RE.test(String(id))) throw new Error('That is not a valid Google Drive ID.');
  return encodeURIComponent(id);
}

function friendly(text, res, reason) {
  return Object.assign(new Error(text), { remote: true, status: res.status, reason });
}

/** Turn an error response from Google into an Error with a message people can act on. */
export async function driveErrorFromResponse(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON (e.g. a media response) */
  }
  const e = body?.error || {};
  const reason = e.errors?.[0]?.reason || e.status || '';
  const message = String(e.message || '');
  const status = res.status;
  if (reason === 'downloadQuotaExceeded') return friendly('Google Drive has temporarily blocked downloads of this file because it was downloaded too often. Try again later or use your own copy.', res, reason);
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'sharingRateLimitExceeded' || status === 429) return friendly('Google Drive is rate limiting requests, try again in a minute.', res, reason);
  if (reason === 'dailyLimitExceeded' || reason === 'quotaExceeded') return friendly('The server\'s Google API key has used up its quota for today. Try again later.', res, reason);
  if (reason === 'keyInvalid' || /api key not valid|api key.*invalid|key expired/i.test(message)) return friendly('The server\'s Google API key is invalid.', res, reason);
  if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(message)) return friendly('The Google Drive API is not enabled for this API key\'s project.', res, reason);
  if (status === 404 || reason === 'notFound') return friendly('The file or folder was not found, or it isn\'t shared with “Anyone with the link”.', res, reason);
  if (status === 401 || status === 403) return friendly('Google Drive denied access. Check that the folder is shared with “Anyone with the link”.', res, reason);
  if (status >= 500) return friendly(`Google Drive had a problem (error ${status}). Try again in a moment.`, res, reason);
  if (status === 416) return friendly('Google Drive could not serve that part of the file.', res, reason);
  return friendly(message ? `Google Drive said: ${message}` : `Google Drive returned an error (${status}).`, res, reason);
}

const KEY_RE = /^[A-Za-z0-9_-]{0,200}$/;

// ISO 639-2 codes that subtitle files use next to the 2-letter ones.
const LANG3 = { en: ['eng'], it: ['ita'], fr: ['fre', 'fra'], de: ['ger', 'deu'], es: ['spa'], pt: ['por'], nl: ['dut', 'nld'], ru: ['rus'], ja: ['jpn'], zh: ['chi', 'zho'], ko: ['kor'], pl: ['pol'], sv: ['swe'], tr: ['tur'], cs: ['cze', 'ces'], da: ['dan'], fi: ['fin'], no: ['nor'], hu: ['hun'], el: ['gre', 'ell'], he: ['heb'], ar: ['ara'], uk: ['ukr'], ro: ['rum', 'ron'] };
const baseName = (name) => String(name).replace(/\.[^./]+$/, '').toLowerCase();

/**
 * Which subtitle file next to a movie should load automatically? Candidates have the movie's
 * base name, optionally followed by a dotted suffix (Arrival.srt, Arrival.en.srt, Arrival.eng.forced.srt).
 * Preference: no suffix, then the browser's language, then not "forced", then by name. Returns a file or null.
 */
export function pickSubtitle(movieName, files, lang = '') {
  const mb = baseName(movieName);
  const l = String(lang).toLowerCase().split(/[-_]/)[0];
  const codes = new Set([l, ...(LANG3[l] || [])].filter(Boolean));
  const cands = [];
  for (const f of files) {
    if (f.kind !== 'subtitle') continue;
    const b = baseName(f.name);
    if (b !== mb && !b.startsWith(mb + '.')) continue;
    const parts = b.slice(mb.length + 1).split(/[._\- ]+/).filter(Boolean);
    cands.push({ f, exact: b === mb, lang: parts.some((p) => codes.has(p)), forced: parts.includes('forced') });
  }
  const rank = (c) => [c.exact ? 0 : 1, c.lang ? 0 : 1, c.forced ? 1 : 0];
  cands.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.f.name.localeCompare(b.f.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return cands.length ? cands[0].f : null;
}

const BLOCKED = 'Google is temporarily blocking downloads from your internet connection (it suspects automated traffic). This usually clears within a few hours. Try another network, turn off a VPN if you use one, or use your own copy of the film.';

export const driveNetworkError = (cause) => Object.assign(new Error('Could not reach Google Drive.'), { remote: true, cause });

export class DriveClient {
  constructor({ apiKey, folderId, resourceKey }) {
    this.apiKey = apiKey;
    this.folderId = folderId;
    this.resourceKey = resourceKey || '';
    this.keys = new Map(); // file id -> resource key (the root's, then those learned from listings)
    if (this.resourceKey) this.keys.set(folderId, this.resourceKey);
    this.cache = new Map(); // folder id -> Promise of its listing
  }

  // Send the key of the item a request is about, plus the root folder's (in
  // case Google wants the parent's too). Sending every key we have learned
  // would grow this header past what Google accepts in big folders of older files.
  _headers(id) {
    const ids = [...new Set([id, this.folderId])].filter((x) => this.keys.has(x));
    return ids.length ? { 'X-Goog-Drive-Resource-Keys': ids.map((x) => `${x}/${this.keys.get(x)}`).join(',') } : {};
  }

  /** Remember the resource key of a folder we did not browse ourselves (it came from another participant). */
  addKey(id, key) {
    if (ID_RE.test(String(id)) && key && KEY_RE.test(String(key)) && !this.keys.has(id)) this.keys.set(id, key);
  }

  _url(id, params) {
    const q = new URLSearchParams({ ...params, supportsAllDrives: 'true', key: this.apiKey });
    return `${API}${id ? '/' + checkId(id) : ''}?${q}`;
  }

  async _getJson(url, id) {
    let res;
    try {
      res = await fetch(url, { headers: this._headers(id) });
    } catch (err) {
      throw driveNetworkError(err);
    }
    if (!res.ok) throw await driveErrorFromResponse(res);
    try {
      return await res.json();
    } catch (err) {
      throw driveNetworkError(err);
    }
  }

  /**
   * A media request failed without any answer (no CORS headers: typically Google's "automated queries"
   * page for a blocked IP address). One cheap JSON call tells the cases apart: if the API still answers,
   * the block is specific to downloads. Returns an Error to show, or null if there is nothing to add.
   */
  async diagnose(id) {
    try {
      await fetch(this._url(id, { fields: 'id' }), { headers: this._headers(id) });
    } catch {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return Object.assign(new Error('You seem to be offline.'), { remote: true });
      return null;
    }
    return Object.assign(new Error(BLOCKED), { remote: true, permanent: true, blocked: true });
  }

  /** Name of a folder (the configured one by default). */
  async folderInfo(id = this.folderId) {
    const f = await this._getJson(this._url(id, { fields: 'id,name,mimeType,resourceKey' }), id);
    if (f.mimeType !== FOLDER) throw new Error('That link points to a file, not a folder.');
    if (f.resourceKey) this.keys.set(f.id, f.resourceKey);
    return { id: f.id, name: f.name };
  }

  /** Folders, videos and subtitle files in a folder: folders first, then by name. Cached per session. */
  async list(folderId = this.folderId) {
    checkId(folderId);
    let p = this.cache.get(folderId);
    if (!p) {
      p = this._list(folderId);
      this.cache.set(folderId, p);
      p.catch(() => this.cache.delete(folderId)); // let the user retry
    }
    return p;
  }

  async _list(folderId) {
    const out = [];
    let pageToken = '';
    do {
      const params = {
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken,files(id,name,mimeType,size,resourceKey,videoMediaMetadata(durationMillis),shortcutDetails)',
        pageSize: '1000',
        includeItemsFromAllDrives: 'true',
      };
      if (pageToken) params.pageToken = pageToken;
      const data = await this._getJson(this._url('', params), folderId);
      for (const f of data.files || []) {
        if (!ID_RE.test(String(f.id))) continue;
        const kind = kindOf(f);
        if (!kind) continue;
        if (f.resourceKey) this.keys.set(f.id, f.resourceKey);
        out.push({
          id: f.id,
          name: String(f.name),
          kind,
          size: Number(f.size) || 0,
          durationMs: Number(f.videoMediaMetadata?.durationMillis) || 0,
          mimeType: f.mimeType || '',
          resourceKey: f.resourceKey || '',
        });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    const rank = (f) => (f.kind === 'folder' ? 0 : 1);
    out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return out;
  }

  /** URL for a <video> element, or null when the file needs a resource-key header (<video> can't send one). */
  mediaUrl(file) {
    if (file.resourceKey || this.keys.has(file.id)) return null;
    return this._url(file.id, { alt: 'media' });
  }

  /** A Blob-like object the player can read with Range requests. */
  remoteFile(file) {
    if (!(file.size > 0)) throw new Error('Google Drive did not report the size of this file.');
    if (file.resourceKey) this.keys.set(file.id, file.resourceKey);
    const url = this._url(file.id, { alt: 'media' });
    const rf = new RemoteFile({
      name: file.name,
      size: file.size,
      nativeUrl: this.mediaUrl(file),
      url,
      headers: () => this._headers(file.id),
      explain: driveErrorFromResponse,
      networkError: driveNetworkError,
      diagnose: () => this.diagnose(file.id),
    });
    rf.drive = { id: file.id, resourceKey: file.resourceKey || '', folder: file.folder || '', folderKey: file.folderKey || '' };
    return rf;
  }

  /** Download a small file (subtitles) completely. */
  async downloadText(file, maxBytes = 5 * 1024 * 1024) {
    if (file.size > maxBytes) throw new Error('That file is too large.');
    let res;
    try {
      res = await fetch(this._url(file.id, { alt: 'media' }), { headers: this._headers(file.id) });
    } catch (err) {
      throw (await this.diagnose(file.id)) || driveNetworkError(err);
    }
    if (!res.ok) throw await driveErrorFromResponse(res);
    let buf;
    try {
      buf = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      throw driveNetworkError(err);
    }
    if (buf.length > maxBytes) throw new Error('That file is too large.');
    return buf;
  }
}
