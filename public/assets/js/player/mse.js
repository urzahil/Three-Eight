// Media Source Extensions engine: remuxes the selected video + audio track of a
// local file into fragmented MP4 on the fly, so any audio track can be chosen
// in any browser (Chrome and Firefox don't expose HTMLMediaElement.audioTracks).
//
// All media timestamps are shifted by SHIFT seconds so that decode timestamps
// (which can be slightly negative with B-frames / edit lists) stay positive.
// The Player converts between movie time and element time.

import { initSegment, fragment } from './fmp4.js';

export const SHIFT = 10;
const AHEAD = 40; // seconds buffered ahead of the playhead
const BEHIND = 20; // seconds kept behind the playhead

const MS = window.ManagedMediaSource || window.MediaSource;

export function mseAvailable() {
  return !!MS;
}

export function mseSupports(mime) {
  try {
    return !!MS && MS.isTypeSupported(mime);
  } catch {
    return false;
  }
}

function waitUpdate(sb) {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('SourceBuffer error')); };
    const cleanup = () => {
      sb.removeEventListener('updateend', ok);
      sb.removeEventListener('error', bad);
    };
    sb.addEventListener('updateend', ok);
    sb.addEventListener('error', bad);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Feeder {
  constructor(engine, track) {
    this.engine = engine;
    this.track = track;
    this.sb = null;
    this.cursor = null;
    this.seq = 1;
    this.gen = 0;
    this.eos = false;
    this.ahead = AHEAD;
    this.lastEnd = -1; // element time of the end of the last appended fragment
  }

  async _whenIdle() {
    while (this.sb.updating) await waitUpdate(this.sb).catch(() => {});
  }

  async _append(data, gen) {
    for (let attempt = 0; ; attempt++) {
      await this._whenIdle();
      if (gen !== this.gen || this.engine.destroyed) return false;
      try {
        this.sb.appendBuffer(data);
        await waitUpdate(this.sb);
        return true;
      } catch (err) {
        if (err.name !== 'QuotaExceededError' || attempt > 20) throw err;
        // Buffer full: drop what's behind the playhead and keep less ahead.
        this.ahead = Math.max(10, this.ahead * 0.7);
        const t = this.engine.video.currentTime;
        await this._remove(0, Math.max(0, t - 3));
        await sleep(500);
      }
    }
  }

  async _remove(start, end) {
    if (end <= start) return;
    await this._whenIdle();
    try {
      this.sb.remove(start, end);
      await waitUpdate(this.sb);
    } catch {
      /* ignore */
    }
  }

  bufferedAhead(t) {
    const b = this.sb.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) - 0.3 <= t && b.end(i) >= t) return b.end(i) - t;
    }
    return 0;
  }

  /** Is element-time t inside the range we are currently extending? */
  continuousAt(t) {
    const b = this.sb.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) - 0.3 <= t && b.end(i) >= t) return Math.abs(b.end(i) - this.lastEnd) < 1.5 || this.eos;
    }
    return false;
  }

  reposition(movieTime) {
    this.gen++;
    this.cursor = this.engine.demux.createCursor(this.track.id);
    this.cursor.seek(Math.max(0, movieTime));
    this.eos = false;
    this.failed = false;
    this.lastEnd = -1;
    this.positionedAt = movieTime;
    this.engine.wake();
  }

  async switchTrack(track, movieTime) {
    this.gen++;
    const gen = this.gen;
    this.track = track;
    await this._whenIdle();
    try {
      if (this.engine.ms.readyState === 'open') this.sb.abort();
    } catch {
      /* ignore */
    }
    await this._remove(0, Infinity);
    if (gen !== this.gen) return;
    if (track.mime !== this.mime) {
      this.sb.changeType(track.mime);
      this.mime = track.mime;
    }
    this.seq = 1;
    await this._append(initSegment(track), gen);
    if (gen !== this.gen) return;
    this.reposition(movieTime);
  }

  async run() {
    const engine = this.engine;
    while (!engine.destroyed) {
      const gen = this.gen;
      const t = engine.video.currentTime;
      if (!this.cursor || this.eos || this.failed || this.bufferedAhead(t) > this.ahead) {
        await engine.waitWake(250);
        continue;
      }
      let batch;
      try {
        batch = await this.cursor.next();
      } catch (err) {
        if (gen !== this.gen) continue; // we moved on (seek); the error belongs to the old position
        if (!err?.remote) {
          engine.fail(err);
          return;
        }
        // Reading the remote file failed even after the file's own retries. Tell the user, then
        // try again from the playhead (a few times, unless retrying cannot help). A seek
        // retries too, because reposition() clears the failed state.
        engine.fail(err);
        this.failures = (this.failures || 0) + 1;
        if (err.permanent || this.failures > 2) this.failed = true;
        else {
          await engine.waitWake(4000);
          if (gen === this.gen) this.reposition(Math.max(0, engine.video.currentTime - SHIFT));
        }
        continue;
      }
      this.failures = 0;
      if (gen !== this.gen) continue;
      if (!batch || !batch.samples.length) {
        this.eos = true;
        engine.checkEnd();
        continue;
      }
      const shift = SHIFT * batch.timescale;
      const samples = batch.samples.map((s) => ({ ...s, dts: s.dts + shift, pts: s.pts + shift }));
      try {
        const ok = await this._append(fragment(this.seq++, samples), gen);
        if (!ok) continue;
      } catch (err) {
        engine.fail(err);
        return;
      }
      const last = samples[samples.length - 1];
      this.lastEnd = (last.pts + last.duration) / batch.timescale;
      // Evict old data behind the playhead.
      const now = engine.video.currentTime;
      const b = this.sb.buffered;
      if (b.length && now - b.start(0) > BEHIND + 10) await this._remove(0, now - BEHIND);
    }
  }
}

export class MseEngine extends EventTarget {
  constructor(video, demux) {
    super();
    this.video = video;
    this.demux = demux;
    this.destroyed = false;
    this.feeders = [];
    this._wakers = [];
    this._onSeeking = () => this._seeking();
  }

  wake() {
    const w = this._wakers;
    this._wakers = [];
    for (const f of w) f();
  }

  waitWake(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this._wakers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Open the MediaSource and start streaming. Resolves once ready to seek. */
  async start(videoTrack, audioTrack, movieTime = 0) {
    this.ms = new MS();
    if (window.ManagedMediaSource && this.ms instanceof window.ManagedMediaSource) this.video.disableRemotePlayback = true;
    this.url = URL.createObjectURL(this.ms);
    this.video.removeAttribute('src');
    this.video.src = this.url;
    await new Promise((resolve) => this.ms.addEventListener('sourceopen', resolve, { once: true }));
    if (this.destroyed) return;
    const tracks = [videoTrack, audioTrack].filter(Boolean);
    for (const t of tracks) {
      const f = new Feeder(this, t);
      this.feeders.push(f);
    }
    // Add every SourceBuffer before appending anything (required by Safari).
    for (const f of this.feeders) {
      f.mime = f.track.mime;
      f.sb = this.ms.addSourceBuffer(f.track.mime);
    }
    this.ms.duration = (this.demux.duration || 0) + SHIFT;
    for (const f of this.feeders) await f._append(initSegment(f.track), f.gen);
    for (const f of this.feeders) f.reposition(movieTime);
    this.video.addEventListener('seeking', this._onSeeking);
    this.video.currentTime = movieTime + SHIFT;
    for (const f of this.feeders) f.run();
  }

  _seeking() {
    const t = this.video.currentTime;
    const movie = t - SHIFT;
    for (const f of this.feeders) {
      if (f.positionedAt != null && f.lastEnd < 0 && Math.abs(f.positionedAt - movie) < 0.05) continue;
      if (f.failed || !f.continuousAt(t)) f.reposition(movie);
    }
    this.wake();
  }

  get audioFeeder() {
    return this.feeders.find((f) => f.track.type === 'audio');
  }

  async setAudioTrack(track) {
    const f = this.audioFeeder;
    if (!f) return false;
    if (track.mime !== f.mime && !('changeType' in SourceBuffer.prototype)) return false;
    await f.switchTrack(track, this.video.currentTime - SHIFT);
    return true;
  }

  checkEnd() {
    if (this.feeders.every((f) => f.eos) && this.ms.readyState === 'open' && this.feeders.every((f) => !f.sb.updating)) {
      try {
        this.ms.endOfStream();
      } catch {
        /* ignore */
      }
    }
  }

  fail(err) {
    if (this.destroyed) return;
    console.error('MSE error', err);
    this.dispatchEvent(new CustomEvent('error', { detail: err }));
  }

  destroy() {
    this.destroyed = true;
    this.wake();
    this.video.removeEventListener('seeking', this._onSeeking);
    try {
      if (this.ms && this.ms.readyState === 'open') this.ms.endOfStream();
    } catch {
      /* ignore */
    }
    if (this.url) URL.revokeObjectURL(this.url);
  }
}
