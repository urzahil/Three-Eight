// Unit tests for the browser-side subtitle parsers and fMP4 writer (pure functions).
import { test } from 'node:test';
import assert from 'node:assert';
import { parseSrt, parseVtt, parseAss, normalizeEmbeddedCue, activeCues } from '../public/assets/js/player/subtitles.js';
import { fragment, initSegment } from '../public/assets/js/player/fmp4.js';
import { avcCodecString, aacCodecString, makeAsc } from '../public/assets/js/player/codecs.js';

test('SRT', () => {
  const cues = parseSrt('1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hi</i> <font color="red">there</font>\r\n\r\n2\n00:01:00,000 --> 00:01:01,000\nA &amp; B\n');
  assert.deepStrictEqual(cues, [
    { start: 1, end: 2.5, text: '<i>Hi</i> there' },
    { start: 60, end: 61, text: 'A & B' },
  ]);
});

test('SRT strips script tags', () => {
  const [c] = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n<script>alert(1)</script><img src=x onerror=alert(1)>ok\n');
  assert.strictEqual(c.text, 'alert(1)ok');
});

test('WebVTT', () => {
  const cues = parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000 line:10%\n<v Bob>Top</v>\n\n00:03.000 --> 00:04.000\n<b>Bold</b>\n');
  assert.deepStrictEqual(cues, [
    { start: 1, end: 2, text: 'Top', top: true },
    { start: 3, end: 4, text: '<b>Bold</b>', top: false },
  ]);
});

test('ASS', () => {
  const cues = parseAss('[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.00,0:00:06.50,Default,,0,0,0,,Ciao, {\\i1}mondo{\\i0}\\Nriga\nDialogue: 0,0:00:10.00,0:00:14.00,Default,,0,0,0,,{\\an8}Top\nDialogue: 0,0:00:10.00,0:00:14.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}\n');
  assert.deepStrictEqual(cues, [
    { start: 2, end: 6.5, text: 'Ciao, <i>mondo</i>\nriga', top: false },
    { start: 10, end: 14, text: 'Top', top: true },
  ]);
  const block = normalizeEmbeddedCue('ass-block', { start: 1, end: 2, raw: '3,0,Default,,0,0,0,,Hello, world' });
  assert.strictEqual(block.text, 'Hello, world');
});

test('activeCues handles overlaps', () => {
  const cues = [{ start: 0, end: 10, text: 'a' }, { start: 2, end: 3, text: 'b' }, { start: 5, end: 6, text: 'c' }];
  assert.deepStrictEqual(activeCues(cues, 2.5).map((c) => c.text), ['a', 'b']);
  assert.deepStrictEqual(activeCues(cues, 7).map((c) => c.text), ['a']);
  assert.deepStrictEqual(activeCues(cues, 11), []);
});

test('codec strings', () => {
  assert.strictEqual(avcCodecString(new Uint8Array([1, 0x64, 0x00, 0x1f])), 'avc1.64001F');
  assert.strictEqual(aacCodecString(makeAsc(48000, 2)), 'mp4a.40.2');
  assert.strictEqual(aacCodecString(new Uint8Array([0x2b, 0x92])), 'mp4a.40.5');
});

test('fMP4 boxes are well formed', () => {
  const init = initSegment({ id: 1, type: 'audio', timescale: 48000, sampleEntry: new Uint8Array([0, 0, 0, 8, 0x6d, 0x70, 0x34, 0x61]) });
  const dv = new DataView(init.buffer);
  const ftyp = dv.getUint32(0);
  assert.strictEqual(dv.getUint32(ftyp) + ftyp, init.length, 'ftyp + moov cover the segment');
  const frag = fragment(7, [{ dts: 100, pts: 100, duration: 1024, key: true, data: new Uint8Array(10) }, { dts: 1124, pts: 1124, duration: 1024, key: true, data: new Uint8Array(5) }]);
  const fdv = new DataView(frag.buffer);
  const moof = fdv.getUint32(0);
  assert.strictEqual(String.fromCharCode(...frag.subarray(moof + 4, moof + 8)), 'mdat');
  assert.strictEqual(fdv.getUint32(moof), 8 + 15);
});
