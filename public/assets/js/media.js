// Local camera / microphone handling.

const VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } };

export class LocalMedia extends EventTarget {
  constructor(prefs = {}) {
    super();
    this.audioTrack = null;
    this.videoTrack = null;
    this.micOn = prefs.mic !== false;
    this.camOn = prefs.cam !== false;
    this.deviceIds = { audio: prefs.audioDevice || '', video: prefs.videoDevice || '' };
    this.processing = prefs.processing !== false;
    this.errors = { audio: null, video: null };
  }

  _emit(kind) {
    this.dispatchEvent(new CustomEvent('change', { detail: { kind } }));
  }

  _audioConstraints() {
    const c = { echoCancellation: this.processing, noiseSuppression: this.processing, autoGainControl: this.processing };
    if (this.deviceIds.audio) c.deviceId = { exact: this.deviceIds.audio };
    return c;
  }

  _videoConstraints() {
    const c = { ...VIDEO_CONSTRAINTS };
    if (this.deviceIds.video) c.deviceId = { exact: this.deviceIds.video };
    return c;
  }

  async _get(kind) {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('Camera and microphone need HTTPS.'), { name: 'NotSupportedError' });
    const constraints = kind === 'audio' ? { audio: this._audioConstraints() } : { video: this._videoConstraints() };
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      return s.getTracks()[0];
    } catch (err) {
      if (err.name === 'OverconstrainedError' && this.deviceIds[kind]) {
        // Saved device is gone: fall back to the default one.
        this.deviceIds[kind] = '';
        return this._get(kind);
      }
      throw err;
    }
  }

  /** Acquire devices according to the current on/off preferences. */
  async init() {
    // Ask for both at once so the browser shows a single permission prompt.
    if (this.micOn || this.camOn) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: this._audioConstraints(),
          video: this.camOn ? this._videoConstraints() : false,
        });
        this.audioTrack = s.getAudioTracks()[0] || null;
        this.videoTrack = s.getVideoTracks()[0] || null;
      } catch {
        // Try separately: maybe only one device exists or is allowed.
        await this._acquire('audio');
        if (this.camOn) await this._acquire('video');
      }
    } else {
      await this._acquire('audio');
    }
    if (this.audioTrack) this.audioTrack.enabled = this.micOn;
    this._watchEnded();
    this._emit('audio');
    this._emit('video');
  }

  async _acquire(kind) {
    try {
      const t = await this._get(kind);
      this.errors[kind] = null;
      if (kind === 'audio') this.audioTrack = t;
      else this.videoTrack = t;
      return t;
    } catch (err) {
      this.errors[kind] = err;
      return null;
    }
  }

  _watchEnded() {
    for (const t of [this.audioTrack, this.videoTrack]) {
      if (t && !t._watched) {
        t._watched = true;
        t.addEventListener('ended', () => {
          if (t === this.videoTrack) {
            this.videoTrack = null;
            this.camOn = false;
            this._emit('video');
          } else if (t === this.audioTrack) {
            this.audioTrack = null;
            this._emit('audio');
          }
        });
      }
    }
  }

  async setMic(on) {
    this.micOn = on;
    if (on && !this.audioTrack) await this._acquire('audio');
    if (this.audioTrack) this.audioTrack.enabled = on;
    this._watchEnded();
    this._emit('audio');
    return !!this.audioTrack || !on;
  }

  async setCam(on) {
    this.camOn = on;
    if (on) {
      if (!this.videoTrack) await this._acquire('video');
      if (!this.videoTrack) this.camOn = false;
    } else if (this.videoTrack) {
      this.videoTrack.stop(); // turn the camera light off
      this.videoTrack = null;
    }
    this._watchEnded();
    this._emit('video');
    return this.camOn === on;
  }

  async setDevice(kind, deviceId) {
    this.deviceIds[kind] = deviceId;
    if (kind === 'audio') {
      const old = this.audioTrack;
      const t = await this._acquire('audio');
      if (t) {
        old?.stop();
        t.enabled = this.micOn;
      }
    } else if (this.camOn) {
      const old = this.videoTrack;
      const t = await this._acquire('video');
      if (t) old?.stop();
    }
    this._watchEnded();
    this._emit(kind);
  }

  async setProcessing(on) {
    this.processing = on;
    if (this.audioTrack) {
      try {
        await this.audioTrack.applyConstraints(this._audioConstraints());
      } catch {
        await this.setDevice('audio', this.deviceIds.audio);
      }
    }
  }

  async devices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return {
        audio: list.filter((d) => d.kind === 'audioinput'),
        video: list.filter((d) => d.kind === 'videoinput'),
      };
    } catch {
      return { audio: [], video: [] };
    }
  }

  currentDeviceId(kind) {
    const t = kind === 'audio' ? this.audioTrack : this.videoTrack;
    return t?.getSettings?.().deviceId || this.deviceIds[kind] || '';
  }

  stop() {
    this.audioTrack?.stop();
    this.videoTrack?.stop();
    this.audioTrack = null;
    this.videoTrack = null;
  }
}

// ---- Audio level metering (speaking indicators) ---------------------------
let ctx = null;
export function audioContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Calls cb(level 0..1) ~15 times a second. Returns a stop function. */
export function watchLevel(track, cb) {
  const ac = audioContext();
  if (!ac || !track) return () => {};
  let src;
  try {
    src = ac.createMediaStreamSource(new MediaStream([track]));
  } catch {
    return () => {};
  }
  const an = ac.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Uint8Array(an.fftSize);
  const timer = setInterval(() => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    cb(Math.min(1, Math.sqrt(sum / buf.length) * 4));
  }, 66);
  return () => {
    clearInterval(timer);
    try {
      src.disconnect();
    } catch {
      /* ignore */
    }
  };
}
