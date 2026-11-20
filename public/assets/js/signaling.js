// WebSocket client for the signaling server: room join, WebRTC signal relay,
// automatic reconnection and clock synchronization.

const localNow = () => performance.timeOrigin + performance.now();

// A join attempt that has not been welcomed by then is abandoned and tried again: on mobile networks a
// socket can die without ever firing 'close', and nothing else would ever end the wait.
const ATTEMPT_MS = 10000;
// The first join gives up (and tells the user) after this long without a welcome.
const JOIN_GIVE_UP_MS = 45000;

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

  /**
   * Connect and join. Resolves with the welcome message; rejects on auth errors, or when the server
   * could not be reached for JOIN_GIVE_UP_MS. Emits 'retrying' ({attempt}) before each new attempt.
   */
  join(info) {
    this.joinInfo = info;
    return new Promise((resolve, reject) => {
      const giveUp = setTimeout(() => {
        this._failPending(Object.assign(new Error('Could not connect to the server. Check your connection and try again.'), { code: 'unreachable' }));
      }, JOIN_GIVE_UP_MS);
      this._pending = {
        resolve: (msg) => { clearTimeout(giveUp); resolve(msg); },
        reject: (err) => { clearTimeout(giveUp); reject(err); },
      };
      this._open();
    });
  }

  /** The first join failed for good: stop reconnecting and report it. */
  _failPending(err) {
    if (!this._pending) return;
    const { reject } = this._pending;
    this._pending = null;
    this.close();
    reject(err);
  }

  _open() {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._failPending(err);
      return;
    }
    this.ws = ws;
    clearTimeout(this._attemptTimer);
    this._attemptTimer = setTimeout(() => {
      // No welcome in time (stalled connect, or a socket that died silently): drop it and reconnect.
      if (this.ws === ws && !this.joined) this._lost(ws);
    }, ATTEMPT_MS);
    ws.onopen = () => {
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
      // Replaced by a newer connection of ours (another tab with our id and secret, e.g. a duplicated tab). Only a
      // joined socket can be replaced; while our first join is still waiting, keep trying rather than wait forever.
      if (ev.code === 4000 && !this._pending) {
        this.joined = false;
        this._fatal = true; // the other tab has the room now: never reconnect from here
        clearInterval(this._timeTimer);
        clearTimeout(this._attemptTimer);
        this._emit('replaced');
        return;
      }
      this._lost(ws);
    };
  }

  /** The connection ws is gone (or given up on): reconnect after a backoff. */
  _lost(ws) {
    if (this.ws !== ws || ws._lost) return;
    ws._lost = true;
    ws.onopen = ws.onmessage = ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    const wasJoined = this.joined;
    this.joined = false;
    clearInterval(this._timeTimer);
    clearTimeout(this._attemptTimer);
    if (this.closed || this._fatal) return;
    if (wasJoined) this._emit('disconnected');
    const delay = Math.min(15000, 500 * 2 ** this.retry++);
    this._emit('retrying', { attempt: this.retry, delay });
    setTimeout(() => this._open(), delay);
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
        this.retry = 0;
        clearTimeout(this._attemptTimer);
        this.id = msg.id;
        clearInterval(this._timeTimer);
        this._timeTimer = setInterval(() => this._syncClock(1), 20000);
        if (this._pending) {
          this._pending.resolve(msg);
          this._pending = null;
        } else this._emit('reconnected', msg);
        break;
      case 'error':
        if (['bad-password', 'no-room', 'room-full', 'rate-limited', 'room-deleted', 'kicked', 'bad-request', 'server-error', 'id-taken'].includes(msg.code)) {
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
      case 'ice':
        // Fresh TURN credentials, sent before the ones from the welcome expire.
        if (Array.isArray(msg.iceServers)) this._emit('ice', msg.iceServers);
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
    clearTimeout(this._attemptTimer);
    try {
      this.send({ type: 'leave' });
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
