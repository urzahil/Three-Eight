// Pure helpers of room/util.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initials, trimUrl } from '../public/assets/js/room/util.js';

test('initials: by code point, so an emoji is never split', () => {
  assert.equal(initials('Ada Lovelace'), 'AL');
  assert.equal(initials('ada'), 'A');
  assert.equal(initials('😀 Party'), '😀P');
  assert.equal(initials('Bob 🎬'), 'B🎬');
  assert.equal(initials(''), '?');
  assert.equal(initials('   '), '?');
});

test('trimUrl: sentence punctuation after a link is not part of it', () => {
  assert.equal(trimUrl('https://x.org/a.'), 'https://x.org/a');
  assert.equal(trimUrl('https://x.org/a,'), 'https://x.org/a');
  assert.equal(trimUrl('https://x.org/a?!'), 'https://x.org/a');
  assert.equal(trimUrl('https://x.org/a?q=1'), 'https://x.org/a?q=1');
  assert.equal(trimUrl('https://x.org/a)'), 'https://x.org/a', '(see https://x.org/a)');
  assert.equal(trimUrl('https://en.wikipedia.org/wiki/Foo_(bar)'), 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(trimUrl('https://en.wikipedia.org/wiki/Foo_(bar)).'), 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(trimUrl('https://x.org/'), 'https://x.org/');
});
