// Clock synchronization with the server: which samples are believed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addClockSample, bestOffset } from '../public/assets/js/signaling.js';

const feed = (list) => list.reduce((samples, s) => addClockSample(samples, s), []);

test('the sample with the shortest round trip gives the offset', () => {
  const samples = feed([{ rtt: 80, offset: 1000 }, { rtt: 20, offset: 1010 }, { rtt: 60, offset: 990 }]);
  assert.equal(samples.length, 3, 'consistent samples are all kept');
  assert.equal(bestOffset(samples), 1010);
});

test('at most 12 samples are kept, the oldest go first', () => {
  const samples = feed(Array.from({ length: 20 }, (_, i) => ({ rtt: 100 + i, offset: 0 })));
  assert.equal(samples.length, 12);
  assert.equal(samples[0].rtt, 108);
});

test('after the local clock jumped (the device slept), samples from before are dropped', () => {
  // Before the sleep: good Wi-Fi, short round trips. After it the local clock is 5 minutes behind (the offset grows
  // by 300 s) and the network is slower: the old, faster samples must not win.
  const before = feed([{ rtt: 15, offset: 2000 }, { rtt: 12, offset: 2003 }, { rtt: 18, offset: 1998 }]);
  const after = addClockSample(before, { rtt: 70, offset: 302000 });
  assert.deepEqual(after, [{ rtt: 70, offset: 302000 }]);
  assert.equal(bestOffset(after), 302000);
  assert.equal(bestOffset(addClockSample(after, { rtt: 40, offset: 302010 })), 302010, 'new samples refine it as usual');
});

test('a slow sample that still overlaps the fast ones does not throw them away', () => {
  const samples = feed([{ rtt: 10, offset: 500 }, { rtt: 400, offset: 650 }]);
  assert.equal(samples.length, 2, '650 ± 200 overlaps 500 ± 5');
  assert.equal(bestOffset(samples), 500);
});
