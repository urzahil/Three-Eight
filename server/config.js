// Startup settings read from the environment. A value that is set but unusable stops the server with a message that
// names the setting, instead of quietly turning into NaN or a default (e.g. MAX_ROOM_SIZE=twelve used to lift the
// room limit altogether, since `size >= NaN` is never true).
'use strict';

class ConfigError extends Error {}

/** The value for an error message: settings parsed here are not secret, but keep a pasted blob short. */
const shown = (raw) => (raw.length > 40 ? `${raw.slice(0, 40)}…` : raw);

/** A whole number in [min, max], or `def` when the variable is unset or empty. */
function intSetting(env, name, def, min, max) {
  const raw = String(env[name] ?? '').trim();
  if (raw === '') return def;
  if (!/^\d{1,9}$/.test(raw)) throw new ConfigError(`${name}=${shown(raw)} is not a whole number (expected ${min} to ${max}).`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name}=${raw} is out of range (expected ${min} to ${max}).`);
  return n;
}

/** Number of trusted reverse proxies: '' / false / no / 0 = none, true / yes / 1 = one, a number = that many. */
function trustedHops(env) {
  const raw = String(env.TRUST_PROXY ?? '').trim();
  if (raw === '' || /^(false|no)$/i.test(raw)) return 0;
  if (/^(true|yes)$/i.test(raw)) return 1;
  if (/^\d{1,2}$/.test(raw)) return Number(raw);
  throw new ConfigError(`TRUST_PROXY=${shown(raw)} is not valid (expected true, false or a number of proxies, e.g. 2).`);
}

/** Memory for the Drive cache in MB: a non-negative number, or `def` when unset. (The minimum is applied by the caller, with a warning.) */
function driveCacheMb(env, def) {
  const raw = String(env.DRIVE_CACHE_MB ?? '').trim();
  if (raw === '') return def;
  const mb = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(mb) || mb > 1024 * 1024) throw new ConfigError(`DRIVE_CACHE_MB=${shown(raw)} is not a number of megabytes (e.g. 256).`);
  return mb;
}

// ---- STUN / TURN ------------------------------------------------------------------------------------------------
// Browsers refuse to create any RTCPeerConnection when one of its ICE servers is malformed (a URL without its
// "stun:" scheme, or a TURN server without credentials), so one typo here would break every call in every room.
// Hence: checked at startup, like the other settings.
const DEFAULT_STUN = 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478';
// RFC 7064 / 7065: scheme:host[:port], TURN also ?transport=udp|tcp. Host: a name, an IPv4 address or [IPv6].
const ICE_HOST = String.raw`(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])`;
const STUN_URL_RE = new RegExp(String.raw`^stuns?:${ICE_HOST}(?::(\d{1,5}))?$`);
const TURN_URL_RE = new RegExp(String.raw`^turns?:${ICE_HOST}(?::(\d{1,5}))?(?:\?transport=(?:udp|tcp))?$`);

/** A comma-separated list of ICE server URLs, each checked against `re` (with a port in 1..65535, if any). */
function iceUrls(raw, name, re, example) {
  const urls = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  for (const url of urls) {
    const m = re.exec(url);
    const port = m && m[1] !== undefined ? Number(m[1]) : 1;
    if (!m || port < 1 || port > 65535) throw new ConfigError(`${name}: "${shown(url)}" is not a valid URL (expected e.g. ${example}).`);
  }
  return urls;
}

/**
 * STUN and TURN settings: { stun: [urls], turn: [urls], secret, username, password }. STUN_URLS unset means the
 * built-in servers, set but empty means none. TURN_URLS needs either TURN_SECRET (coturn use-auth-secret) or both
 * TURN_USERNAME and TURN_PASSWORD.
 */
function iceSettings(env) {
  const stun = iceUrls(env.STUN_URLS ?? DEFAULT_STUN, 'STUN_URLS', STUN_URL_RE, 'stun:stun.example.com:3478');
  const turn = iceUrls(env.TURN_URLS ?? '', 'TURN_URLS', TURN_URL_RE, 'turn:turn.example.com:3478?transport=udp');
  const secret = String(env.TURN_SECRET ?? '');
  const username = String(env.TURN_USERNAME ?? '');
  const password = String(env.TURN_PASSWORD ?? '');
  if (turn.length && !secret && (!username || !password)) {
    const missing = username || password ? (username ? 'TURN_PASSWORD' : 'TURN_USERNAME') : 'TURN_SECRET (or TURN_USERNAME and TURN_PASSWORD)';
    throw new ConfigError(`TURN_URLS is set but ${missing} is not. Browsers refuse a TURN server without credentials, which would break every call.`);
  }
  return { stun, turn, secret, username, password };
}

const MIN_ADMIN_PASSWORD = 9;
// Example values from .env.example and the documentation: a copy that was never edited must not become the password.
const EXAMPLE_PASSWORDS = new Set([
  'change-me-to-something-long',
  'change-me',
  'replace-with-a-long-random-password',
  'replace-with-a-strong-password',
]);

/**
 * The admin password: '' when ADMIN_PASSWORD is unset or empty (the caller then generates one). A password that is
 * still an example value from the documentation, or shorter than MIN_ADMIN_PASSWORD characters, stops the server: the
 * admin page is on the internet, guarded only by this password and a per-address attempt limit. The message never
 * contains the value.
 */
function adminPassword(env) {
  const raw = String(env.ADMIN_PASSWORD ?? '');
  if (raw === '') return '';
  if (!raw.trim()) throw new ConfigError(`ADMIN_PASSWORD contains only spaces. Set a real password (at least ${MIN_ADMIN_PASSWORD} characters).`);
  if (EXAMPLE_PASSWORDS.has(raw.trim().toLowerCase())) {
    throw new ConfigError(`ADMIN_PASSWORD is still the example value from the documentation. Set a password of your own (at least ${MIN_ADMIN_PASSWORD} characters).`);
  }
  if (raw.length < MIN_ADMIN_PASSWORD) {
    throw new ConfigError(`ADMIN_PASSWORD is too short (${raw.length} characters). Use at least ${MIN_ADMIN_PASSWORD}.`);
  }
  return raw;
}

module.exports = { ConfigError, intSetting, trustedHops, driveCacheMb, adminPassword, iceSettings, MIN_ADMIN_PASSWORD };
