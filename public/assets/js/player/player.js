// MoviePlayer: plays a local file, chooses between native playback and the
// MSE remuxer, and exposes audio / subtitle track selection.

import { MkvDemuxer } from './mkv.js';
import { Mp4Demuxer } from './mp4.js';
import { MseEngine, SHIFT, mseAvailable, mseSupports } from './mse.js';
import { NativeCaptions, SubtitleRenderer, normalizeEmbeddedCue, parseSubtitleFile, sortCues } from './subtitles.js';
import { humanCodec } from './codecs.js';

const LANG_NAMES = (() => {
  try {
    return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
  } catch {
    return null;
  }
})();

const ISO2 = { eng: 'en', ita: 'it', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', por: 'pt', jpn: 'ja', chi: 'zh', zho: 'zh', kor: 'ko', rus: 'ru', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl', cze: 'cs', ces: 'cs', hun: 'hu', gre: 'el', ell: 'el', tur: 'tr', ara: 'ar', heb: 'he', hin: 'hi', tha: 'th', vie: 'vi', ukr: 'uk', rum: 'ro', ron: 'ro', bul: 'bg', hrv: 'hr', srp: 'sr', slv: 'sl', slo: 'sk', slk: 'sk', ind: 'id', may: 'ms', msa: 'ms', cat: 'ca', baq: 'eu', eus: 'eu', glg: 'gl', ice: 'is', isl: 'is', per: 'fa', fas: 'fa' };

export function languageName(code) {
  if (!code || code === 'und') return '';
  const c = ISO2[code] || code;
  try {
    return (LANG_NAMES && LANG_NAMES.of(c)) || code;
  } catch {
    return code;
  }
}

function trackLabel(t, n, kind) {
  const lang = languageName(t.language);
  const parts = [];
  if (t.name) parts.push(t.name);
  if (lang && !(t.name || '').toLowerCase().includes(lang.toLowerCase())) parts.push(lang);
  if (kind === 'audio') {
    const codec = humanCodec(t.codecString) || (t.codecId || '').replace(/^A_/, '');
    const ch = t.channels ? (t.channels === 6 ? '5.1' : t.channels === 8 ? '7.1' : t.channels === 2 ? 'stereo' : t.channels === 1 ? 'mono' : `${t.channels}ch`) : '';
    const tech = [codec, ch].filter(Boolean).join(' ');
    if (tech) parts.push(tech);
  }
  if (kind === 'subtitle' && t.isForced) parts.push('forced');
  return parts.length ? parts.join(' · ') : `Track ${n}`;
}

async function openDemuxer(file) {
  try {
    if (await MkvDemuxer.probe(file)) return await MkvDemuxer.open(file);
    if (await Mp4Demuxer.probe(file)) return await Mp4Demuxer.open(file);
  } catch (err) {
    if (err?.remote) throw err; // a failed download is not an unknown container
    console.warn('Could not parse container, falling back to native playback:', err);
  }
  return null;
}

function nativeContainerSupport(file, demux) {
  const v = document.createElement('video');
  const name = file.name.toLowerCase();
  if (demux?.container === 'matroska') {
    if (demux.docType === 'webm') return v.canPlayType('video/webm') !== '';
    return v.canPlayType('video/x-matroska') !== '' || v.canPlayType('video/mkv') !== '';
  }
  if (demux?.container === 'mp4') return v.canPlayType(name.endsWith('.mov') ? 'video/quicktime' : 'video/mp4') !== '' || v.canPlayType('video/mp4') !== '';
  return true; // unknown container: let the browser try
}

export class MoviePlayer extends EventTarget {
  constructor(video, overlay) {
    super();
    this.video = video;
    this.overlay = overlay;
    this.renderer = new SubtitleRenderer(overlay, video);
    this.nativeCaptions = new NativeCaptions(video);
    this.file = null;
    this.demux = null;
    this.engine = null;
    this.mode = null;
    this.audioIndex = 0;
    this.subtitleId = null;
    this.subtitles = new Map(); // id -> {id, label, cues, source, progress, unsupported}
    this._raf = 0;
    this._loadToken = 0;
    this.video.controls = false;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    for (const ev of ['play', 'pause', 'seeking', 'seeked', 'waiting', 'playing', 'ended', 'timeupdate', 'ratechange', 'volumechange', 'loadedmetadata', 'canplay', 'durationchange']) {
      video.addEventListener(ev, () => this.dispatchEvent(new Event(ev)));
    }
    video.addEventListener('error', () => this._onVideoError());
    // The overlay can live in a Document Picture-in-Picture window while the
    // main tab is hidden (its rAF stops), so frames follow the overlay's window.
    document.addEventListener('visibilitychange', () => this.kickRenderLoop());
    this.kickRenderLoop();
  }

  /** (Re)start the subtitle render loop on the window that owns the overlay. */
  kickRenderLoop() {
    if (this._rafWin) this._rafWin.cancelAnimationFrame(this._raf);
    this._rafWin = null;
    clearTimeout(this._frameTimer);
    const run = () => this.kickRenderLoop();
    try {
      if (this.file) this.renderer.update(this.time);
    } catch (err) {
      console.warn('Subtitle render failed', err);
    }
    const win = this.overlay.ownerDocument.defaultView;
    if (win && typeof win.requestAnimationFrame === 'function' && win.document.visibilityState === 'visible') {
      this._rafWin = win;
      this._raf = win.requestAnimationFrame(run);
      this._frameTimer = setTimeout(run, 250); // safety net if that window goes away
    } else {
      this._frameTimer = setTimeout(run, 100);
    }
  }

  /** 'hidden' | 'showing': how the native caption track (used by system PiP) is displayed. */
  setNativeCaptionsMode(mode) {
    this.nativeCaptions.setMode(mode);
  }

  _showCues(immediate = false) {
    const s = this.subtitleId ? this.subtitles.get(this.subtitleId) : null;
    const cues = s ? s.cues : [];
    this.renderer.setCues(cues);
    this.nativeCaptions.set(cues, this.renderer.delay + (this.mode === 'mse' ? SHIFT : 0), immediate);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get loaded() {
    return !!this.file && this.mode != null;
  }

  get time() {
    const t = this.video.currentTime || 0;
    return this.mode === 'mse' ? Math.max(0, t - SHIFT) : t;
  }

  get duration() {
    const d = this.demux?.duration;
    if (d && Number.isFinite(d)) return d;
    const vd = this.video.duration;
    if (!Number.isFinite(vd)) return 0;
    return this.mode === 'mse' ? Math.max(0, vd - SHIFT) : vd;
  }

  get paused() {
    return this.video.paused;
  }

  get ended() {
    return this.video.ended;
  }

  /** Buffered ranges in movie time. */
  get buffered() {
    const b = this.video.buffered;
    const off = this.mode === 'mse' ? SHIFT : 0;
    const out = [];
    for (let i = 0; i < b.length; i++) out.push([Math.max(0, b.start(i) - off), b.end(i) - off]);
    return out;
  }

  async play() {
    return this.video.play();
  }

  pause() {
    this.video.pause();
  }

  seek(t) {
    const d = this.duration;
    const clamped = Math.max(0, d ? Math.min(t, d - 0.05) : t);
    this.video.currentTime = this.mode === 'mse' ? clamped + SHIFT : clamped;
  }

  set playbackRate(r) {
    this.video.playbackRate = r;
  }

  get playbackRate() {
    return this.video.playbackRate;
  }

  get info() {
    if (!this.file) return null;
    return {
      name: this.file.name,
      size: this.file.size,
      duration: this.duration,
      mode: this.mode,
      audioTracks: this.audioTracks,
      subtitleTracks: [...this.subtitles.values()].map((s) => ({ id: s.id, label: s.label, source: s.source, progress: s.progress, unsupported: s.unsupported })),
      audioIndex: this.audioIndex,
      subtitleId: this.subtitleId,
    };
  }

  unload() {
    this._loadToken++;
    this.extractAbort?.abort();
    this.engine?.destroy();
    this.engine = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.video.removeAttribute('src');
    this.video.load();
    this.file?.close?.(); // remote files: stop downloading
    this.file = null;
    this.demux = null;
    this.mode = null;
    for (const [id, s] of this.subtitles) if (s.source === 'embedded') this.subtitles.delete(id);
    this.renderer.setCues([]);
    this.nativeCaptions.clear();
    this._emit('tracks');
  }

  async load(file, { audioIndex = 0, startTime = 0 } = {}) {
    this.unload();
    const token = ++this._loadToken;
    this.file = file;
    this.triedModes = new Set();
    this._emit('status', { text: file.remote ? 'Connecting to Google Drive…' : 'Reading file…' });
    const demux = await openDemuxer(file);
    if (token !== this._loadToken) return;
    this.demux = demux;
    this.videoTrack = demux?.tracks.find((t) => t.type === 'video' && t.codecString) || null;
    const audio = demux ? demux.tracks.filter((t) => t.type === 'audio') : [];
    this.audioTrackList = audio;
    this.nativeAudioApi = 'audioTracks' in HTMLMediaElement.prototype;
    const mseOk = mseAvailable() && this.videoTrack && mseSupports(this.videoTrack.mime);
    this.audioTracks = audio.map((t, i) => {
      const mseSupported = !!t.mime && mseSupports(t.mime);
      return { index: i, label: trackLabel(t, i + 1, 'audio'), supported: mseSupported, codec: humanCodec(t.codecString) || t.codecId || '' };
    });
    this.mseOk = !!mseOk;
    if (audioIndex >= audio.length) audioIndex = 0;
    this.audioIndex = audioIndex;

    const nativeOk = nativeContainerSupport(file, demux);
    const needSwitching = audio.length > 1 && !this.nativeAudioApi;
    let mode = 'native';
    if (mseOk && (!nativeOk || needSwitching)) mode = 'mse';
    if (file.remote && !file.nativeUrl) {
      // The <video> element can't send the headers this file needs, so only our own reader can fetch it.
      if (!mseOk) throw new Error('This file can only be streamed with the built-in player, which your browser cannot use for it.');
      mode = 'mse';
    }
    if (!mseOk && needSwitching) {
      // Can't remux: only the default track will play natively.
      this.audioTracks.forEach((t, i) => { if (i !== 0) t.supported = false; t.note = 'switching unavailable'; });
      this.audioIndex = 0;
    }
    if (mode === 'native' && this.nativeAudioApi) this.audioTracks.forEach((t) => { t.supported = true; });
    if (mode === 'native' && !this.nativeAudioApi && audio.length <= 1) this.audioTracks.forEach((t) => { t.supported = true; });

    // Subtitle tracks from the container.
    if (demux) {
      let n = 0;
      for (const t of demux.tracks.filter((x) => x.type === 'subtitle')) {
        n++;
        const id = `e${t.id}`;
        this.subtitles.set(id, { id, label: trackLabel(t, n, 'subtitle'), cues: [], source: 'embedded', progress: t.subFormat ? 0 : 1, unsupported: t.subFormat ? null : t.unsupported, format: t.subFormat });
      }
    }

    await this._start(mode, startTime);
    if (token !== this._loadToken) return;
    this._emit('tracks');
    this._extractSubtitles(token);
  }

  async _start(mode, startTime) {
    // Swapping the source pauses the element; let listeners know it's not the user.
    this._emit('reloading');
    this.engine?.destroy();
    this.engine = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.mode = mode;
    this.triedModes = this.triedModes || new Set();
    this.triedModes.add(mode);
    const metadata = new Promise((resolve) => {
      const done = () => {
        this.video.removeEventListener('loadedmetadata', done);
        this.video.removeEventListener('error', done);
        resolve();
      };
      this.video.addEventListener('loadedmetadata', done);
      this.video.addEventListener('error', done);
      setTimeout(done, 15000);
    });
    if (mode === 'native') {
      if (this.file.remote) this.video.src = this.file.nativeUrl; // the browser streams it by itself
      else {
        this.objectUrl = URL.createObjectURL(this.file);
        this.video.src = this.objectUrl;
      }
      await metadata;
      if (startTime) this.video.currentTime = startTime;
      this._applyNativeAudio();
      for (const tt of this.video.textTracks || []) if (tt !== this.nativeCaptions.track) tt.mode = 'disabled';
    } else {
      const engine = new MseEngine(this.video, this.demux);
      this.engine = engine;
      engine.addEventListener('error', (e) => this._onEngineError(e.detail));
      const at = this.audioTrackList[this.audioIndex];
      const audio = at && this.audioTracks[this.audioIndex]?.supported ? at : null;
      this.mseAudio = audio;
      await engine.start(this.videoTrack, audio, startTime);
      await metadata;
      if (this.audioTrackList.length && !audio) this._emit('notice', { text: 'This audio track cannot be played in your browser — playing without sound.' });
    }
    this._emit('status', { text: '' });
    this._showCues(true); // native caption times depend on the mode
    this._emit('modechange', { mode });
  }

  _applyNativeAudio() {
    const at = this.video.audioTracks;
    if (!at || !at.length) return;
    for (let i = 0; i < at.length; i++) at[i].enabled = i === this.audioIndex;
  }

  async setAudioTrack(index) {
    if (index === this.audioIndex && this.loaded) return;
    this.audioIndex = index;
    if (!this.loaded) return;
    if (this.mode === 'native') {
      this._applyNativeAudio();
    } else {
      const t = this.audioTrackList[index];
      const supported = t && this.audioTracks[index]?.supported;
      const wasPaused = this.video.paused;
      const time = this.time;
      if (supported && this.mseAudio && this.engine && (await this.engine.setAudioTrack(t))) {
        this.mseAudio = t;
      } else {
        // Different set of source buffers: rebuild the pipeline.
        await this._start('mse', time);
        if (!wasPaused) this.video.play().catch(() => {});
      }
      if (!supported && this.mseAudio) this._emit('notice', { text: 'This audio track cannot be played in your browser — playing without sound.' });
    }
    this._emit('tracks');
  }

  setSubtitle(id) {
    this.subtitleId = id;
    this._showCues(true);
    this._emit('tracks');
  }

  set subtitleDelay(v) {
    this.renderer.delay = v;
    this.renderer.key = null;
    this._showCues();
  }

  get subtitleDelay() {
    return this.renderer.delay;
  }

  /** Add an external subtitle file (text). Returns its id. */
  addExternalSubtitle(id, name, text) {
    if (this.subtitles.has(id)) return id;
    const cues = parseSubtitleFile(name, text);
    const label = name.replace(/\.(srt|vtt|ass|ssa|sub|txt)$/i, '');
    this.subtitles.set(id, { id, label, cues, source: 'external', progress: 1 });
    if (this.subtitleId === id) this._showCues(true);
    this._emit('tracks');
    return id;
  }

  /** Remote files: wait until the movie itself has started buffering, so subtitles don't compete with it. */
  async _waitForBuffer(token) {
    const v = this.video;
    for (let i = 0; i < 40 && token === this._loadToken; i++) {
      const b = v.buffered;
      if (b.length && b.end(b.length - 1) - v.currentTime >= 8) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async _extractSubtitles(token) {
    const pending = [...this.subtitles.values()].filter((s) => s.source === 'embedded' && s.format);
    if (!pending.length || !this.demux) return;
    const remote = !!this.file.remote;
    this.extractAbort = new AbortController();
    const byId = new Map(pending.map((s) => [Number(s.id.slice(1)), s]));
    let lastEmit = 0;
    let skipped = [];
    try {
      if (remote) {
        await this._waitForBuffer(token);
        if (token !== this._loadToken) return;
      }
      skipped = await this.demux.extractSubtitles(
        (trackId, cues) => {
          const s = byId.get(trackId);
          if (!s) return;
          for (const c of cues) {
            const n = normalizeEmbeddedCue(s.format, c);
            if (n) s.cues.push(n);
          }
          s.cues = sortCues(s.cues);
          if (this.subtitleId === s.id) this._showCues();
        },
        (p) => {
          for (const s of pending) s.progress = p;
          const now = performance.now();
          if (now - lastEmit > 500 || p >= 1) {
            lastEmit = now;
            this._emit('tracks');
          }
        },
        this.extractAbort.signal,
        { remote },
      ) || [];
    } catch (err) {
      console.warn('Subtitle extraction failed', err);
    }
    if (token !== this._loadToken) return;
    if (skipped.length) {
      // Reading them would download a large part of the movie.
      for (const id of skipped) {
        const s = byId.get(id);
        if (s) s.unsupported = 'not available when streaming';
      }
      this._emit('notice', { text: 'Embedded subtitles can\u2019t be read while streaming from Google Drive. Add an .srt next to the movie and load it from the subtitle menu.' });
    }
    for (const s of pending) {
      s.progress = 1;
      // Close gaps for cues without durations (end = next start).
      for (let i = 0; i < s.cues.length - 1; i++) {
        if (s.cues[i].end > s.cues[i + 1].start && s.cues[i].end - s.cues[i].start === 4) s.cues[i].end = s.cues[i + 1].start;
      }
    }
    if (this.subtitleId && byId.has(Number(this.subtitleId.slice(1)))) this._showCues(true);
    this._emit('tracks');
  }

  async _onVideoError() {
    if (!this.file) return;
    const err = this.video.error;
    console.warn('Video error', err);
    const time = this.time;
    if (this.mode === 'native' && this.mseOk && !this.triedModes.has('mse')) {
      this._emit('notice', { text: 'Native playback failed, switching to the built-in player…' });
      await this._start('mse', time);
      this._emit('tracks');
      return;
    }
    if (this.mode === 'mse' && !this.triedModes.has('native') && (!this.file.remote || this.file.nativeUrl)) {
      await this._start('native', time);
      this._emit('tracks');
      return;
    }
    this._emit('fatal', { text: 'Your browser cannot play this file' + (err?.message ? `: ${err.message}` : '.') });
  }

  _onEngineError(err) {
    if (err?.remote) {
      // Reading the remote file failed (quota, network...). Switching players would not help
      // and would only repeat the failing requests: tell the user; the feeder retries on its own.
      this._emit('notice', { text: err.message });
      return;
    }
    this._onVideoError();
  }
}
