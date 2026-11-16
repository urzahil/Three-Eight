// MseEngine's wake-up bookkeeping (no MediaSource needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import './browser-globals.mjs';

globalThis.window ??= {}; // mse.js reads window.MediaSource when it is loaded
const { MseEngine } = await import('../public/assets/js/player/mse.js');

test('waitWake: a wait that times out leaves no waker behind', async () => {
  const e = new MseEngine({}, {});
  for (let i = 0; i < 50; i++) await e.waitWake(1);
  assert.equal(e._wakers.length, 0);
  // several at once, then they all time out
  await Promise.all([e.waitWake(2), e.waitWake(3), e.waitWake(4)]);
  assert.equal(e._wakers.length, 0);
});

test('waitWake: wake() releases every waiter and empties the list; a timer that fires later does nothing', async () => {
  const e = new MseEngine({}, {});
  const done = [e.waitWake(10000), e.waitWake(10000)];
  assert.equal(e._wakers.length, 2);
  e.wake();
  assert.equal(e._wakers.length, 0);
  await Promise.all(done);
  // a waiter added after the wake-up is its own
  const late = e.waitWake(5);
  assert.equal(e._wakers.length, 1);
  await late;
  assert.equal(e._wakers.length, 0);
});

test('waitWake: timing out one waiter keeps the others', async () => {
  const e = new MseEngine({}, {});
  const long = e.waitWake(10000);
  await e.waitWake(1);
  assert.equal(e._wakers.length, 1);
  e.wake();
  await long;
  assert.equal(e._wakers.length, 0);
});
