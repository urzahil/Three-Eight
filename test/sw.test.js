'use strict';
// The service worker's activation clears only Three-Eight's own outdated caches, not other apps' on the same origin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('activate deletes old three-eight caches and leaves other caches alone', async () => {
  const listeners = {};
  const store = new Set(['three-eight-shell-v1', 'three-eight-shell-v2', 'other-app-cache', 'workbox-precache']);
  const deleted = [];
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    location: { origin: 'https://example.test' },
  };
  const caches = {
    keys: async () => [...store],
    delete: async (k) => { deleted.push(k); return store.delete(k); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8'), { self, caches, URL, Response, fetch });
  let done;
  listeners.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.deepEqual(deleted, ['three-eight-shell-v1']);
  assert.deepEqual([...store].sort(), ['other-app-cache', 'three-eight-shell-v2', 'workbox-precache']);
});
