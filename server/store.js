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
  if (typeof password !== 'string' || typeof stored !== 'string' || !stored) return false;
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false; // damaged by hand-editing: not a match, not a crash
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const DRIVE_HELP = 'Paste a Google Drive folder link (https://drive.google.com/drive/folders/...) or a folder ID.';

// Parses a Drive folder link or bare ID. Returns { folderId } or null for empty
// input (meaning "remove"). Throws an Error with a readable message. A
// `resourcekey` in a link is accepted and ignored: a folder shared directly
// with the service account needs none.
function parseDriveFolder(input) {
  if (input != null && typeof input !== 'string') throw new Error('The folder link must be text. ' + DRIVE_HELP);
  const text = (input ?? '').trim();
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

// Errors the admin can act on (bad name, no such room): safe to show, with the HTTP status to answer with. Anything else
// is an internal failure.
class RoomError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const HASH_RE = /^scrypt\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/;
// Stands in for a password hash that is damaged in rooms.json: no password matches it, so the room stays closed
// (an unreadable hash must never turn into "no password") until an admin sets a new one.
const BROKEN_HASH = 'invalid';

/**
 * One room record from rooms.json, checked and normalised, or null if it cannot be used (reported on stderr).
 * The file may have been edited by hand or partly damaged: nothing in it is trusted to have the right shape.
 */
function loadRoom(key, room) {
  if (!room || typeof room !== 'object' || Array.isArray(room)) {
    console.error(`rooms.json: the entry "${key}" is not a room record; it is ignored.`);
    return null;
  }
  const name = typeof room.name === 'string' && room.name ? room.name : key;
  if (!RoomStore.validName(name)) {
    console.error(`rooms.json: "${name}" is not a valid room name; the room is ignored.`);
    return null;
  }
  // Every version of the store writes a string here ('' for an open room): anything else is damage.
  let passwordHash = room.passwordHash;
  if (passwordHash !== '' && (typeof passwordHash !== 'string' || !HASH_RE.test(passwordHash))) {
    console.error(`rooms.json: the password of room "${name}" is damaged. Nobody can join it until an admin sets a new password.`);
    passwordHash = BROKEN_HASH;
  }
  const r = {
    name,
    passwordHash,
    createdAt: Number.isFinite(room.createdAt) ? room.createdAt : 0,
    updatedAt: Number.isFinite(room.updatedAt) ? room.updatedAt : 0,
  };
  if (room.drive != null) {
    if (typeof room.drive === 'object' && DRIVE_ID_RE.test(String(room.drive.folderId))) r.drive = { folderId: room.drive.folderId };
    else console.error(`rooms.json: the Google Drive folder of room "${name}" is not valid; it is removed.`);
  }
  return r;
}

/** Flush a directory entry (a rename) to disk. Not every system can open a directory for that: then the rename has to do. */
function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* e.g. Windows */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

class RoomStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'rooms.json');
    // The version before the last save. If rooms.json is ever unreadable (a disk that lost its last writes), the
    // server starts from it instead of with no rooms.
    this.backup = this.file + '.bak';
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
      const rooms = this._parse(text, this.file);
      if (rooms) this.rooms = rooms;
      else {
        // Keep the unreadable file for the operator instead of overwriting it with the next save.
        const aside = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, aside);
        const saved = this._readBackup();
        if (saved) {
          console.error(`${this.file} could not be parsed. It was moved to ${aside}; the server starts from ${this.backup} (the version before the last change).`);
          this.rooms = saved;
          this._save(); // rooms.json again, so the next start does not depend on the backup
        } else {
          console.error(`${this.file} could not be parsed. It was moved to ${aside} and the server starts with no rooms.`);
        }
      }
    }
  }

  /** The rooms in the text of a rooms.json (checked one by one, see loadRoom), or null when it is not one. */
  _parse(text, file) {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch { /* null below */ }
    if (!parsed || typeof parsed.rooms !== 'object' || parsed.rooms === null || Array.isArray(parsed.rooms)) return null;
    const rooms = Object.create(null);
    for (const [key, room] of Object.entries(parsed.rooms)) {
      const r = loadRoom(key, room);
      if (!r) continue;
      const k = RoomStore.key(r.name);
      if (rooms[k]) {
        console.error(`${file}: room "${r.name}" appears twice; the first one is kept.`);
        continue;
      }
      rooms[k] = r;
    }
    return rooms;
  }

  _readBackup() {
    try {
      return this._parse(fs.readFileSync(this.backup, 'utf8'), this.backup);
    } catch {
      return null;
    }
  }

  // Writes `rooms` (default: the current state) to disk: a new file, flushed, then renamed over the old one, so a crash
  // or power cut leaves either the old version or the new one, never an empty or half-written file. The old version
  // is kept as rooms.json.bak.
  _save(rooms = this.rooms) {
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, rooms }, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.copyFileSync(this.file, this.backup);
      fs.chmodSync(this.backup, 0o600);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Could not keep a backup of ${this.file}: ${err.message}`);
    }
    fs.renameSync(tmp, this.file);
    fsyncDir(path.dirname(this.file));
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
    if (typeof password !== 'string') throw new RoomError('The password must be text.');
    const passwordHash = password ? await hashPassword(password) : '';
    // Hashing takes a while: another create for the same name may have finished meanwhile.
    if (this.get(name)) throw new RoomError('A room with that name already exists.');
    const now = Date.now();
    const next = this._draft();
    next[RoomStore.key(name)] = { name, passwordHash, createdAt: now, updatedAt: now };
    this._commit(next);
  }

  async setPassword(name, password) {
    if (!this.get(name)) throw new RoomError('No such room.', 404);
    if (typeof password !== 'string') throw new RoomError('The password must be text.');
    const passwordHash = password ? await hashPassword(password) : '';
    // The room may have been deleted while hashing.
    if (!this.get(name)) throw new RoomError('No such room.', 404);
    const next = this._draft();
    const r = next[RoomStore.key(name)];
    r.passwordHash = passwordHash;
    r.updatedAt = Date.now();
    this._commit(next);
  }

  setDrive(name, drive) {
    if (!this.get(name)) throw new RoomError('No such room.', 404);
    const next = this._draft();
    const r = next[RoomStore.key(name)];
    if (drive) r.drive = { folderId: drive.folderId };
    else delete r.drive;
    r.updatedAt = Date.now();
    this._commit(next);
  }

  delete(name) {
    if (!this.get(name)) throw new RoomError('No such room.', 404);
    const next = this._draft();
    delete next[RoomStore.key(name)];
    this._commit(next);
  }

  async check(name, password) {
    const r = this.get(name);
    if (!r) return false;
    if (r.passwordHash === '') return true; // only a deliberately empty password opens the room

    return verifyPassword(typeof password === 'string' ? password : '', r.passwordHash);
  }
}

module.exports = { RoomStore, RoomError, parseDriveFolder, hashPassword, verifyPassword };
