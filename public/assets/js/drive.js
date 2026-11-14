// The room's Google Drive folder, as seen from the browser: a thin client for
// our own server (the server reads Drive as a service account; the browser
// never contacts Google). Requests carry the room token that the server sent
// in the welcome message. Used by the room page.

import { RemoteFile } from './player/remotefile.js';

const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const NETWORK_MESSAGE = 'Could not reach the server.';

function checkId(id) {
  if (!ID_RE.test(String(id))) throw new Error('That is not a valid Google Drive ID.');
  return encodeURIComponent(id);
}

/** An Error for a failed response: the server answers with JSON { error } (and `permanent: true` when retrying is pointless). */
async function serverError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const message = typeof body?.error === 'string' && body.error ? body.error : `The server answered with an error (${res.status}).`;
  return Object.assign(new Error(message), { remote: true, status: res.status, permanent: body?.permanent === true ? true : undefined });
}

export const networkError = (cause) => Object.assign(new Error(NETWORK_MESSAGE), { remote: true, cause });

// ISO 639-2 codes that subtitle files use next to the 2-letter ones.
const LANG3 = { en: ['eng'], it: ['ita'], fr: ['fre', 'fra'], de: ['ger', 'deu'], es: ['spa'], pt: ['por'], nl: ['dut', 'nld'], ru: ['rus'], ja: ['jpn'], zh: ['chi', 'zho'], ko: ['kor'], pl: ['pol'], sv: ['swe'], tr: ['tur'], cs: ['cze', 'ces'], da: ['dan'], fi: ['fin'], no: ['nor'], hu: ['hun'], el: ['gre', 'ell'], he: ['heb'], ar: ['ara'], uk: ['ukr'], ro: ['rum', 'ron'] };
const baseName = (name) => String(name).replace(/\.[^./]+$/, '').toLowerCase();

const LANG_NAMES = { en: 'english', it: 'italian', fr: 'french', de: 'german', es: 'spanish', pt: 'portuguese', nl: 'dutch', ru: 'russian', ja: 'japanese', zh: 'chinese', ko: 'korean', pl: 'polish', sv: 'swedish', tr: 'turkish', cs: 'czech', da: 'danish', fi: 'finnish', no: 'norwegian', hu: 'hungarian', el: 'greek', he: 'hebrew', ar: 'arabic', uk: 'ukrainian', ro: 'romanian' };
// Words that may follow a movie's name in a subtitle file's name without making it another film's file.
const TAGS = new Set(['forced', 'sdh', 'hi', 'cc', 'full', 'default', ...Object.keys(LANG3), ...Object.values(LANG3).flat(), ...Object.values(LANG_NAMES)]);
const TOKEN_SPLIT = /[\s_\-.()[\]]+/;

/** The part of a subtitle's base name after the movie's, as tokens; null if it is not this movie's subtitle. */
function subtitleSuffix(movieName, subName) {
  const mb = baseName(movieName);
  const sb = baseName(subName);
  if (sb === mb) return [];
  if (!sb.startsWith(mb)) return null;
  const rest = sb.slice(mb.length);
  const tokens = rest.split(TOKEN_SPLIT).filter(Boolean);
  if (rest[0] === '.') return tokens; // Movie.en.srt, Movie.2016.srt: whatever follows the dot
  // Movie ENG.srt, Movie_ita.srt, Movie - English.srt, Movie (SDH).srt: only known tags, never more words
  // (that would be "Alien 3" for "Alien", or "Aliens" for "Alien").
  if (!/^[\s_\-([]/.test(rest) || !tokens.length || !tokens.every((t) => TAGS.has(t))) return null;
  return tokens;
}

/** Is this subtitle file for this movie (rather than for another film in the same folder)? */
export function subtitleMatches(movieName, subName) {
  return subtitleSuffix(movieName, subName) !== null;
}

/**
 * Which subtitle file next to a movie should load automatically? See subtitleMatches for the names that
 * count. Preference: no suffix, then the browser's language, then not "forced", then by name.
 * Returns a file or null.
 */
export function pickSubtitle(movieName, files, lang = '') {
  const l = String(lang).toLowerCase().split(/[-_]/)[0];
  const codes = new Set([l, LANG_NAMES[l], ...(LANG3[l] || [])].filter(Boolean));
  const cands = [];
  for (const f of files) {
    if (f.kind !== 'subtitle') continue;
    const parts = subtitleSuffix(movieName, f.name);
    if (!parts) continue;
    cands.push({ f, exact: !parts.length, lang: parts.some((p) => codes.has(p)), forced: parts.includes('forced') });
  }
  const rank = (c) => [c.exact ? 0 : 1, c.lang ? 0 : 1, c.forced ? 1 : 0];
  cands.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.f.name.localeCompare(b.f.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return cands.length ? cands[0].f : null;
}

export class DriveClient {
  /** @param {{room: string, token: string, folder: string}} o  the room, its Drive token and the root folder's ID */
  constructor({ room, token, folder }) {
    this.room = room;
    this.token = token;
    this.folder = folder;
    this.cache = new Map(); // folder id ('root' for the room's folder) -> Promise of its listing
  }

  /** A reconnect brings a fresh token: files already open pick it up on their next request. */
  setToken(token) {
    this.token = token;
  }

  get base() {
    return `/api/rooms/${encodeURIComponent(this.room)}/drive`;
  }

  _headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  async _getJson(path) {
    let res;
    try {
      res = await fetch(this.base + path, { headers: this._headers(), cache: 'no-store' });
    } catch (err) {
      throw networkError(err);
    }
    if (!res.ok) throw await serverError(res);
    try {
      return await res.json();
    } catch (err) {
      throw networkError(err);
    }
  }

  _folder(folderId) {
    const id = !folderId || folderId === this.folder ? 'root' : folderId;
    if (id !== 'root') checkId(id);
    let p = this.cache.get(id);
    if (!p) {
      p = this._getJson(`/folders/${id}`);
      this.cache.set(id, p);
      p.catch(() => this.cache.delete(id)); // let the user retry
    }
    return p;
  }

  /** Folders, videos and subtitle files in a folder ({ id, name, kind, size, durationMs }): folders first, then by name. Cached per session. */
  async list(folderId = 'root') {
    return (await this._folder(folderId)).items;
  }

  /** Name of the room's folder. */
  async folderInfo() {
    const f = await this._folder('root');
    return { id: f.id, name: f.name };
  }

  /** A Blob-like object the player can read with Range requests. */
  remoteFile(file) {
    if (!(file.size > 0)) throw new Error('The size of this file is not known.');
    const url = `${this.base}/files/${checkId(file.id)}`;
    const rf = new RemoteFile({
      name: file.name,
      size: file.size,
      nativeUrl: `${url}?t=${encodeURIComponent(this.token)}`, // a <video> element cannot send headers
      url,
      headers: () => this._headers(), // read per request, so a refreshed token is used
      explain: serverError,
      networkError,
      retries: 2,
    });
    rf.drive = { id: file.id, folder: file.folder || '' };
    return rf;
  }

  /** Download a small file (subtitles) completely. */
  async downloadText(file, maxBytes = 5 * 1024 * 1024) {
    if (file.size > maxBytes) throw new Error('That file is too large.');
    let res;
    try {
      res = await fetch(`${this.base}/files/${checkId(file.id)}`, { headers: this._headers() });
    } catch (err) {
      throw networkError(err);
    }
    if (!res.ok) throw await serverError(res);
    let buf;
    try {
      buf = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      throw networkError(err);
    }
    if (buf.length > maxBytes) throw new Error('That file is too large.');
    return buf;
  }
}
