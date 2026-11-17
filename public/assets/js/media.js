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

  /**
   * Acquire devices according to the current on/off preferences. A device that is switched off is not
   * requested at all (no permission prompt, no recording indicator); setMic()/setCam() acquire it on demand.
   */
  async init() {
    if (this.micOn || this.camOn) {
      // Ask for both at once so the browser shows a single permission prompt.
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: this.micOn ? this._audioConstraints() : false,
          video: this.camOn ? this._videoConstraints() : false,
        });
        this._adopt('audio', s.getAudioTracks()[0]);
        this._adopt('video', s.getVideoTracks()[0]);
      } catch {
        // Try separately: maybe only one device exists or is allowed.
        if (this.micOn) await this._acquire('audio');
        if (this.camOn) await this._acquire('video');
      }
    }
    // The page may have been left while the permission prompt was open: don't keep the devices then.
    if (this.stopped) {
      this.stop();
      return;
    }
    if (this.audioTrack) this.audioTrack.enabled = this.micOn;
    this._watchEnded();
    this._emit('audio');
    this._emit('video');
  }

  /**
   * Keep a track that getUserMedia delivered, or stop it. The settings may have changed while the request was
   * pending (the room's toolbar is live during the permission prompt): after leaving, or with the camera
   * switched off, the track is dropped; if another request already delivered one, so is the extra (unless
   * `replace`, which swaps the current track for the new one). Returns the kept track or null.
   */
  _adopt(kind, t, replace = false) {
    if (!t) return null;
    const prop = kind === 'audio' ? 'audioTrack' : 'videoTrack';
    if (this.stopped || (kind === 'video' && !this.camOn) || (this[prop] && !replace)) {
      t.stop();
      return null;
    }
    if (this[prop]) this[prop].stop();
    this[prop] = t;
    if (kind === 'audio') t.enabled = this.micOn;
    return t;
  }

  async _acquire(kind, replace = false) {
    try {
      const t = await this._get(kind);
      this.errors[kind] = null;
      return this._adopt(kind, t, replace);
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
    if (this.audioTrack) this.audioTrack.enabled = this.micOn;
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
    // replace: the new track takes over from the current one (which is stopped), if the device could be opened.
    if (kind === 'audio') await this._acquire('audio', true);
    else if (this.camOn) await this._acquire('video', true);
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
    this.stopped = true;
    this.audioTrack?.stop();
    this.videoTrack?.stop();
    this.audioTrack = null;
    this.videoTrack = null;
  }
}

// ---- Screen sharing ---------------------------------------------------------
// The browser's own picker chooses what is shared: the entire screen, one window (an app) or a tab.
// Video only: an audio track the browser hands over anyway is stopped at once.
const SCREEN_CONSTRAINTS = {
  video: { frameRate: { ideal: 15, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
  audio: false,
  selfBrowserSurface: 'exclude', // not this tab: it would show the call inside itself
  surfaceSwitching: 'include',
  monitorTypeSurfaces: 'include',
};

export class ScreenShare extends EventTarget {
  constructor() {
    super();
    this.track = null;
    this.pending = false; // the picker is open
    this.stopped = false;
  }

  static get supported() {
    return !!navigator.mediaDevices?.getDisplayMedia;
  }

  get active() {
    return !!this.track;
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }

  /** Open the picker (needs a user gesture). Resolves to the track, or null if the share was dropped meanwhile. */
  async start() {
    if (this.track || this.pending || this.stopped) return this.track;
    this.pending = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(SCREEN_CONSTRAINTS);
    } finally {
      this.pending = false;
    }
    for (const t of stream.getAudioTracks()) t.stop();
    const t = stream.getVideoTracks()[0];
    if (!t || this.stopped || this.track) {
      t?.stop();
      return this.track;
    }
    try {
      t.contentHint = 'detail'; // keep text sharp
    } catch {
      /* not supported */
    }
    // The browser's own "Stop sharing" button ends the track.
    t.addEventListener('ended', () => {
      if (this.track === t) this.stop();
    });
    this.track = t;
    this._emit();
    return t;
  }

  stop() {
    const t = this.track;
    if (!t) return;
    this.track = null;
    t.stop();
    this._emit();
  }

  /** Leaving the room: stop, and refuse a picker that is still open. */
  destroy() {
    this.stopped = true;
    this.stop();
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
