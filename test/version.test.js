// The app version is shown in the Settings dialog (public/index.html) and kept in package.json: they must match.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('the version in the Settings dialog matches package.json', () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const shown = html.match(/<span id="app-version"[^>]*>v([^<]+)<\/span>/);
  assert(shown, 'index.html has the #app-version element');
  assert.strictEqual(shown[1], version);
});
