// Codec helpers: RFC 6381 codec strings and MP4 sample entries.

import { box, fullBox, concat, u8, u16, u32, esds, visualSampleEntry, audioSampleEntry } from './fmp4.js';

const hex2 = (v) => v.toString(16).padStart(2, '0');

function reverseBits32(v) {
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = (r << 1) | (v & 1);
    v >>>= 1;
  }
  return r >>> 0;
}

export function avcCodecString(avcC) {
  return `avc1.${hex2(avcC[1])}${hex2(avcC[2])}${hex2(avcC[3])}`.toUpperCase().replace('AVC1', 'avc1');
}

export function hevcCodecString(hvcC, fourcc = 'hvc1') {
  const space = hvcC[1] >> 6;
  const tier = (hvcC[1] >> 5) & 1;
  const profile = hvcC[1] & 0x1f;
  const compat = ((hvcC[2] << 24) | (hvcC[3] << 16) | (hvcC[4] << 8) | hvcC[5]) >>> 0;
  const level = hvcC[12];
  const constraints = [...hvcC.subarray(6, 12)];
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  let s = `${fourcc}.${['', 'A', 'B', 'C'][space]}${profile}.${reverseBits32(compat).toString(16)}.${tier ? 'H' : 'L'}${level}`;
  for (const c of constraints) s += '.' + c.toString(16).toUpperCase();
  return s;
}

export function av1CodecString(av1C) {
  const profile = av1C[1] >> 5;
  const level = av1C[1] & 0x1f;
  const tier = av1C[2] >> 7;
  const high = (av1C[2] >> 6) & 1;
  const twelve = (av1C[2] >> 5) & 1;
  const depth = profile === 2 && high ? (twelve ? 12 : 10) : high ? 10 : 8;
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
}

export function vp9CodecString(vpcC) {
  // vpcC is a full box payload: version(1) flags(3) profile level bitDepth...
  const profile = vpcC[4];
  const level = vpcC[5];
  const depth = vpcC[6] >> 4;
  return `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(depth).padStart(2, '0')}`;
}

/** AAC AudioSpecificConfig → "mp4a.40.N". */
export function aacCodecString(asc) {
  if (!asc || !asc.length) return 'mp4a.40.2';
  let aot = asc[0] >> 3;
  if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
  return `mp4a.40.${aot}`;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export function makeAsc(sampleRate, channels, objectType = 2) {
  let idx = AAC_RATES.indexOf(sampleRate);
  if (idx < 0) idx = 3;
  return u8((objectType << 3) | (idx >> 1), ((idx & 1) << 7) | ((channels & 0xf) << 3));
}

/** Parse the first AC-3 frame header into a dac3 box. */
export function dac3FromFrame(f) {
  if (!f || f.length < 8 || f[0] !== 0x0b || f[1] !== 0x77) return box('dac3', u8(0x10, 0x3d, 0xe0)); // 48k, 5.1 fallback
  const fscod = f[4] >> 6;
  const frmsizecod = f[4] & 0x3f;
  const bsid = f[5] >> 3;
  const bsmod = f[5] & 7;
  const acmod = f[6] >> 5;
  let bit = 3; // bits consumed in byte 6
  if ((acmod & 1) && acmod !== 1) bit += 2;
  if (acmod & 4) bit += 2;
  if (acmod === 2) bit += 2;
  const byteIdx = 6 + (bit >> 3);
  const lfeon = (f[byteIdx] >> (7 - (bit & 7))) & 1;
  const brc = frmsizecod >> 1;
  const v = (fscod << 22) | (bsid << 17) | (bsmod << 14) | (acmod << 11) | (lfeon << 10) | (brc << 5);
  return box('dac3', u8((v >> 16) & 255, (v >> 8) & 255, v & 255));
}

/** Parse the first E-AC-3 frame header into a (single substream) dec3 box. */
export function dec3FromFrame(f) {
  let fscod = 0, bsid = 16, acmod = 7, lfeon = 1;
  if (f && f.length > 6 && f[0] === 0x0b && f[1] === 0x77) {
    fscod = f[4] >> 6;
    acmod = (f[4] >> 1) & 7;
    lfeon = f[4] & 1;
    bsid = f[5] >> 3;
  }
  const dataRate = 640;
  const b = [(dataRate >> 5) & 255, ((dataRate & 31) << 3) | 0];
  // fscod(2) bsid(5) reserved(1) | asvc(1) bsmod(3) acmod(3) lfeon(1) | reserved(3) num_dep_sub(4) reserved(1)
  b.push((fscod << 6) | (bsid << 1), (acmod << 1) | lfeon, 0);
  return box('dec3', u8(...b));
}

/** OpusHead (little endian, from Matroska CodecPrivate) → dOps box (big endian). */
export function dOpsFromOpusHead(head, channels) {
  if (head && head.length >= 19 && String.fromCharCode(...head.subarray(0, 8)) === 'OpusHead') {
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const ch = head[9];
    const preSkip = dv.getUint16(10, true);
    const rate = dv.getUint32(12, true);
    const gain = dv.getInt16(16, true);
    const family = head[18];
    const parts = [u8(0, ch), u16(preSkip), u32(rate), u16(gain & 0xffff), u8(family)];
    if (family !== 0) parts.push(head.subarray(19, 21 + ch));
    return { box: box('dOps', ...parts), channels: ch };
  }
  return { box: box('dOps', u8(0, channels || 2), u16(312), u32(48000), u16(0), u8(0)), channels: channels || 2 };
}

/** Matroska FLAC CodecPrivate ("fLaC" + metadata blocks) → dfLa box. */
export function dfLaFromCodecPrivate(cp) {
  let blocks = cp;
  if (cp && cp.length > 4 && cp[0] === 0x66 && cp[1] === 0x4c && cp[2] === 0x61 && cp[3] === 0x43) blocks = cp.subarray(4);
  if (!blocks || blocks.length < 38) return null;
  // Keep STREAMINFO only and mark it as the last metadata block.
  const si = new Uint8Array(blocks.subarray(0, 38));
  si[0] = 0x80;
  return fullBox('dfLa', 0, 0, si);
}

/** Read VP9 profile / bit depth from the uncompressed header of a key frame. */
function vp9Info(frame) {
  let profile = 0, depth = 8;
  if (frame && frame.length > 4) {
    const b0 = frame[0];
    if ((b0 >> 6) === 2) {
      profile = ((b0 >> 5) & 1) | (((b0 >> 4) & 1) << 1);
      if (profile >= 2 && frame.length > 4) {
        // After the 3-byte sync code; position depends on profile 3 reserved bit.
        const bitPos = (profile === 3 ? 6 : 5) + 3 + 24; // marker..show_frame..error_res, sync code
        const byte = frame[bitPos >> 3];
        depth = (byte >> (7 - (bitPos & 7))) & 1 ? 12 : 10;
      }
    }
  }
  return { profile, depth };
}

/**
 * Turn a Matroska track into something MSE can play:
 * returns { codecString, mime, sampleEntry } or { unsupported: reason }.
 * `firstFrame` is the first frame's payload (needed for AC-3 / VP9 headers).
 */
export function mp4TrackFromMatroska(t, firstFrame) {
  const cp = t.codecPrivate;
  const id = t.codecId;
  if (t.type === 'video') {
    const w = t.width || 1920, h = t.height || 1080;
    if (id === 'V_MPEG4/ISO/AVC' && cp) {
      return { codecString: avcCodecString(cp), sampleEntry: visualSampleEntry('avc1', w, h, box('avcC', cp)) };
    }
    if (id === 'V_MPEGH/ISO/HEVC' && cp) {
      return { codecString: hevcCodecString(cp), sampleEntry: visualSampleEntry('hvc1', w, h, box('hvcC', cp)) };
    }
    if (id === 'V_AV1' && cp && cp.length >= 4) {
      return { codecString: av1CodecString(cp), sampleEntry: visualSampleEntry('av01', w, h, box('av1C', cp)) };
    }
    if (id === 'V_VP9') {
      const { profile, depth } = vp9Info(firstFrame);
      const level = 40;
      const payload = concat([u8(1, 0, 0, 0), u8(profile, level, (depth << 4) | (1 << 1), 2, 2, 2), u16(0)]);
      const vpcC = box('vpcC', payload);
      return { codecString: vp9CodecString(payload), sampleEntry: visualSampleEntry('vp09', w, h, vpcC) };
    }
    return { unsupported: `video codec ${id}` };
  }
  if (t.type === 'audio') {
    const ch = t.channels || 2;
    const sr = Math.round(t.sampleRate || 48000);
    if (id.startsWith('A_AAC')) {
      let asc = cp && cp.length >= 2 ? cp : null;
      if (!asc) {
        const sbr = /SBR/.test(id);
        asc = makeAsc(sbr ? sr / 2 : sr, ch, /LTP/.test(id) ? 4 : /SSR/.test(id) ? 3 : /MAIN/.test(id) ? 1 : 2);
      }
      return { codecString: aacCodecString(asc), sampleEntry: audioSampleEntry('mp4a', ch, sr, esds(0x40, asc)) };
    }
    if (id === 'A_OPUS') {
      const d = dOpsFromOpusHead(cp, ch);
      return { codecString: 'opus', sampleEntry: audioSampleEntry('Opus', d.channels, 48000, d.box) };
    }
    if (id === 'A_FLAC') {
      const dfla = dfLaFromCodecPrivate(cp);
      if (!dfla) return { unsupported: 'FLAC without STREAMINFO' };
      return { codecString: 'flac', sampleEntry: audioSampleEntry('fLaC', ch, sr, dfla) };
    }
    if (id === 'A_AC3') {
      return { codecString: 'ac-3', sampleEntry: audioSampleEntry('ac-3', ch, sr, dac3FromFrame(firstFrame)) };
    }
    if (id === 'A_EAC3') {
      return { codecString: 'ec-3', sampleEntry: audioSampleEntry('ec-3', ch, sr, dec3FromFrame(firstFrame)) };
    }
    if (id === 'A_MPEG/L3' || id === 'A_MPEG/L2') {
      return { codecString: 'mp4a.6B', sampleEntry: audioSampleEntry('mp4a', ch, sr, esds(0x6b, null)) };
    }
    return { unsupported: `audio codec ${id.replace(/^A_/, '')}` };
  }
  return { unsupported: 'not audio/video' };
}

export function humanCodec(codecString) {
  if (!codecString) return '';
  const c = codecString.toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('avc3')) return 'H.264';
  if (c.startsWith('hvc1') || c.startsWith('hev1')) return 'HEVC';
  if (c.startsWith('av01')) return 'AV1';
  if (c.startsWith('vp09')) return 'VP9';
  if (c.startsWith('mp4a.40')) return 'AAC';
  if (c === 'mp4a.6b' || c === 'mp4a.69') return 'MP3';
  if (c === 'opus') return 'Opus';
  if (c === 'flac') return 'FLAC';
  if (c === 'ac-3') return 'AC-3';
  if (c === 'ec-3') return 'E-AC-3';
  return codecString;
}
