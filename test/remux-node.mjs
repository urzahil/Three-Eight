// Remux one track of a file to fragmented MP4 using the browser modules (for inspection with ffprobe).
// Usage: node test/remux-node.mjs <input> <trackIndexType: video|audio0|audio1> <out.mp4>
import fs from 'fs';
import { MkvDemuxer } from '../public/assets/js/player/mkv.js';
import { Mp4Demuxer } from '../public/assets/js/player/mp4.js';
import { initSegment, fragment } from '../public/assets/js/player/fmp4.js';

const [input, which = 'video', out = 'out.mp4'] = process.argv.slice(2);
const blob = await fs.openAsBlob(input);
blob.name = input;
const demux = (await MkvDemuxer.probe(blob)) ? await MkvDemuxer.open(blob) : await Mp4Demuxer.open(blob);
for (const t of demux.tracks) console.log(t.id, t.type, t.codecString || t.codecId || t.fourcc, t.unsupported || '', t.label || '');
const vids = demux.tracks.filter((t) => t.type === 'video');
const auds = demux.tracks.filter((t) => t.type === 'audio');
const track = which === 'video' ? vids[0] : auds[Number(which.replace('audio', ''))];
const cur = demux.createCursor(track.id);
cur.seek(Number(process.env.SEEK || 0));
const parts = [initSegment(track)];
let seq = 1, n = 0, b;
while ((b = await cur.next())) {
  const shift = 10 * b.timescale;
  parts.push(fragment(seq++, b.samples.map((s) => ({ ...s, dts: s.dts + shift, pts: s.pts + shift }))));
  if (n++ === 0) console.log('first batch', b.samples.slice(0, 6).map((s) => [s.dts, s.pts, s.duration, s.key, s.data.length]));
}
fs.writeFileSync(out, Buffer.concat(parts.map((p) => Buffer.from(p))));
console.log('wrote', out, seq - 1, 'fragments');
