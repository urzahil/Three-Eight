// Minimal fragmented-MP4 (ISO BMFF) writer used to feed Media Source Extensions.
// Each SourceBuffer receives a single-track init segment followed by
// moof+mdat fragments.

const te = new TextEncoder();

export function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u8(...values) {
  return new Uint8Array(values);
}
export function u16(v) {
  return u8((v >>> 8) & 255, v & 255);
}
export function u24(v) {
  return u8((v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}
export function u32(v) {
  return u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}
export function u64(v) {
  const hi = Math.floor(v / 0x100000000);
  return concat([u32(hi), u32(v >>> 0)]);
}
export function str(s) {
  return te.encode(s);
}

export function box(type, ...payload) {
  const body = concat(payload.flat());
  const out = new Uint8Array(8 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  out.set(str(type), 4);
  out.set(body, 8);
  return out;
}

export function fullBox(type, version, flags, ...payload) {
  return box(type, u8(version), u24(flags), ...payload);
}

const MATRIX = concat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);

/** Sample entry builders (stsd children) for tracks coming from Matroska. */
export function visualSampleEntry(type, width, height, ...children) {
  return box(
    type,
    u8(0, 0, 0, 0, 0, 0), u16(1), // reserved, data_reference_index
    u16(0), u16(0), u32(0), u32(0), u32(0), // pre_defined/reserved
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), // 72 dpi
    u32(0), u16(1), // reserved, frame_count
    new Uint8Array(32), // compressorname
    u16(0x18), u16(0xffff), // depth, pre_defined
    ...children,
  );
}

export function audioSampleEntry(type, channels, sampleRate, ...children) {
  return box(
    type,
    u8(0, 0, 0, 0, 0, 0), u16(1),
    u32(0), u32(0), // reserved
    u16(channels), u16(16), u16(0), u16(0),
    u32((Math.min(sampleRate, 65535) << 16) >>> 0),
    ...children,
  );
}

function descriptor(tag, payload) {
  const len = payload.length;
  return concat([u8(tag, 0x80 | ((len >> 21) & 0x7f), 0x80 | ((len >> 14) & 0x7f), 0x80 | ((len >> 7) & 0x7f), len & 0x7f), payload]);
}

/** esds box for MPEG-4 audio (objectType 0x40 = AAC, 0x6B = MP3). */
export function esds(objectType, decoderSpecificInfo) {
  const dcd = descriptor(4, concat([
    u8(objectType, 0x15), u24(0), u32(0), u32(0),
    ...(decoderSpecificInfo && decoderSpecificInfo.length ? [descriptor(5, decoderSpecificInfo)] : []),
  ]));
  const es = descriptor(3, concat([u16(1), u8(0), dcd, descriptor(6, u8(2))]));
  return fullBox('esds', 0, 0, es);
}

/**
 * Build an init segment (ftyp + moov) for a single track.
 * @param {{id:number, type:'video'|'audio', timescale:number, sampleEntry:Uint8Array, width?:number, height?:number}} track
 */
export function initSegment(track) {
  const isVideo = track.type === 'video';
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso6'), str('mp41'));
  const mvhd = fullBox('mvhd', 0, 0,
    u32(0), u32(0), u32(1000), u32(0),
    u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
    MATRIX, new Uint8Array(24), u32(0xffffffff));
  const tkhd = fullBox('tkhd', 0, 3,
    u32(0), u32(0), u32(1), u32(0), u32(0),
    u32(0), u32(0), u16(0), u16(0), u16(isVideo ? 0 : 0x0100), u16(0),
    MATRIX,
    u32(((track.width || 0) << 16) >>> 0), u32(((track.height || 0) << 16) >>> 0));
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(track.timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), str(isVideo ? 'vide' : 'soun'), u32(0), u32(0), u32(0), str(isVideo ? 'VideoHandler\0' : 'SoundHandler\0'));
  const mediaHeader = isVideo ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : fullBox('smhd', 0, 0, u16(0), u16(0));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), track.sampleEntry),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', mediaHeader, dinf, stbl)));
  const mvex = box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  return concat([ftyp, box('moov', mvhd, trak, mvex)]);
}

/**
 * Build one moof+mdat fragment.
 * samples: [{dts, pts, duration, key, data}] in track timescale, decode order.
 */
export function fragment(sequence, samples) {
  const n = samples.length;
  const trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;
  const trunSize = 12 + 4 + 4 + n * 16;
  const tfhd = fullBox('tfhd', 0, 0x020000, u32(1));
  const tfdt = fullBox('tfdt', 1, 0, u64(Math.max(0, Math.round(samples[0].dts))));
  const trafSize = 8 + tfhd.length + tfdt.length + trunSize;
  const mfhd = fullBox('mfhd', 0, 0, u32(sequence));
  const moofSize = 8 + mfhd.length + trafSize;

  const trun = new Uint8Array(trunSize);
  const dv = new DataView(trun.buffer);
  dv.setUint32(0, trunSize);
  trun.set(str('trun'), 4);
  dv.setUint32(8, (1 << 24) | trunFlags); // version 1: signed composition offsets
  dv.setUint32(12, n);
  dv.setUint32(16, moofSize + 8); // data offset: from moof start to mdat payload
  let o = 20;
  let mdatLen = 0;
  for (const s of samples) {
    dv.setUint32(o, Math.max(0, Math.round(s.duration)));
    dv.setUint32(o + 4, s.data.length);
    dv.setUint32(o + 8, s.key ? 0x02000000 : 0x01010000);
    dv.setInt32(o + 12, Math.round(s.pts - s.dts));
    o += 16;
    mdatLen += s.data.length;
  }
  const traf = box('traf', tfhd, tfdt, trun);
  const moof = box('moof', mfhd, traf);
  const mdat = new Uint8Array(8 + mdatLen);
  new DataView(mdat.buffer).setUint32(0, mdat.length);
  mdat.set(str('mdat'), 4);
  let m = 8;
  for (const s of samples) {
    mdat.set(s.data, m);
    m += s.data.length;
  }
  return concat([moof, mdat]);
}
