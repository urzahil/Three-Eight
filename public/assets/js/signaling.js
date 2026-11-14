// WebSocket client for the signaling server: room join, WebRTC signal relay,
// automatic reconnection and clock synchronization.

const localNow = () => performance.timeOrigin + performance.now();

export class Signaling extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.joinInfo = null;
    this.joined = false;
    this.closed = false;
    this.retry = 0;
    this.samples = [];
    this.offset = 0; // serverTime - localTime (ms)
    this._timeTimer = null;
  }

  /** Estimated server clock (ms since epoch). Shared by every participant. */
  now() {
    return localNow() + this.offset;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Connect and join. Resolves with the welcome message, rejects on auth errors. */
  join(info) {
    this.joinInfo = info;
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this._open();
    });
  }

  _open() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this._syncClock(6);
      ws.send(JSON.stringify({ type: 'join', ...this.joinInfo }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._handle(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      const wasJoined = this.joined;
      this.joined = false;
      clearInterval(this._timeTimer);
      if (this.closed || this._fatal) return;
      if (ev.code === 4000) return; // replaced by a newer connection of ours
      if (wasJoined) this._emit('disconnected');
      const delay = Math.min(15000, 500 * 2 ** this.retry++);
      setTimeout(() => this._open(), delay);
    };
  }

  _handle(msg) {
    switch (msg.type) {
      case 'time': {
        const t1 = localNow();
        const rtt = t1 - msg.c;
        this.samples.push({ rtt, offset: msg.s - (msg.c + rtt / 2) });
        if (this.samples.length > 12) this.samples.shift();
        const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        this.offset = best.offset;
        break;
      }
      case 'welcome':
        this.joined = true;
        this.id = msg.id;
        clearInterval(this._timeTimer);
        this._timeTimer = setInterval(() => this._syncClock(1), 20000);
        if (this._pending) {
          this._pending.resolve(msg);
          this._pending = null;
        } else this._emit('reconnected', msg);
        break;
      case 'error':
        if (['bad-password', 'no-room', 'room-full', 'rate-limited', 'room-deleted', 'kicked', 'bad-request'].includes(msg.code)) {
          this._fatal = true;
          if (this._pending) {
            this._pending.reject(Object.assign(new Error(msg.message), { code: msg.code }));
            this._pending = null;
          } else this._emit('fatal', msg);
          this.ws?.close();
        }
        break;
      case 'drive':
        // The admin attached, changed or removed the room's Google Drive folder.
        this._emit('drive', msg.drive || null);
        break;
      case 'peer-joined':
        this._emit('peer-joined', msg);
        break;
      case 'peer-left':
        this._emit('peer-left', msg);
        break;
      case 'signal':
        this._emit('signal', msg);
        break;
      default:
        break;
    }
  }

  _syncClock(n) {
    for (let i = 0; i < n; i++) {
      setTimeout(() => this.send({ type: 'time', c: localNow() }), i * 150);
    }
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  signal(to, data) {
    this.send({ type: 'signal', to, data });
  }

  rename(name) {
    if (this.joinInfo) this.joinInfo.name = name;
    this.send({ type: 'rename', name });
  }

  close() {
    this.closed = true;
    clearInterval(this._timeTimer);
    try {
      this.send({ type: 'leave' });
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
