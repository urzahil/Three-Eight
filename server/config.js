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

module.exports = { ConfigError, intSetting, trustedHops, driveCacheMb, adminPassword, MIN_ADMIN_PASSWORD };
