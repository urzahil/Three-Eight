// Matroska / WebM demuxer working directly on a local File.
// Only reads what it needs: headers, the cue index, and the clusters around
// the current playback position.

import { FileSource } from './filesource.js';
import { mp4TrackFromMatroska } from './codecs.js';

const ID = {
  EBML: 0x1a45dfa3, DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489, Title: 0x7ba9,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83,
  FlagEnabled: 0xb9, FlagDefault: 0x88, FlagForced: 0x55aa, DefaultDuration: 0x23e383,
  Name: 0x536e, Language: 0x22b59c, LanguageBCP47: 0x22b59d, CodecID: 0x86, CodecPrivate: 0x63a2,
  Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Audio: 0xe1, SamplingFrequency: 0xb5, OutputSamplingFrequency: 0x78b5, Channels: 0x9f,
  ContentEncodings: 0x6d80, ContentEncoding: 0x6240, ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255, ContentEncryption: 0x5035,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1,
  BlockDuration: 0x9b, ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7,
  CueClusterPosition: 0xf1, CueRelativePosition: 0xf0,
  Chapters: 0x1043a770, Tags: 0x1254c367, Attachments: 0x1941a469,
};

const TOP_LEVEL = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Chapters, ID.Tags, ID.Attachments]);
const UNKNOWN = -1;
const td = new TextDecoder();

// ---- EBML primitives --------------------------------------------------------
function vintLength(first) {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1;
  return 0;
}

/** Element header at offset o of a Uint8Array. Returns null if malformed / truncated. */
function readHeader(b, o) {
  if (o >= b.length) return null;
  const idLen = vintLength(b[o]);
  if (!idLen || idLen > 4 || o + idLen >= b.length) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + b[o + i];
  const sizeLen = vintLength(b[o + idLen]);
  if (!sizeLen || o + idLen + sizeLen > b.length) return null;
  let size = b[o + idLen] & (0xff >> sizeLen);
  let allOnes = size === (0xff >> sizeLen);
  for (let i = 1; i < sizeLen; i++) {
    const v = b[o + idLen + i];
    if (v !== 0xff) allOnes = false;
    size = size * 256 + v;
  }
  return { id, size: allOnes ? UNKNOWN : size, headerLen: idLen + sizeLen };
}

function readUint(b, o, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[o + i];
  return v;
}

function readFloat(b, o, len) {
  const dv = new DataView(b.buffer, b.byteOffset + o, len);
  return len === 4 ? dv.getFloat32(0) : len === 8 ? dv.getFloat64(0) : 0;
}

/** Iterate the children of a fully-loaded master element. */
function* children(b, start = 0, end = b.length) {
  let o = start;
  while (o < end) {
    const h = readHeader(b, o);
    if (!h) return;
    const dataStart = o + h.headerLen;
    const size = h.size === UNKNOWN ? end - dataStart : h.size;
    yield { id: h.id, start: dataStart, size, end: Math.min(end, dataStart + size) };
    o = dataStart + size;
  }
}

/** Parse a (Simple)Block payload. */
function parseBlock(b) {
  const tl = vintLength(b[0]);
  if (!tl) return null;
  const track = readUint(b, 0, tl) - (0x80 >> (tl - 1)) * Math.pow(256, tl - 1);
  const rel = ((b[tl] << 8) | b[tl + 1]) << 16 >> 16;
  const flags = b[tl + 2];
  let o = tl + 3;
  const lacing = (flags >> 1) & 3;
  let frames;
  if (lacing === 0) {
    frames = [b.subarray(o)];
  } else {
    const count = b[o++] + 1;
    const sizes = [];
    if (lacing === 1) {
      for (let i = 0; i < count - 1; i++) {
        let s = 0, v;
        do { v = b[o++]; s += v; } while (v === 255);
        sizes.push(s);
      }
    } else if (lacing === 3) {
      let l = vintLength(b[o]);
      let s = readUint(b, o, l) - (0x80 >> (l - 1)) * Math.pow(256, l - 1);
      o += l;
      sizes.push(s);
      for (let i = 1; i < count - 1; i++) {
        l = vintLength(b[o]);
        const raw = readUint(b, o, l) - (0x80 >> (l - 1)) * Math.pow(256, l - 1);
        o += l;
        s += raw - (Math.pow(2, 7 * l - 1) - 1);
        sizes.push(s);
      }
    }
    const remaining = b.length - o;
    if (lacing === 2) {
      const each = Math.floor(remaining / count);
      for (let i = 0; i < count; i++) sizes.push(each);
    } else {
      sizes.push(remaining - sizes.reduce((a, c) => a + c, 0));
    }
    frames = [];
    for (const s of sizes) {
      frames.push(b.subarray(o, o + s));
      o += s;
    }
  }
  return { track, rel, key: !!(flags & 0x80), frames };
}

function opusFrameDuration(frame) {
  if (!frame || !frame.length) return 0.02;
  const toc = frame[0];
  const config = toc >> 3;
  let d;
  if (config < 12) d = [0.01, 0.02, 0.04, 0.06][config & 3];
  else if (config < 16) d = [0.01, 0.02][config & 1];
  else d = [0.0025, 0.005, 0.01, 0.02][config & 3];
  const c = toc & 3;
  const n = c === 0 ? 1 : c < 3 ? 2 : frame.length > 1 ? frame[1] & 0x3f : 1;
  return d * n;
}

function langName(t) {
  return t.language && t.language !== 'und' ? t.language : '';
}

// ---- Demuxer ---------------------------------------------------------------
export class MkvDemuxer {
  static async probe(file) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return head.length === 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  }

  static async open(file) {
    const d = new MkvDemuxer(file);
    await d._init();
    return d;
  }

  constructor(file) {
    this.file = file;
    this.container = 'matroska';
    this.src = new FileSource(file);
    this.timecodeScale = 1000000;
    this.tracks = [];
    this.cues = [];
    this.reorderDelay = new Map();
  }

  async _readElement(pos) {
    const hb = await this.src.read(pos, 16);
    const h = readHeader(hb, 0);
    if (!h) return null;
    const size = h.size === UNKNOWN ? 0 : h.size;
    const data = size > 64 * 1024 * 1024 ? null : await this.src.read(pos + h.headerLen, size);
    return { id: h.id, data, size, headerLen: h.headerLen };
  }

  async _init() {
    const head = await this.src.read(0, 64 * 1024);
    const eh = readHeader(head, 0);
    if (!eh || eh.id !== ID.EBML) throw new Error('Not a Matroska file');
    for (const c of children(head, eh.headerLen, eh.headerLen + eh.size)) {
      if (c.id === ID.DocType) this.docType = td.decode(head.subarray(c.start, c.end));
    }
    const segPos = eh.headerLen + eh.size;
    const sh = readHeader(head, segPos);
    if (!sh || sh.id !== ID.Segment) throw new Error('Matroska segment not found');
    this.segStart = segPos + sh.headerLen;
    this.segEnd = sh.size === UNKNOWN ? this.file.size : Math.min(this.file.size, this.segStart + sh.size);

    const seeks = new Map();
    const seen = new Set();
    let pos = this.segStart;
    // Walk top-level elements until the first cluster.
    for (let guard = 0; guard < 64 && pos < this.segEnd; guard++) {
      const hb = await this.src.read(pos, 16);
      const h = readHeader(hb, 0);
      if (!h) break;
      if (h.id === ID.Cluster) {
        this.firstCluster = pos;
        break;
      }
      if (h.size === UNKNOWN) break;
      if (h.id === ID.SeekHead || h.id === ID.Info || h.id === ID.Tracks || h.id === ID.Cues) {
        const el = await this._readElement(pos);
        this._handleTop(el, seeks);
        seen.add(h.id);
      }
      pos += h.headerLen + h.size;
    }
    // Elements referenced by the SeekHead that come after the clusters (typically Cues).
    for (const id of [ID.Info, ID.Tracks, ID.Cues, ID.SeekHead]) {
      if (seen.has(id) || !seeks.has(id)) continue;
      const el = await this._readElement(seeks.get(id));
      if (el && el.id === id) {
        seen.add(id);
        this._handleTop(el, seeks);
        if (id === ID.SeekHead && !seen.has(ID.Cues) && seeks.has(ID.Cues)) {
          const cues = await this._readElement(seeks.get(ID.Cues));
          if (cues && cues.id === ID.Cues) this._handleTop(cues, seeks);
        }
      }
    }
    if (!this.tracks.length) throw new Error('No tracks found');
    if (this.firstCluster == null) this.firstCluster = pos;
    this.timescale = 1e9 / this.timecodeScale;
    for (const t of this.tracks) t.timescale = this.timescale;
    this.cues.sort((a, b) => a.time - b.time);
    if (!this.duration && this.cues.length) this.duration = this.cues[this.cues.length - 1].time / this.timescale;

    // Read the first frame of each A/V track (needed for AC-3 / VP9 headers).
    const need = new Set(this.tracks.filter((t) => t.type === 'video' || t.type === 'audio').map((t) => t.number));
    const first = new Map();
    let n = 0;
    for await (const blk of this.blocks(this.firstCluster, need)) {
      if (!first.has(blk.track)) first.set(blk.track, blk.frames[0]);
      if (first.size === need.size || ++n > 2000) break;
    }
    for (const t of this.tracks) {
      if (t.type !== 'video' && t.type !== 'audio') continue;
      let m;
      if (t.compression && t.compression.algo !== 3) m = { unsupported: 'compressed track' };
      else if (t.encrypted) m = { unsupported: 'encrypted track' };
      else {
        let f = first.get(t.number);
        if (f && t.compression) f = concatBytes(t.compression.settings, f);
        m = mp4TrackFromMatroska(t, f);
      }
      Object.assign(t, m);
      if (m.codecString) t.mime = `${t.type}/mp4; codecs="${m.codecString}"`;
    }
  }

  _handleTop(el, seeks) {
    if (!el || !el.data) return;
    const b = el.data;
    if (el.id === ID.SeekHead) {
      for (const s of children(b)) {
        if (s.id !== ID.Seek) continue;
        let sid = 0, spos = -1;
        for (const c of children(b, s.start, s.end)) {
          if (c.id === ID.SeekID) sid = readUint(b, c.start, c.size);
          else if (c.id === ID.SeekPosition) spos = readUint(b, c.start, c.size);
        }
        if (sid && spos >= 0 && !seeks.has(sid)) seeks.set(sid, this.segStart + spos);
      }
    } else if (el.id === ID.Info) {
      let dur = 0;
      for (const c of children(b)) {
        if (c.id === ID.TimecodeScale) this.timecodeScale = readUint(b, c.start, c.size) || 1000000;
        else if (c.id === ID.Duration) dur = readFloat(b, c.start, c.size);
        else if (c.id === ID.Title) this.title = td.decode(b.subarray(c.start, c.end));
      }
      this.duration = (dur * this.timecodeScale) / 1e9;
    } else if (el.id === ID.Tracks) {
      for (const te of children(b)) if (te.id === ID.TrackEntry) this._parseTrack(b, te);
    } else if (el.id === ID.Cues) {
      for (const cp of children(b)) {
        if (cp.id !== ID.CuePoint) continue;
        let time = 0;
        const positions = [];
        for (const c of children(b, cp.start, cp.end)) {
          if (c.id === ID.CueTime) time = readUint(b, c.start, c.size);
          else if (c.id === ID.CueTrackPositions) {
            const p = { track: 0, clusterPos: 0, relPos: -1 };
            for (const x of children(b, c.start, c.end)) {
              if (x.id === ID.CueTrack) p.track = readUint(b, x.start, x.size);
              else if (x.id === ID.CueClusterPosition) p.clusterPos = this.segStart + readUint(b, x.start, x.size);
              else if (x.id === ID.CueRelativePosition) p.relPos = readUint(b, x.start, x.size);
            }
            positions.push(p);
          }
        }
        for (const p of positions) this.cues.push({ time, ...p });
      }
    }
  }

  _parseTrack(b, te) {
    const t = { number: 0, type: 'other', codecId: '', language: 'eng', name: '', isDefault: true, isForced: false, enabled: true };
    for (const c of children(b, te.start, te.end)) {
      switch (c.id) {
        case ID.TrackNumber: t.number = readUint(b, c.start, c.size); break;
        case ID.TrackType: {
          const v = readUint(b, c.start, c.size);
          t.type = v === 1 ? 'video' : v === 2 ? 'audio' : v === 17 ? 'subtitle' : 'other';
          break;
        }
        case ID.FlagEnabled: t.enabled = !!readUint(b, c.start, c.size); break;
        case ID.FlagDefault: t.isDefault = !!readUint(b, c.start, c.size); break;
        case ID.FlagForced: t.isForced = !!readUint(b, c.start, c.size); break;
        case ID.DefaultDuration: t.defaultDuration = readUint(b, c.start, c.size); break;
        case ID.Name: t.name = td.decode(b.subarray(c.start, c.end)); break;
        case ID.Language: t.language = td.decode(b.subarray(c.start, c.end)).replace(/\0+$/, ''); break;
        case ID.LanguageBCP47: t.language = td.decode(b.subarray(c.start, c.end)).replace(/\0+$/, ''); break;
        case ID.CodecID: t.codecId = td.decode(b.subarray(c.start, c.end)).replace(/\0+$/, ''); break;
        case ID.CodecPrivate: t.codecPrivate = b.slice(c.start, c.end); break;
        case ID.Video:
          for (const v of children(b, c.start, c.end)) {
            if (v.id === ID.PixelWidth) t.width = readUint(b, v.start, v.size);
            else if (v.id === ID.PixelHeight) t.height = readUint(b, v.start, v.size);
          }
          break;
        case ID.Audio:
          for (const a of children(b, c.start, c.end)) {
            if (a.id === ID.SamplingFrequency) t.sampleRate = t.sampleRate || readFloat(b, a.start, a.size);
            else if (a.id === ID.OutputSamplingFrequency) t.sampleRate = readFloat(b, a.start, a.size);
            else if (a.id === ID.Channels) t.channels = readUint(b, a.start, a.size);
          }
          break;
        case ID.ContentEncodings:
          for (const enc of children(b, c.start, c.end)) {
            if (enc.id !== ID.ContentEncoding) continue;
            for (const x of children(b, enc.start, enc.end)) {
              if (x.id === ID.ContentEncryption) t.encrypted = true;
              if (x.id !== ID.ContentCompression) continue;
              const comp = { algo: 0, settings: new Uint8Array(0) };
              for (const y of children(b, x.start, x.end)) {
                if (y.id === ID.ContentCompAlgo) comp.algo = readUint(b, y.start, y.size);
                else if (y.id === ID.ContentCompSettings) comp.settings = b.slice(y.start, y.end);
              }
              t.compression = comp;
            }
          }
          break;
        default: break;
      }
    }
    if (!t.number) return;
    t.id = t.number;
    if (t.type === 'subtitle') {
      t.subFormat = subtitleFormat(t.codecId);
      if (!t.subFormat) t.unsupported = /PGS|VOBSUB|DVB/i.test(t.codecId) ? 'image-based subtitles' : t.codecId;
    }
    t.label = [t.name, langName(t)].filter(Boolean).join(' · ');
    this.tracks.push(t);
  }

  /**
   * Async iterator over blocks starting at `pos` (must be a cluster start).
   * Yields {track, pts (ticks), key, frames, duration (ticks|null), pos}.
   */
  async *blocks(pos, trackSet, src = this.src) {
    let clusterTc = 0;
    const end = this.segEnd;
    while (pos < end) {
      if (!(await src.ensure(pos, 16)) && src.available(pos) < 2) return;
      const h = readHeader(src.view(pos, Math.min(16, src.available(pos))), 0);
      if (!h) {
        pos = await this._resync(src, pos + 1);
        if (pos < 0) return;
        continue;
      }
      const dataStart = pos + h.headerLen;
      if (h.id === ID.Cluster) {
        clusterTc = 0;
        pos = dataStart; // descend
        continue;
      }
      if (h.size === UNKNOWN) {
        // Unknown-size element other than a cluster: cannot skip it safely.
        pos = await this._resync(src, dataStart);
        if (pos < 0) return;
        continue;
      }
      if (h.id === ID.Timecode) {
        await src.ensure(dataStart, h.size);
        clusterTc = readUint(src.view(dataStart, h.size), 0, h.size);
      } else if (h.id === ID.SimpleBlock || h.id === ID.BlockGroup) {
        // Peek the track number before loading the whole block.
        await src.ensure(dataStart, Math.min(h.size, 16));
        let p = dataStart;
        if (h.id === ID.BlockGroup) {
          const inner = readHeader(src.view(p, Math.min(16, src.available(p))), 0);
          if (inner) p += inner.headerLen;
        }
        const tl = vintLength(src.byte(p));
        const tn = tl ? readUint(src.view(p, tl), 0, tl) - (0x80 >> (tl - 1)) * Math.pow(256, tl - 1) : -1;
        if (!trackSet || trackSet.has(tn)) {
          await src.ensure(dataStart, h.size);
          const data = src.view(dataStart, h.size);
          let blk = null, duration = null, hasRef = false;
          if (h.id === ID.SimpleBlock) blk = parseBlock(data);
          else {
            for (const c of children(data)) {
              if (c.id === ID.Block) blk = parseBlock(data.subarray(c.start, c.end));
              else if (c.id === ID.BlockDuration) duration = readUint(data, c.start, c.size);
              else if (c.id === ID.ReferenceBlock) hasRef = true;
            }
            if (blk) blk.key = !hasRef;
          }
          if (blk) {
            blk.frames = blk.frames.map((f) => f.slice()); // copy out of the window buffer
            yield { track: blk.track, pts: clusterTc + blk.rel, key: blk.key, frames: blk.frames, duration, pos };
          }
        }
      } else if (!TOP_LEVEL.has(h.id) && h.id !== ID.Segment && pos > end) {
        return;
      }
      pos = dataStart + h.size;
    }
  }

  async _resync(src, pos) {
    // Search forward for the next Cluster ID.
    const limit = Math.min(this.segEnd, pos + 32 * 1024 * 1024);
    while (pos < limit) {
      await src.ensure(pos, 4);
      const n = src.available(pos);
      const v = src.view(pos, n);
      for (let i = 0; i + 3 < v.length; i++) {
        if (v[i] === 0x1f && v[i + 1] === 0x43 && v[i + 2] === 0xb6 && v[i + 3] === 0x75) return pos + i;
      }
      pos += Math.max(1, n - 3);
    }
    return -1;
  }

  /** File position of the cluster to start reading from to reach `ticks`. */
  clusterFor(ticks, preferTrack) {
    const cues = this.cues;
    if (!cues.length) return this.firstCluster;
    let best = null;
    let lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].time <= ticks) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best == null) return this.firstCluster;
    // Prefer a cue point of the video track (key frame) at or before ticks.
    for (let i = best; i >= 0 && i > best - 200; i--) {
      if (preferTrack == null || cues[i].track === preferTrack) return cues[i].clusterPos;
    }
    return cues[best].clusterPos;
  }

  createCursor(trackId) {
    const t = this.tracks.find((x) => x.id === trackId);
    return new MkvCursor(this, t);
  }

  frameDuration(t, frame) {
    if (t.defaultDuration) return t.defaultDuration / this.timecodeScale;
    const sr = t.sampleRate || 48000;
    let sec;
    const id = t.codecId;
    if (id === 'A_OPUS') sec = opusFrameDuration(frame);
    else if (id.startsWith('A_AAC')) sec = 1024 / sr;
    else if (id === 'A_AC3' || id === 'A_EAC3') sec = 1536 / sr;
    else if (id === 'A_MPEG/L3' || id === 'A_MPEG/L2') sec = 1152 / sr;
    else if (t.type === 'video') sec = 1 / 24;
    else sec = 0.02;
    return sec * this.timescale;
  }

  /**
   * Extract text subtitles of all supported tracks.
   * onCues(trackId, cues[]) is called progressively; onProgress(0..1).
   * With opts.remote (streaming over HTTP) we never scan the whole file: tracks that
   * would need that, or too many separate reads, are skipped. Returns the skipped track ids.
   * opts.only limits it to one track id; opts.pace waits that many ms before each download.
   */
  async extractSubtitles(onCues, onProgress, signal, opts = {}) {
    const subs = this.tracks.filter((t) => t.type === 'subtitle' && t.subFormat && (opts.only == null || t.id === opts.only));
    if (!subs.length) return [];
    const set = new Set(subs.map((t) => t.number));
    const byNum = new Map(subs.map((t) => [t.number, t]));
    const pending = new Map(subs.map((t) => [t.number, []]));
    const flush = () => {
      for (const [num, list] of pending) {
        if (list.length) onCues(byNum.get(num).id, list.splice(0));
      }
    };
    const emit = async (blk) => {
      const t = byNum.get(blk.track);
      let data = blk.frames[0];
      if (!data) return;
      if (t.compression) {
        if (t.compression.algo === 3) data = concatBytes(t.compression.settings, data);
        else if (t.compression.algo === 0) data = await inflate(data);
        else return;
      }
      const start = blk.pts / this.timescale;
      const dur = blk.duration != null ? blk.duration / this.timescale : 4;
      pending.get(blk.track).push({ start, end: start + dur, raw: td.decode(data) });
    };

    // Fast path: mkvmerge indexes every subtitle block in the Cues.
    const subCues = this.cues.filter((c) => set.has(c.track) && c.relPos >= 0);
    const counts = new Map();
    for (const c of subCues) counts.set(c.track, (counts.get(c.track) || 0) + 1);
    const allIndexed = subs.every((t) => counts.get(t.number) > 0);
    // Each indexed block costs at least one remote request, so cap how many we are willing to fetch.
    if (opts.remote && (!allIndexed || subCues.length > (opts.maxRemoteCues || 3000))) return subs.map((t) => t.id);
    if (allIndexed) {
      const src = new FileSource(opts.remote && this.file.lite ? this.file.lite({ pace: opts.pace }) : this.file, 128 * 1024);
      let i = 0;
      for (const c of subCues) {
        if (signal?.aborted) return;
        await src.ensure(c.clusterPos, 64);
        const ch = readHeader(src.view(c.clusterPos, 64), 0);
        if (!ch || ch.id !== ID.Cluster) continue;
        const dataStart = c.clusterPos + ch.headerLen;
        // Cluster timecode
        let tc = 0;
        await src.ensure(dataStart, 64);
        const head = src.view(dataStart, 64);
        for (let o = 0, k = 0; o < head.length && k < 4; k++) {
          const th = readHeader(head, o);
          if (!th || th.size === UNKNOWN) break;
          if (th.id === ID.Timecode) {
            tc = readUint(head, o + th.headerLen, th.size);
            break;
          }
          o += th.headerLen + th.size; // skip CRC-32 / Void
        }
        const bpos = dataStart + c.relPos;
        await src.ensure(bpos, 16);
        const bh = readHeader(src.view(bpos, 16), 0);
        if (!bh || (bh.id !== ID.BlockGroup && bh.id !== ID.SimpleBlock) || bh.size === UNKNOWN) continue;
        await src.ensure(bpos + bh.headerLen, bh.size);
        const data = src.view(bpos + bh.headerLen, bh.size);
        let blk = null, duration = null;
        if (bh.id === ID.SimpleBlock) blk = parseBlock(data);
        else {
          for (const x of children(data)) {
            if (x.id === ID.Block) blk = parseBlock(data.subarray(x.start, x.end));
            else if (x.id === ID.BlockDuration) duration = readUint(data, x.start, x.size);
          }
        }
        if (!blk || !set.has(blk.track)) continue;
        await emit({ track: blk.track, pts: tc + blk.rel, frames: blk.frames.map((f) => f.slice()), duration });
        if (++i % 200 === 0) {
          flush();
          onProgress?.(i / subCues.length);
        }
      }
      flush();
      onProgress?.(1);
      return [];
    }

    // Slow path: scan the whole file (reads it once, sequentially).
    const src = new FileSource(this.file, 8 * 1024 * 1024);
    let last = 0;
    for await (const blk of this.blocks(this.firstCluster, set, src)) {
      if (signal?.aborted) return;
      await emit(blk);
      if (blk.pos - last > 64 * 1024 * 1024) {
        last = blk.pos;
        flush();
        onProgress?.(blk.pos / this.segEnd);
      }
    }
    flush();
    onProgress?.(1);
    return [];
  }
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function inflate(data) {
  const ds = new DecompressionStream('deflate');
  const out = new Response(new Blob([data]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

// ---- Cursor: reads samples of a single track sequentially ------------------
class MkvCursor {
  constructor(demux, track) {
    this.d = demux;
    this.t = track;
    this.timescale = demux.timescale;
    this.iter = null;
    this.pending = null;
    this.done = false;
  }

  seek(seconds) {
    const ticks = Math.max(0, seconds * this.timescale);
    const video = this.d.tracks.find((t) => t.type === 'video');
    const pos = this.d.clusterFor(ticks, video ? video.number : null);
    if (this.iter) this.iter.return?.();
    this.iter = this.d.blocks(pos, new Set([this.t.number]), new FileSource(this.d.file));
    this.pending = null;
    this.needKey = this.t.type === 'video';
    this.done = false;
  }

  async _nextBlock() {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      return p;
    }
    const r = await this.iter.next();
    if (r.done) return null;
    const blk = r.value;
    const comp = this.t.compression;
    if (comp && comp.algo === 3 && comp.settings.length) blk.frames = blk.frames.map((f) => concatBytes(comp.settings, f));
    return blk;
  }

  /** Next batch of samples (decode order) or null at end of stream. */
  async next() {
    if (this.done) return null;
    return this.t.type === 'video' ? this._nextVideo() : this._nextAudio();
  }

  async _nextVideo() {
    const frames = [];
    for (;;) {
      const b = await this._nextBlock();
      if (!b) {
        this.done = true;
        break;
      }
      if (this.needKey && !b.key) continue;
      this.needKey = false;
      if (b.key && frames.length) {
        this.pending = b;
        break;
      }
      for (const f of b.frames) frames.push({ pts: b.pts, key: b.key && frames.length === 0, data: f });
      if (frames.length >= 1000) break;
    }
    if (!frames.length) return null;
    // Matroska only stores presentation timestamps. Derive decode timestamps:
    // within a GOP, decode order DTS = sorted PTS shifted by the reorder delay.
    const sorted = frames.map((f) => f.pts).sort((a, b) => a - b);
    let delay = this.d.reorderDelay.get(this.t.number) || 0;
    for (let i = 0; i < frames.length; i++) delay = Math.max(delay, sorted[i] - frames[i].pts);
    this.d.reorderDelay.set(this.t.number, delay);
    const fd = this.d.frameDuration(this.t);
    for (let i = 0; i < frames.length; i++) frames[i].dts = sorted[i] - delay;
    for (let i = 0; i < frames.length; i++) {
      frames[i].duration = i + 1 < frames.length ? frames[i + 1].dts - frames[i].dts : fd;
    }
    return { samples: frames, timescale: this.timescale };
  }

  async _nextAudio() {
    const out = [];
    const span = 3 * this.timescale;
    for (;;) {
      const b = await this._nextBlock();
      if (!b) {
        this.done = true;
        break;
      }
      if (out.length && b.pts - out[0].pts >= span) {
        this.pending = b;
        break;
      }
      let ts = b.pts;
      for (const f of b.frames) {
        out.push({ pts: ts, dts: ts, key: true, data: f });
        if (b.frames.length > 1) ts += this.d.frameDuration(this.t, f);
      }
    }
    if (!out.length) return null;
    for (let i = 0; i < out.length; i++) {
      if (i + 1 < out.length) out[i].duration = out[i + 1].pts - out[i].pts;
      else if (this.pending) out[i].duration = this.pending.pts - out[i].pts;
      else out[i].duration = this.d.frameDuration(this.t, out[i].data);
      if (out[i].duration <= 0) out[i].duration = this.d.frameDuration(this.t, out[i].data);
    }
    return { samples: out, timescale: this.timescale };
  }
}

/** Map Matroska subtitle codec ids to our parser formats. */
export function subtitleFormat(codecId) {
  if (codecId === 'S_TEXT/UTF8' || codecId === 'S_TEXT/ASCII') return 'srt';
  if (codecId === 'S_TEXT/ASS' || codecId === 'S_TEXT/SSA' || codecId === 'S_ASS' || codecId === 'S_SSA') return 'ass-block';
  if (codecId === 'S_TEXT/WEBVTT') return 'vtt-block';
  return null;
}
