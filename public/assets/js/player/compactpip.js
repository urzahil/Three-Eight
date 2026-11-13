// Compact picture-in-picture (Chrome/Edge): the browser's native video PiP
// window has no title bar, but it does not render caption tracks. So the movie
// frame and OUR subtitles are drawn onto a canvas, and the canvas stream goes
// into the native PiP window through a hidden proxy <video>.
import { activeCues } from './subtitles.js';

const MAX_WIDTH = 1280;
const FPS = 30;
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/** Parse our mini markup (<i>, <b>, <u>, "\n") into lines of styled runs, without the DOM. */
export function parseMarkup(text) {
  const lines = [[]];
  const style = { i: 0, b: 0, u: 0 };
  const re = /<(\/?)([ibu])>/g;
  let last = 0;
  let m;
  const add = (s) => {
    s.split('\n').forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, i: style.i > 0, b: style.b > 0, u: style.u > 0 });
    });
  };
  while ((m = re.exec(text))) {
    add(text.slice(last, m.index));
    last = re.lastIndex;
    style[m[2]] = Math.max(0, style[m[2]] + (m[1] ? -1 : 1));
  }
  add(text.slice(last));
  return lines;
}

export function plainText(text) {
  return text.replace(/<\/?[ibu]>/g, '');
}

export class CompactPip extends EventTarget {
  constructor(player, { subScale = 1 } = {}) {
    super();
    this.player = player;
    this.subScale = subScale;
    this.active = false;
    this.lastText = '';
    this.canvas = null;
    this.proxy = null;
    this._ctx = null;
    this._worker = null;
    this._workerUrl = null;
    this._timer = 0;
    this._selfUntil = 0; // proxy play/pause events before this time were caused by us
    this._closed = false;
  }

  setSubScale(v) {
    this.subScale = Number(v) || 1;
  }

  /** Call directly from a click/keydown handler: requestPictureInPicture needs user activation. */
  async open() {
    if (this.active) return;
    const video = this.player.video;
    let w = video.videoWidth || 1280;
    let h = video.videoHeight || 720;
    if (w > MAX_WIDTH) {
      h = Math.round(h * MAX_WIDTH / w);
      w = MAX_WIDTH;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    this.canvas = canvas;
    this._ctx = canvas.getContext('2d');
    const rootStyle = getComputedStyle(document.documentElement);
    const themed = (name, fallback) => rootStyle.getPropertyValue(name).trim() || fallback;
    this._colors = { text: themed('--sub-text', '#fff'), outline: themed('--sub-outline', '#000'), bg: themed('--video-bg', '#000') };
    this._closed = false;
    this._draw();

    const proxy = document.createElement('video');
    proxy.muted = true;
    proxy.playsInline = true;
    proxy.setAttribute('aria-hidden', 'true');
    proxy.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    proxy.srcObject = canvas.captureStream(FPS);
    document.body.append(proxy);
    this.proxy = proxy;
    proxy.addEventListener('pause', () => this._onProxyEvent('pause'));
    proxy.addEventListener('play', () => this._onProxyEvent('play'));
    proxy.addEventListener('leavepictureinpicture', () => this.close(), { once: true });
    try {
      await this._play();
      await proxy.requestPictureInPicture();
    } catch (err) {
      this.close();
      throw err;
    }
    if (this._closed) return;
    this.active = true;
    this._startLoop();
    this.dispatchEvent(new Event('open'));
  }

  _play() {
    this._selfUntil = performance.now() + 600;
    return this.proxy.play();
  }

  _onProxyEvent(kind) {
    if (!this.proxy || this._closed || performance.now() < this._selfUntil) return;
    this.dispatchEvent(new Event(kind === 'pause' ? 'userpause' : 'userplay'));
  }

  /** Keep the PiP picture updating after the PiP UI paused the proxy element. */
  resume() {
    if (this.proxy && this.proxy.paused && !this._closed) this._play().catch(() => {});
  }

  _startLoop() {
    try {
      const src = `const t=setInterval(()=>postMessage(0),${Math.round(1000 / FPS)});onmessage=()=>clearInterval(t);`;
      this._workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      this._worker = new Worker(this._workerUrl);
      this._worker.onmessage = () => this._draw();
    } catch {
      this._worker = null;
      const loop = () => {
        this._draw();
        this._timer = setTimeout(loop, 1000 / FPS);
      };
      loop();
    }
  }

  _draw() {
    const ctx = this._ctx;
    if (!ctx || this._closed) return;
    const { canvas } = this;
    const video = this.player.video;
    const cw = canvas.width, ch = canvas.height;
    ctx.fillStyle = this._colors.bg;
    ctx.fillRect(0, 0, cw, ch);
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh && video.readyState >= 2) {
      const scale = Math.min(cw / vw, ch / vh);
      const dw = vw * scale, dh = vh * scale;
      try {
        ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      } catch {
        /* frame not available */
      }
    }
    const r = this.player.renderer;
    const cues = r.cues.length ? activeCues(r.cues, this.player.time - r.delay) : [];
    this.lastText = cues.map((c) => plainText(c.text)).join('\n');
    if (cues.length) this._drawCues(cues);
  }

  _drawCues(cues) {
    const ctx = this._ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    const fs = Math.round(ch * 0.052 * this.subScale);
    const lineH = Math.round(fs * 1.25);
    const maxW = cw * 0.9;
    const build = (list) => list.flatMap((c) => parseMarkup(c.text).flatMap((line) => this._wrap(line, fs, maxW)));
    const bottom = build(cues.filter((c) => !c.top));
    const top = build(cues.filter((c) => c.top));
    ctx.lineJoin = 'round';
    ctx.textBaseline = 'alphabetic';
    // Bottom: the last line sits 6% above the bottom edge, earlier lines stack upward.
    let y = ch - ch * 0.06;
    for (let k = bottom.length - 1; k >= 0; k--) {
      this._drawLine(bottom[k], cw / 2, y - Math.round(fs * 0.25), fs);
      y -= lineH;
    }
    y = ch * 0.05 + lineH;
    for (const line of top) {
      this._drawLine(line, cw / 2, y - Math.round(fs * 0.25), fs);
      y += lineH;
    }
  }

  _font(run, fs) {
    return `${run.i ? 'italic ' : ''}${run.b ? 700 : 600} ${fs}px ${FONT_FAMILY}`;
  }

  /** Word-wrap one line of runs to maxW. Returns lines of {text, i, b, u, width} pieces. */
  _wrap(runs, fs, maxW) {
    const ctx = this._ctx;
    const out = [];
    let cur = [];
    let curW = 0;
    for (const run of runs) {
      ctx.font = this._font(run, fs);
      // Words with their trailing spaces (no lookbehind: older Safari can't parse it).
      for (const word of run.text.match(/[^ ]+ *| +/g) || []) {
        const width = ctx.measureText(word).width;
        if (curW + width > maxW && cur.length && word.trim()) {
          out.push(cur);
          cur = [];
          curW = 0;
        }
        const piece = cur.length ? word : word.replace(/^ +/, '');
        const pw = piece === word ? width : ctx.measureText(piece).width;
        cur.push({ ...run, text: piece, width: pw });
        curW += pw;
      }
    }
    out.push(cur);
    return out;
  }

  _drawLine(pieces, cx, baseline, fs) {
    const ctx = this._ctx;
    const total = pieces.reduce((s, p) => s + p.width, 0);
    let x = cx - total / 2;
    ctx.textAlign = 'left';
    for (const p of pieces) {
      ctx.font = this._font(p, fs);
      ctx.lineWidth = fs * 0.16;
      ctx.strokeStyle = this._colors.outline;
      ctx.fillStyle = this._colors.text;
      ctx.strokeText(p.text, x, baseline);
      ctx.fillText(p.text, x, baseline);
      if (p.u) {
        const uy = baseline + Math.max(2, Math.round(fs * 0.08));
        ctx.fillRect(x, uy, p.width, Math.max(1, Math.round(fs * 0.06)));
      }
      x += p.width;
    }
  }

  close() {
    if (this._closed && !this.proxy) return;
    this._closed = true;
    const wasActive = this.active;
    this.active = false;
    if (this._worker) {
      try {
        this._worker.postMessage('stop');
      } catch {
        /* ignore */
      }
      this._worker.terminate();
      this._worker = null;
    }
    if (this._workerUrl) URL.revokeObjectURL(this._workerUrl);
    this._workerUrl = null;
    clearTimeout(this._timer);
    const proxy = this.proxy;
    this.proxy = null;
    if (proxy) {
      if (document.pictureInPictureElement === proxy) document.exitPictureInPicture().catch(() => {});
      proxy.srcObject?.getTracks().forEach((t) => t.stop());
      proxy.srcObject = null;
      proxy.remove();
    }
    this.canvas?.remove();
    this.canvas = null;
    this._ctx = null;
    this.lastText = '';
    if (wasActive || proxy) this.dispatchEvent(new Event('close'));
  }
}
