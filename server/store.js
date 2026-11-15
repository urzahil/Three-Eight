// Persistent room registry (JSON file) with scrypt-hashed passwords.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Names that would collide with the server's own routes.
const RESERVED = new Set(['admin', 'assets', 'api', 'ws', 'healthz', 'favicon.ico', 'robots.txt']);

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(String(password), Buffer.from(saltB64, 'base64'));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const DRIVE_HELP = 'Paste a Google Drive folder link (https://drive.google.com/drive/folders/...) or a folder ID.';

// Parses a Drive folder link or bare ID. Returns { folderId } or null for empty
// input (meaning "remove"). Throws an Error with a readable message. A
// `resourcekey` in a link is accepted and ignored: a folder shared directly
// with the service account needs none.
function parseDriveFolder(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  let folderId = '';
  if (/^https?:\/\//i.test(text)) {
    let u;
    try {
      u = new URL(text);
    } catch {
      throw new Error('That does not look like a valid link. ' + DRIVE_HELP);
    }
    if (u.hostname.toLowerCase() !== 'drive.google.com') throw new Error('Only drive.google.com links are supported. ' + DRIVE_HELP);
    const m = u.pathname.match(/^(?:\/u\/\d+)?\/drive(?:\/u\/\d+)?\/folders\/([^/]+)\/?$/);
    if (m) folderId = m[1];
    else if (u.pathname === '/open' || u.pathname === '/open/') folderId = u.searchParams.get('id') || '';
    else if (/\/file\/d\//.test(u.pathname)) throw new Error('That is a link to a file, not a folder. ' + DRIVE_HELP);
    else throw new Error('That is not a folder link. ' + DRIVE_HELP);
  } else {
    folderId = text;
  }
  if (!DRIVE_ID_RE.test(folderId)) throw new Error('The folder ID is not valid. ' + DRIVE_HELP);
  return { folderId };
}

// Errors the admin can act on (bad name, no such room): safe to show. Anything else is an internal failure.
class RoomError extends Error {}

class RoomStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'rooms.json');
    fs.mkdirSync(dataDir, { recursive: true });
    // No prototype: lookups like get('constructor') or get('__proto__') must not find inherited properties.
    /** @type {Record<string, {passwordHash: string, createdAt: number, updatedAt: number}>} */
    this.rooms = Object.create(null);
    let text = null;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      // A missing file is normal (first start). Anything else (e.g. EACCES) must not lead to the file being overwritten.
      if (err.code !== 'ENOENT') throw new Error(`Cannot read ${this.file}: ${err.message}. Fix the file's permissions or move it away, then start again.`);
    }
    if (text !== null) {
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch { /* handled below */ }
      if (parsed && typeof parsed.rooms === 'object' && parsed.rooms !== null && !Array.isArray(parsed.rooms)) {
        for (const [key, room] of Object.entries(parsed.rooms)) if (room && typeof room === 'object') this.rooms[key] = room;
      } else {
        // Keep the unreadable file for the operator instead of overwriting it with the next save.
        const aside = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, aside);
        console.error(`${this.file} could not be parsed. It was moved to ${aside} and the server starts with no rooms.`);
      }
    }
  }

  // Writes `rooms` (default: the current state) to disk.
  _save(rooms = this.rooms) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, rooms }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // A copy of the registry to change. Nothing is visible until _commit() has saved it, so a failed write leaves the store as it was.
  _draft() {
    const next = Object.create(null);
    for (const [key, room] of Object.entries(this.rooms)) next[key] = { ...room };
    return next;
  }

  _commit(next) {
    this._save(next);
    this.rooms = next;
  }

  static key(name) {
    return String(name).toLowerCase();
  }

  static validName(name) {
    return typeof name === 'string' && ROOM_NAME_RE.test(name) && !RESERVED.has(name.toLowerCase());
  }

  get(name) {
    if (typeof name !== 'string') return null;
    const r = this.rooms[RoomStore.key(name)];
    return r || null;
  }

  list() {
    return Object.entries(this.rooms)
      .map(([key, r]) => ({ name: r.name || key, createdAt: r.createdAt, updatedAt: r.updatedAt, hasPassword: !!r.passwordHash, drive: r.drive ? { folderId: r.drive.folderId } : null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(name, password) {
    if (!RoomStore.validName(name)) throw new RoomError('Room names may contain letters, digits, "-" and "_" (max 64), and cannot be a reserved word.');
    if (this.get(name)) throw new RoomError('A room with that name already exists.');
    const passwordHash = password ? await hashPassword(password) : '';
    // Hashing takes a while: another create for the same name may have finished meanwhile.
    if (this.get(name)) throw new RoomError('A room with that name already exists.');
    const now = Date.now();
    const next = this._draft();
    next[RoomStore.key(name)] = { name, passwordHash, createdAt: now, updatedAt: now };
    this._commit(next);
  }

  async setPassword(name, password) {
    if (!this.get(name)) throw new RoomError('No such room.');
    const passwordHash = password ? await hashPassword(password) : '';
    // The room may have been deleted while hashing.
    if (!this.get(name)) throw new RoomError('No such room.');
    const next = this._draft();
    const r = next[RoomStore.key(name)];
    r.passwordHash = passwordHash;
    r.updatedAt = Date.now();
    this._commit(next);
  }

  setDrive(name, drive) {
    if (!this.get(name)) throw new RoomError('No such room.');
    const next = this._draft();
    const r = next[RoomStore.key(name)];
    if (drive) r.drive = { folderId: drive.folderId };
    else delete r.drive;
    r.updatedAt = Date.now();
    this._commit(next);
  }

  delete(name) {
    if (!this.get(name)) throw new RoomError('No such room.');
    const next = this._draft();
    delete next[RoomStore.key(name)];
    this._commit(next);
  }

  async check(name, password) {
    const r = this.get(name);
    if (!r) return false;
    if (!r.passwordHash) return true;
    return verifyPassword(password || '', r.passwordHash);
  }
}

module.exports = { RoomStore, RoomError, parseDriveFolder, hashPassword, verifyPassword };
