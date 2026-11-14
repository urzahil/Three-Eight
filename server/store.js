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
const DRIVE_KEY_RE = /^[A-Za-z0-9_-]{1,200}$/;
const DRIVE_HELP = 'Paste a Google Drive folder link (https://drive.google.com/drive/folders/...) or a folder ID.';

// Parses a Drive folder link or bare ID. Returns { folderId, resourceKey } or
// null for empty input (meaning "remove"). Throws an Error with a readable message.
function parseDriveFolder(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  let folderId = '';
  let resourceKey = '';
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
    resourceKey = u.searchParams.get('resourcekey') || '';
  } else {
    folderId = text;
  }
  if (!DRIVE_ID_RE.test(folderId)) throw new Error('The folder ID is not valid. ' + DRIVE_HELP);
  if (resourceKey && !DRIVE_KEY_RE.test(resourceKey)) throw new Error('The resource key in the link is not valid.');
  return { folderId, resourceKey };
}

class RoomStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'rooms.json');
    fs.mkdirSync(dataDir, { recursive: true });
    /** @type {Record<string, {passwordHash: string, createdAt: number, updatedAt: number}>} */
    this.rooms = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed.rooms === 'object') this.rooms = parsed.rooms;
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Could not read rooms file:', err.message);
    }
  }

  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, rooms: this.rooms }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
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
      .map(([key, r]) => ({ name: r.name || key, createdAt: r.createdAt, updatedAt: r.updatedAt, hasPassword: !!r.passwordHash, drive: r.drive ? { folderId: r.drive.folderId, resourceKey: r.drive.resourceKey || '' } : null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(name, password) {
    if (!RoomStore.validName(name)) throw new Error('Room names may contain letters, digits, "-" and "_" (max 64), and cannot be a reserved word.');
    if (this.get(name)) throw new Error('A room with that name already exists.');
    const now = Date.now();
    this.rooms[RoomStore.key(name)] = {
      name,
      passwordHash: password ? await hashPassword(password) : '',
      createdAt: now,
      updatedAt: now,
    };
    this._save();
  }

  async setPassword(name, password) {
    const r = this.get(name);
    if (!r) throw new Error('No such room.');
    r.passwordHash = password ? await hashPassword(password) : '';
    r.updatedAt = Date.now();
    this._save();
  }

  setDrive(name, drive) {
    const r = this.get(name);
    if (!r) throw new Error('No such room.');
    if (drive) r.drive = { folderId: drive.folderId, resourceKey: drive.resourceKey || '' };
    else delete r.drive;
    r.updatedAt = Date.now();
    this._save();
  }

  delete(name) {
    if (!this.get(name)) throw new Error('No such room.');
    delete this.rooms[RoomStore.key(name)];
    this._save();
  }

  async check(name, password) {
    const r = this.get(name);
    if (!r) return false;
    if (!r.passwordHash) return true;
    return verifyPassword(password || '', r.passwordHash);
  }
}

module.exports = { RoomStore, parseDriveFolder, hashPassword, verifyPassword };
