// MP4 / MOV demuxer (non-fragmented files) working on a local File.

import { FileSource } from './filesource.js';
import { audioSampleEntry, box } from './fmp4.js';
import { avcCodecString, hevcCodecString, av1CodecString, vp9CodecString, aacCodecString } from './codecs.js';

const td = new TextDecoder();
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function* boxes(b, start, end) {
  let o = start;
  while (o + 8 <= end) {
    const dv = new DataView(b.buffer, b.byteOffset + o);
    let size = dv.getUint32(0);
    const type = fourcc(b, o + 4);
    let hdr = 8;
    if (size === 1) {
      size = dv.getUint32(8) * 0x100000000 + dv.getUint32(12);
      hdr = 16;
    } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) return;
    yield { type, start: o, dataStart: o + hdr, end: o + size };
    o += size;
  }
}

function find(b, start, end, path) {
  const [head, ...rest] = path;
  for (const x of boxes(b, start, end)) {
    if (x.type === head) return rest.length ? find(b, x.dataStart, x.end, rest) : x;
  }
  return null;
}

function findAll(b, start, end, type) {
  return [...boxes(b, start, end)].filter((x) => x.type === type);
}

const GENERIC_NAMES = /^(sound|video|text|subtitle|timed ?text|closed caption|core media|apple|mainconcept|gpac|l-smash|isomedia|vide|soun|.*handler)\b/i;

export class Mp4Demuxer {
  static async probe(file) {
    const h = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (h.length < 8) return false;
    const t = fourcc(h, 4);
    return ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'pnot'].includes(t);
  }

  static async open(file) {
    const d = new Mp4Demuxer(file);
    await d._init();
    return d;
  }

  constructor(file) {
    this.file = file;
    this.container = 'mp4';
    this.src = new FileSource(file);
    this.tracks = [];
  }

  async _init() {
    let pos = 0;
    let moov = null;
    while (pos + 8 <= this.file.size) {
      const h = await this.src.read(pos, 16);
      const dv = new DataView(h.buffer);
      let size = dv.getUint32(0);
      const type = fourcc(h, 4);
      if (size === 1) size = dv.getUint32(8) * 0x100000000 + dv.getUint32(12);
      else if (size === 0) size = this.file.size - pos;
      if (size < 8) break;
      if (type === 'moov') moov = { pos, size };
      if (type === 'moof') this.fragmented = true;
      pos += size;
      if (moov && this.fragmented) break;
    }
    if (!moov) throw new Error('No moov box found');
    if (moov.size > 256 * 1024 * 1024) throw new Error('moov box too large');
    const b = await this.src.read(moov.pos, moov.size);
    const mvhd = find(b, 8, b.length, ['mvhd']);
    if (mvhd) {
      const dv = new DataView(b.buffer, mvhd.dataStart);
      const v = b[mvhd.dataStart];
      this.movieTimescale = v === 1 ? dv.getUint32(20) : dv.getUint32(12);
      this.duration = v === 1 ? (dv.getUint32(24) * 0x100000000 + dv.getUint32(28)) / this.movieTimescale : dv.getUint32(16) / this.movieTimescale;
    }
    for (const trak of findAll(b, 8, b.length, 'trak')) {
      try {
        const t = this._parseTrak(b, trak);
        if (t) this.tracks.push(t);
      } catch (err) {
        console.warn('Skipping track:', err);
      }
    }
    if (!this.tracks.length) throw new Error('No tracks');
    if (this.fragmented && this.tracks.every((t) => !t.count)) throw new Error('Fragmented MP4 input is not supported');
  }

  _parseTrak(b, trak) {
    const tkhd = find(b, trak.dataStart, trak.end, ['tkhd']);
    const mdhd = find(b, trak.dataStart, trak.end, ['mdia', 'mdhd']);
    const hdlr = find(b, trak.dataStart, trak.end, ['mdia', 'hdlr']);
    const stbl = find(b, trak.dataStart, trak.end, ['mdia', 'minf', 'stbl']);
    if (!tkhd || !mdhd || !hdlr || !stbl) return null;
    const t = {};
    {
      const v = b[tkhd.dataStart];
      const dv = new DataView(b.buffer, tkhd.dataStart);
      t.id = v === 1 ? dv.getUint32(20) : dv.getUint32(12);
      const flags = dv.getUint32(0) & 0xffffff;
      t.isDefault = !!(flags & 1);
    }
    {
      const v = b[mdhd.dataStart];
      const dv = new DataView(b.buffer, mdhd.dataStart);
      t.timescale = v === 1 ? dv.getUint32(20) : dv.getUint32(12);
      const langOff = v === 1 ? 32 : 20;
      const l = dv.getUint16(langOff);
      t.language = l ? String.fromCharCode(((l >> 10) & 31) + 0x60, ((l >> 5) & 31) + 0x60, (l & 31) + 0x60) : 'und';
      if (!/^[a-z]{3}$/.test(t.language)) t.language = 'und';
    }
    const handler = fourcc(b, hdlr.dataStart + 8);
    t.type = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : ['sbtl', 'text', 'subt'].includes(handler) ? 'subtitle' : 'other';
    let name = td.decode(b.subarray(hdlr.dataStart + 24, hdlr.end)).replace(/\0/g, '').trim();
    if (name && name.charCodeAt(0) === name.length - 1) name = name.slice(1); // QuickTime pascal string
    const udtaName = find(b, trak.dataStart, trak.end, ['udta', 'name']);
    if (udtaName) name = td.decode(b.subarray(udtaName.dataStart, udtaName.end)).replace(/\0/g, '').trim();
    t.name = name && !GENERIC_NAMES.test(name) ? name : '';
    t.label = [t.name, t.language !== 'und' ? t.language : ''].filter(Boolean).join(' · ');

    // Edit list → presentation offset.
    let adj = 0;
    const elst = find(b, trak.dataStart, trak.end, ['edts', 'elst']);
    if (elst) {
      const v = b[elst.dataStart];
      const dv = new DataView(b.buffer, elst.dataStart);
      const n = dv.getUint32(4);
      let o = 8;
      let emptyDelay = 0;
      for (let i = 0; i < n; i++) {
        const segDur = v === 1 ? dv.getUint32(o) * 0x100000000 + dv.getUint32(o + 4) : dv.getUint32(o);
        const mediaTime = v === 1 ? dv.getInt32(o + 8) * 0x100000000 + dv.getUint32(o + 12) : dv.getInt32(o + 4);
        o += v === 1 ? 20 : 12;
        if (mediaTime === -1) {
          emptyDelay += segDur;
          continue;
        }
        adj = -mediaTime + Math.round((emptyDelay * t.timescale) / (this.movieTimescale || t.timescale));
        break;
      }
    }
    t.adjust = adj;

    this._parseStsd(b, stbl, t);
    this._parseSampleTable(b, stbl, t);
    return t;
  }

  _parseStsd(b, stbl, t) {
    const stsd = find(b, stbl.dataStart, stbl.end, ['stsd']);
    if (!stsd) return;
    const entry = [...boxes(b, stsd.dataStart + 8, stsd.end)][0];
    if (!entry) return;
    const type = entry.type;
    t.fourcc = type;
    if (t.type === 'video') {
      const dv = new DataView(b.buffer, entry.dataStart);
      t.width = dv.getUint16(24);
      t.height = dv.getUint16(26);
      const kids = entry.dataStart + 78;
      const cfg = (n) => find(b, kids, entry.end, [n]);
      let codecString = null;
      if (type === 'avc1' || type === 'avc3') {
        const c = cfg('avcC');
        if (c) codecString = avcCodecString(b.subarray(c.dataStart, c.end)).replace('avc1', type);
      } else if (type === 'hvc1' || type === 'hev1') {
        const c = cfg('hvcC');
        if (c) codecString = hevcCodecString(b.subarray(c.dataStart, c.end), type);
      } else if (type === 'av01') {
        const c = cfg('av1C');
        if (c) codecString = av1CodecString(b.subarray(c.dataStart, c.end));
      } else if (type === 'vp09') {
        const c = cfg('vpcC');
        if (c) codecString = vp9CodecString(b.subarray(c.dataStart, c.end));
      }
      if (codecString) {
        t.codecString = codecString;
        // Copy the sample entry, keeping only boxes MSE understands.
        const keep = ['avcC', 'hvcC', 'av1C', 'vpcC', 'colr', 'pasp', 'btrt'];
        const children = [...boxes(b, kids, entry.end)].filter((x) => keep.includes(x.type)).map((x) => b.slice(x.start, x.end));
        const head = b.slice(entry.dataStart, entry.dataStart + 78);
        t.sampleEntry = box(type, head, ...children);
      } else t.unsupported = `video codec ${type}`;
    } else if (t.type === 'audio') {
      const dv = new DataView(b.buffer, entry.dataStart);
      const version = dv.getUint16(8);
      let channels = dv.getUint16(16);
      let rate = dv.getUint32(24) >>> 16;
      let kids = entry.dataStart + 28;
      if (version === 1) kids += 16;
      if (version === 2) {
        rate = Math.round(dv.getFloat64(32));
        channels = dv.getUint32(40);
        kids += 36;
      }
      t.channels = channels;
      t.sampleRate = rate;
      const findCfg = (n) => find(b, kids, entry.end, [n]) || find(b, kids, entry.end, ['wave', n]);
      const make = (fcc, cfgBox) => audioSampleEntry(fcc, channels, rate, b.slice(cfgBox.start, cfgBox.end));
      if (type === 'mp4a') {
        const e = findCfg('esds');
        if (e) {
          const info = parseEsds(b.subarray(e.dataStart, e.end));
          if (info.oti === 0x40 || info.oti === 0x66 || info.oti === 0x67 || info.oti === 0x68) t.codecString = aacCodecString(info.dsi);
          else if (info.oti === 0x6b || info.oti === 0x69) t.codecString = 'mp4a.6B';
          if (t.codecString) t.sampleEntry = make('mp4a', e);
        }
      } else if (type === 'Opus') {
        const c = findCfg('dOps');
        if (c) {
          t.codecString = 'opus';
          t.sampleEntry = make('Opus', c);
        }
      } else if (type === 'fLaC') {
        const c = findCfg('dfLa');
        if (c) {
          t.codecString = 'flac';
          t.sampleEntry = make('fLaC', c);
        }
      } else if (type === 'ac-3' || type === 'ec-3') {
        const c = findCfg(type === 'ac-3' ? 'dac3' : 'dec3');
        if (c) {
          t.codecString = type;
          t.sampleEntry = make(type, c);
        }
      }
      if (!t.codecString) t.unsupported = `audio codec ${type.trim()}`;
    } else if (t.type === 'subtitle') {
      if (type === 'tx3g' || type === 'text') t.subFormat = 'tx3g';
      else if (type === 'wvtt') t.subFormat = 'wvtt';
    }
    if (t.codecString) t.mime = `${t.type}/mp4; codecs="${t.codecString}"`;
  }

  _parseSampleTable(b, stbl, t) {
    const get = (n) => find(b, stbl.dataStart, stbl.end, [n]);
    const dvAt = (x) => new DataView(b.buffer, b.byteOffset + x.dataStart, x.end - x.dataStart);

    // Sizes
    let sizes;
    const stsz = get('stsz');
    const stz2 = get('stz2');
    if (stsz) {
      const dv = dvAt(stsz);
      const fixed = dv.getUint32(4);
      const n = dv.getUint32(8);
      sizes = new Uint32Array(n);
      if (fixed) sizes.fill(fixed);
      else for (let i = 0; i < n; i++) sizes[i] = dv.getUint32(12 + i * 4);
    } else if (stz2) {
      const dv = dvAt(stz2);
      const fs = dv.getUint8(7);
      const n = dv.getUint32(8);
      sizes = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        if (fs === 16) sizes[i] = dv.getUint16(12 + i * 2);
        else if (fs === 8) sizes[i] = dv.getUint8(12 + i);
        else sizes[i] = (dv.getUint8(12 + (i >> 1)) >> (i & 1 ? 0 : 4)) & 15;
      }
    } else sizes = new Uint32Array(0);
    const n = sizes.length;
    t.count = n;
    t.sizes = sizes;

    // Chunk offsets
    let chunkOffsets = [];
    const stco = get('stco');
    const co64 = get('co64');
    if (stco) {
      const dv = dvAt(stco);
      const c = dv.getUint32(4);
      chunkOffsets = new Float64Array(c);
      for (let i = 0; i < c; i++) chunkOffsets[i] = dv.getUint32(8 + i * 4);
    } else if (co64) {
      const dv = dvAt(co64);
      const c = dv.getUint32(4);
      chunkOffsets = new Float64Array(c);
      for (let i = 0; i < c; i++) chunkOffsets[i] = dv.getUint32(8 + i * 8) * 0x100000000 + dv.getUint32(12 + i * 8);
    }

    // Sample → chunk
    const offsets = new Float64Array(n);
    const stsc = get('stsc');
    if (stsc && chunkOffsets.length) {
      const dv = dvAt(stsc);
      const entries = dv.getUint32(4);
      let sample = 0;
      for (let e = 0; e < entries; e++) {
        const first = dv.getUint32(8 + e * 12) - 1;
        const per = dv.getUint32(12 + e * 12);
        const nextFirst = e + 1 < entries ? dv.getUint32(8 + (e + 1) * 12) - 1 : chunkOffsets.length;
        for (let c = first; c < nextFirst && sample < n; c++) {
          let off = chunkOffsets[c];
          for (let k = 0; k < per && sample < n; k++) {
            offsets[sample] = off;
            off += sizes[sample];
            sample++;
          }
        }
      }
    }
    t.offsets = offsets;

    // Decode times
    const dts = new Float64Array(n);
    const durations = new Uint32Array(n);
    const stts = get('stts');
    if (stts) {
      const dv = dvAt(stts);
      const entries = dv.getUint32(4);
      let s = 0, time = 0;
      for (let e = 0; e < entries; e++) {
        const count = dv.getUint32(8 + e * 8);
        const delta = dv.getUint32(12 + e * 8);
        for (let k = 0; k < count && s < n; k++) {
          dts[s] = time;
          durations[s] = delta;
          time += delta;
          s++;
        }
      }
    }
    t.dts = dts;
    t.durations = durations;

    // Composition offsets
    const cto = new Int32Array(n);
    const ctts = get('ctts');
    if (ctts) {
      const dv = dvAt(ctts);
      const v = dv.getUint8(0);
      const entries = dv.getUint32(4);
      let s = 0;
      for (let e = 0; e < entries; e++) {
        const count = dv.getUint32(8 + e * 8);
        const off = v === 1 ? dv.getInt32(12 + e * 8) : dv.getUint32(12 + e * 8) | 0;
        for (let k = 0; k < count && s < n; k++) cto[s++] = off;
      }
    }
    t.cto = cto;

    // Sync samples
    const stss = get('stss');
    let sync = null;
    if (stss) {
      const dv = dvAt(stss);
      const c = dv.getUint32(4);
      sync = new Uint8Array(n);
      for (let i = 0; i < c; i++) {
        const idx = dv.getUint32(8 + i * 4) - 1;
        if (idx < n) sync[idx] = 1;
      }
    }
    t.sync = sync; // null = every sample is a sync sample
  }

  createCursor(trackId) {
    return new Mp4Cursor(this, this.tracks.find((t) => t.id === trackId));
  }

  async readSamples(t, from, to) {
    // Read [from, to) samples, merging nearby byte ranges into single reads.
    const out = [];
    let i = from;
    while (i < to) {
      let j = i;
      let end = t.offsets[i] + t.sizes[i];
      while (j + 1 < to && t.offsets[j + 1] >= t.offsets[i] && t.offsets[j + 1] - end < 1024 * 1024 && t.offsets[j + 1] + t.sizes[j + 1] - t.offsets[i] < 32 * 1024 * 1024) {
        j++;
        end = Math.max(end, t.offsets[j] + t.sizes[j]);
      }
      const base = t.offsets[i];
      const buf = await this.src.read(base, end - base);
      for (let k = i; k <= j; k++) {
        const o = t.offsets[k] - base;
        out.push(buf.slice(o, o + t.sizes[k]));
      }
      i = j + 1;
    }
    return out;
  }

  async extractSubtitles(onCues, onProgress, signal) {
    const subs = this.tracks.filter((t) => t.type === 'subtitle' && t.subFormat);
    let done = 0;
    for (const t of subs) {
      const cues = [];
      for (let i = 0; i < t.count; i += 500) {
        if (signal?.aborted) return;
        const end = Math.min(t.count, i + 500);
        const datas = await this.readSamples(t, i, end);
        for (let k = i; k < end; k++) {
          const text = decodeTextSample(t.subFormat, datas[k - i]);
          if (!text) continue;
          const start = (t.dts[k] + t.adjust) / t.timescale;
          cues.push({ start, end: start + t.durations[k] / t.timescale, raw: text });
        }
      }
      onCues(t.id, cues);
      onProgress?.(++done / subs.length);
    }
    onProgress?.(1);
  }
}

function parseEsds(b) {
  // Full box: version/flags then descriptors.
  let o = 4;
  const readDesc = () => {
    const tag = b[o++];
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const c = b[o++];
      len = (len << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return { tag, len, start: o };
  };
  const res = { oti: 0, dsi: null };
  try {
    const es = readDesc();
    if (es.tag !== 3) return res;
    const flags = b[o + 2];
    o += 3;
    if (flags & 0x80) o += 2;
    if (flags & 0x40) o += 1 + b[o];
    if (flags & 0x20) o += 2;
    const dc = readDesc();
    if (dc.tag !== 4) return res;
    res.oti = b[o];
    o += 13;
    if (o < dc.start + dc.len) {
      const ds = readDesc();
      if (ds.tag === 5) res.dsi = b.slice(o, o + ds.len);
    }
  } catch {
    /* ignore malformed */
  }
  return res;
}

function decodeTextSample(format, d) {
  if (!d || d.length < 2) return '';
  if (format === 'tx3g') {
    const len = (d[0] << 8) | d[1];
    return td.decode(d.subarray(2, 2 + len));
  }
  if (format === 'wvtt') {
    const parts = [];
    for (const x of boxes(d, 0, d.length)) {
      if (x.type !== 'vttc') continue;
      const p = find(d, x.dataStart, x.end, ['payl']);
      if (p) parts.push(td.decode(d.subarray(p.dataStart, p.end)));
    }
    return parts.join('\n');
  }
  return '';
}

class Mp4Cursor {
  constructor(demux, track) {
    this.d = demux;
    this.t = track;
    this.timescale = track.timescale;
    this.idx = 0;
  }

  seek(seconds) {
    const t = this.t;
    const target = seconds * t.timescale - t.adjust;
    let lo = 0, hi = t.count - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t.dts[mid] <= target) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (t.sync) while (best > 0 && !t.sync[best]) best--;
    this.idx = best;
  }

  async next() {
    const t = this.t;
    if (this.idx >= t.count) return null;
    const start = this.idx;
    let end = start + 1;
    if (t.type === 'video') {
      while (end < t.count && end - start < 1000 && !(t.sync && t.sync[end])) end++;
      if (!t.sync) end = Math.min(t.count, start + 60);
    } else {
      const span = 3 * t.timescale;
      while (end < t.count && t.dts[end] - t.dts[start] < span) end++;
    }
    this.idx = end;
    const datas = await this.d.readSamples(t, start, end);
    const samples = [];
    for (let i = start; i < end; i++) {
      const dts = t.dts[i] + t.adjust;
      samples.push({ dts, pts: dts + t.cto[i], duration: t.durations[i], key: !t.sync || !!t.sync[i], data: datas[i - start] });
    }
    return { samples, timescale: t.timescale };
  }
}
