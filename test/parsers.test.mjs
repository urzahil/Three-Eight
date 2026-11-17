// Unit tests for the browser-side subtitle parsers and fMP4 writer (pure functions).
import { test } from 'node:test';
import assert from 'node:assert';
import { parseSrt, parseVtt, parseAss, normalizeEmbeddedCue, activeCues, cueToVtt } from '../public/assets/js/player/subtitles.js';
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

test('cue text is escaped for native WebVTT tracks', () => {
  assert.strictEqual(cueToVtt('<i>Tom & Jerry</i>\n1 < 2 > 0'), '<i>Tom &amp; Jerry</i>\n1 &lt; 2 &gt; 0');
  assert.strictEqual(cueToVtt('<b><u>x</u></b>'), '<b><u>x</u></b>');
});

test('MKV blocks(): BlockGroup children in any order, filtered by track', async () => {
  const { MkvDemuxer } = await import('../public/assets/js/player/mkv.js');
  const el = (id, body) => [...id, 0x80 | body.length, ...body]; // 1-byte sizes are enough here
  const block = (track, rel, payload) => [0x80 | track, rel >> 8, rel & 0xff, 0x00, ...payload];
  const cluster = [
    ...el([0xe7], [0x00]), // Timecode 0
    ...el([0xa0], [...el([0x9b], [0x05]), ...el([0xa1], block(3, 10, [0x68, 0x69]))]), // BlockDuration before Block
    ...el([0xa0], [...el([0xfb], [0x01]), ...el([0xa1], block(1, 20, [0x01]))]), // ReferenceBlock before Block, other track
    ...el([0xa0], [...el([0xa1], block(3, 30, [0x6f])), ...el([0x9b], [0x07])]), // Block first
    ...el([0xa3], [0x81, 0x00, 40, 0x80, 0x02]), // SimpleBlock (keyframe), other track
  ];
  const bytes = new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x80 | cluster.length, ...cluster]);
  const d = new MkvDemuxer(new Blob([bytes]));
  d.segEnd = bytes.length;
  const got = [];
  for await (const b of d.blocks(0, new Set([3]))) got.push({ track: b.track, pts: b.pts, duration: b.duration, text: String.fromCharCode(...b.frames[0]) });
  assert.deepStrictEqual(got, [
    { track: 3, pts: 10, duration: 5, text: 'hi' },
    { track: 3, pts: 30, duration: 7, text: 'o' },
  ]);
  const all = [];
  for await (const b of d.blocks(0, null)) all.push(b.track);
  assert.deepStrictEqual(all, [3, 1, 3, 1]);
});

test('MP4: a truncated 64-bit box header at the end of the file is not a RangeError', async () => {
  const { Mp4Demuxer } = await import('../public/assets/js/player/mp4.js');
  const bytes = new Uint8Array([0, 0, 0, 1, 0x6d, 0x64, 0x61, 0x74, 0, 0, 0, 0]); // size=1 "mdat", 12 bytes
  await assert.rejects(Mp4Demuxer.open(new Blob([bytes])), /No moov box found/);
});

test('MKV blocks(): truncated or corrupt laced blocks are skipped, not turned into garbage frames', async () => {
  const { MkvDemuxer } = await import('../public/assets/js/player/mkv.js');
  const el = (id, body) => [...id, 0x80 | body.length, ...body];
  const simple = (body) => el([0xa3], body);
  const cluster = [
    ...el([0xe7], [0x00]), // Timecode 0
    ...simple([0x81, 0x00]), // too short for timecode and flags
    ...simple([0x81, 0x00, 0x01, 0x02, 0x02, 0xff, 0xff]), // Xiph lacing, sizes run off the end
    ...simple([0x81, 0x00, 0x02, 0x06, 0x01, 0x00]), // EBML lacing, first size is not a valid number
    ...simple([0x81, 0x00, 0x03, 0x02, 0x01, 0x10, 0xaa]), // Xiph lacing, a frame larger than the block
    ...simple([0x81, 0x00, 0x04, 0x04, 0x05, 0xaa]), // fixed lacing, 6 frames in 1 byte
    ...simple([0x81, 0x00, 0x32, 0x80, 0x42]), // a good one
  ];
  const bytes = new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x80 | cluster.length, ...cluster]);
  const d = new MkvDemuxer(new Blob([bytes]));
  d.segEnd = bytes.length;
  const got = [];
  for await (const b of d.blocks(0, null)) got.push({ pts: b.pts, frames: b.frames.map((f) => [...f]) });
  assert.deepStrictEqual(got, [{ pts: 50, frames: [[0x42]] }]);
});

test('MKV video: decode times keep increasing when a later GOP needs a deeper reorder delay', async () => {
  const { MkvDemuxer } = await import('../public/assets/js/player/mkv.js');
  const t = { id: 1, number: 1, type: 'video' };
  const demux = { tracks: [t], timescale: 1000, reorderDelay: new Map(), frameDuration: () => 10 };
  const cur = MkvDemuxer.prototype.createCursor.call(demux, 1);
  const blk = (pts, key = false) => ({ track: 1, pts, key, frames: [new Uint8Array([pts & 0xff])] });
  // GOP 1 has no B-frames; GOP 2 (in decode order I P B B) does.
  cur.iter = (function* () {
    yield* [blk(0, true), blk(10), blk(20), blk(30, true), blk(60), blk(40), blk(50)];
  })();
  const all = [];
  for (let s; (s = await cur.next());) all.push(...s.samples);
  assert.strictEqual(all.length, 7);
  for (let i = 1; i < all.length; i++) assert(all[i].dts > all[i - 1].dts, `dts ${all[i].dts} after ${all[i - 1].dts}`);
  for (const f of all) assert(f.dts <= f.pts, `dts ${f.dts} <= pts ${f.pts}`);
});
