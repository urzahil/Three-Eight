// Full-mesh WebRTC: one RTCPeerConnection per remote participant.
// Audio/video and data (chat, movie sync) go directly browser-to-browser;
// the server only relays the initial handshake.

const CHUNK = 12 * 1024;

// Limits for chunked JSON messages on the data channel. A peer is not trusted: everything it sends is
// bounded, so a malicious one cannot make us allocate or loop without limit.
// sync.js accepts subtitle text up to 5 MiB; JSON escaping can inflate it, so the cap sits well above that.
const MAX_MESSAGE = 12 * 1024 * 1024; // chars of one reassembled message
const MAX_CHUNKS = Math.ceil(MAX_MESSAGE / CHUNK);
const MAX_MID = 32; // chars of a message id
const MAX_ASSEMBLIES = 12; // messages being reassembled at once, per peer
const MAX_BUFFERED = 2 * MAX_MESSAGE; // chars held by all unfinished messages of a peer
// Chars waiting in a ChunkSender queue. A peer that stops reading would otherwise make it grow without end;
// past this the link is treated as stuck (see ChunkSender.onoverflow).
export const MAX_QUEUED = 2 * MAX_MESSAGE;
const ASSEMBLY_TIMEOUT_MS = 30 * 1000; // an unfinished message is dropped when its last chunk is this old

// The JSON channel queues outgoing chunks while more than DATA_HIGH bytes are buffered, like the film channel.
const DATA_HIGH = 1024 * 1024;
const DATA_LOW = 256 * 1024;

// The film channel carries binary film pieces only, so they never queue up in front of chat and sync
// messages on the JSON channel. Sends wait in a queue while more than FILM_HIGH bytes are buffered; small
// control messages (`urgent`: a request, a refusal, a cancel) skip that queue, so they wait behind at most
// FILM_HIGH bytes of pieces, not behind every piece queued for that friend.
const FILM_HIGH = 1024 * 1024;
const FILM_LOW = 256 * 1024;

// Rebuilding a link: at most MAX_REBUILDS in a row without the channel opening, at least MIN_REBUILD_MS apart.
const MAX_REBUILDS = 6;
const MIN_REBUILD_MS = 1000;
// The attempt counter decays: when the last rebuild of a peer is older than this, it starts from zero again.
// Longer than the longest backoff delay (8000 * 2**3 = 64 s on the higher-id side), or that side would reset before the cap.
const REBUILD_DECAY_MS = 5 * 60 * 1000;
// A local offer that is still unanswered after this long is considered lost (a normal answer takes a round trip).
const OFFER_STALE_MS = 3000;
// Offers from one peer that we take per OFFER_WINDOW_MS; more are ignored. A peer offers when the link is set up or
// rebuilt, when it first shares its screen, and when ICE restarts: a few times a minute, up to about 10 on a link that
// keeps failing (MAX_REBUILDS rebuilds, a few watchdog restarts). Each answer (and the candidates after it) counts
// against our signaling budget on the server, so a peer that kept offering could otherwise make us send more than the
// budget allows, and have our signals to everyone dropped. At 20 a minute, the others of a full room of 12 cannot.
export const MAX_OFFERS_PER_PEER = 20;
export const OFFER_WINDOW_MS = 60 * 1000;

// Upload budget per outgoing video stream, by number of remote peers:
// in a mesh every participant uploads one copy per peer.
function videoBudget(peerCount, lowPower) {
  let kbps;
  if (peerCount <= 1) kbps = 1500;
  else if (peerCount === 2) kbps = 1000;
  else if (peerCount <= 4) kbps = 600;
  else kbps = 350;
  if (lowPower) kbps = Math.min(kbps, 400);
  return kbps * 1000;
}

// A shared screen gets most of the upload while it is on (text needs bits), and the sharer's camera less.
export function screenBudget(peerCount, lowPower) {
  let kbps;
  if (peerCount <= 1) kbps = 2500;
  else if (peerCount === 2) kbps = 1800;
  else if (peerCount <= 4) kbps = 1000;
  else kbps = 600;
  if (lowPower) kbps = Math.min(kbps, 800);
  return kbps * 1000;
}
const CAMERA_WHILE_SHARING = 250 * 1000;

/**
 * Tell a peer's camera from its shared screen. Both arrive as video tracks; the sender puts its camera and
 * microphone in one stream and the screen in another, so the camera is the video track of the stream that
 * also carries the audio. `videoBySid` maps stream id -> video track, in arrival order (latest last).
 * Returns { camera, screen } (tracks or null).
 */
export function routeVideo(audioSid, videoBySid) {
  let cameraSid;
  if (audioSid !== null && audioSid !== undefined) cameraSid = audioSid;
  else cameraSid = videoBySid.keys().next().value; // no audio seen yet: the first video is the camera
  let camera = null;
  let screen = null;
  for (const [sid, track] of videoBySid) {
    if (sid === cameraSid) camera = track;
    else screen = track; // the latest other stream
  }
  return { camera, screen };
}

/**
 * Puts the chunks of one message back together. Strict on purpose: the first chunk of a message id fixes its
 * chunk count, every chunk must be in range with a bounded size, and unfinished messages are limited in
 * number, in total size and in age (the oldest are dropped first).
 */
export class Reassembler {
  constructor() {
    this.parts = new Map(); // mid -> { n, parts: string[], got, chars, last }
    this.total = 0; // chars held in all assemblies
  }

  _drop(mid) {
    const a = this.parts.get(mid);
    if (!a) return;
    this.total -= a.chars;
    this.parts.delete(mid);
  }

  /** Drop assemblies whose last chunk is older than the timeout. */
  sweep(now = Date.now()) {
    for (const [mid, a] of this.parts) if (now - a.last > ASSEMBLY_TIMEOUT_MS) this._drop(mid);
  }

  clear() {
    this.parts.clear();
    this.total = 0;
  }

  /** Take one `_chunk` message. Returns the complete string when this chunk finished a message, else null. */
  add(msg, now = Date.now()) {
    this.sweep(now);
    const { mid, n, i, d } = msg;
    if (typeof mid !== 'string' || !mid || mid.length > MAX_MID) return null;
    const ok = Number.isInteger(n) && Number.isInteger(i) && n > 1 && n <= MAX_CHUNKS && i >= 0 && i < n && typeof d === 'string' && d.length <= CHUNK;
    let a = this.parts.get(mid);
    if (!ok || (a && a.n !== n)) {
      this._drop(mid); // a violation spoils the whole message
      return null;
    }
    if (!a) {
      a = { n, parts: new Array(n), got: 0, chars: 0, last: now };
      this.parts.set(mid, a);
      while (this.parts.size > MAX_ASSEMBLIES) this._drop(this.parts.keys().next().value);
    }
    a.last = now;
    if (a.parts[i] !== undefined) return null; // a repeated chunk changes nothing
    if (a.chars + d.length > MAX_MESSAGE) {
      this._drop(mid);
      return null;
    }
    a.parts[i] = d;
    a.got++;
    a.chars += d.length;
    this.total += d.length;
    if (a.got === a.n) {
      this._drop(mid);
      return a.parts.join('');
    }
    // Over the total budget: the oldest messages go (the current one is alone at most MAX_MESSAGE).
    while (this.total > MAX_BUFFERED) this._drop(this.parts.keys().next().value);
    return null;
  }
}

/**
 * Sends strings on a data channel, splitting long ones into chunks. A long message is queued and handed to
 * the channel while its buffer is below DATA_HIGH; anything sent while the queue is not empty waits behind
 * it, so messages keep their order. At most MAX_QUEUED chars wait: a message that would go past that empties the
 * queue, is not sent, and calls onoverflow (the peer is not reading, so the link is stuck).
 */
export class ChunkSender {
  constructor(dc, maxQueued = MAX_QUEUED) {
    this.dc = dc;
    this.queue = []; // { s, mid, n, i } — i is the next chunk to send; mid is null for a short message
    this.queued = 0; // chars of the messages in the queue
    this.maxQueued = maxQueued;
    /** @type {(() => void)|null} */
    this.onoverflow = null;
    dc.bufferedAmountLowThreshold = DATA_LOW;
  }

  /** Returns false if the channel is not open, or the message did not fit in the queue. */
  send(s) {
    if (this.dc.readyState !== 'open') return false;
    // The shortcut is only taken while the channel is draining: otherwise short messages too wait in the bounded
    // queue, so a channel that stays open but stops draining ends in onoverflow (a reconnect) instead of growing
    // the browser's buffer without limit.
    if (s.length <= CHUNK && !this.queue.length && this.dc.bufferedAmount <= DATA_HIGH) {
      try {
        this.dc.send(s);
      } catch {
        this.clear();
        return false;
      }
      return true;
    }
    if (this.queued + s.length > this.maxQueued) {
      this.clear();
      this.onoverflow?.();
      return false;
    }
    if (s.length <= CHUNK) {
      this.queue.push({ s, mid: null, n: 1, i: 0 });
    } else {
      const mid = Math.random().toString(36).slice(2);
      this.queue.push({ s, mid, n: Math.ceil(s.length / CHUNK), i: 0 });
    }
    this.queued += s.length;
    this.pump();
    return true;
  }

  pump() {
    const dc = this.dc;
    while (this.queue.length && dc.readyState === 'open' && dc.bufferedAmount <= DATA_HIGH) {
      const m = this.queue[0];
      try {
        dc.send(m.mid === null ? m.s : JSON.stringify({ type: '_chunk', mid: m.mid, i: m.i, n: m.n, d: m.s.slice(m.i * CHUNK, (m.i + 1) * CHUNK) }));
      } catch {
        this.clear();
        return;
      }
      if (++m.i >= m.n) {
        this.queue.shift();
        this.queued -= m.s.length;
      }
    }
  }

  clear() {
    this.queue = [];
    this.queued = 0;
  }
}

class Peer {
  constructor(mesh, id, name) {
    this.mesh = mesh;
    this.id = id;
    this.name = name;
    this.polite = mesh.selfId < id;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.stream = new MediaStream(); // camera and microphone
    this.screenStream = new MediaStream(); // a shared screen (its track stays, without frames, after a share ends)
    this._audioSid = null; // stream id of the incoming audio
    this._videoBySid = new Map(); // stream id -> incoming video track
    this.media = { audio: false, video: false };
    this.chunks = new Reassembler();
    this.pendingCandidates = [];
    this.open = false;
    this.closed = false; // set by close()

    const pc = new RTCPeerConnection({ iceServers: mesh.iceServers, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    // Our own outgoing tracks get dedicated send-only transceivers, so turning
    // the camera on/off later is just a replaceTrack() — no renegotiation.
    this.audioTx = pc.addTransceiver('audio', { direction: 'sendonly', streams: [mesh.outStream] });
    this.videoTx = pc.addTransceiver('video', { direction: 'sendonly', streams: [mesh.outStream] });
    this.audioTx.sender.replaceTrack(mesh.tracks.audio || null);
    this.videoTx.sender.replaceTrack(mesh.tracks.video || null);
    // The screen gets its transceiver the first time we share (a renegotiation), so a room where nobody shares
    // has no extra media section. A link built during a share starts with it.
    this.screenTx = null;
    if (mesh.tracks.screen) this._addScreenTx();
    this._preferCodecs();

    this.dc = pc.createDataChannel('data', { negotiated: true, id: 0, ordered: true });
    this.dc.binaryType = 'arraybuffer';
    this.writer = new ChunkSender(this.dc);
    // The other side has stopped reading: drop the link (onclose then rebuilds it) rather than buffer without end.
    this.writer.onoverflow = () => {
      console.warn(`data channel to ${this.id} is not draining: reconnecting`);
      try {
        this.dc.close();
      } catch { /* already closing */ }
    };
    // Unfinished incoming messages are dropped when they go stale, even if no further chunk arrives.
    this._sweepTimer = setInterval(() => this.chunks.sweep(), ASSEMBLY_TIMEOUT_MS / 3);
    this.dc.onopen = () => {
      this.open = true;
      this.mesh._applyBitrates();
      this.mesh._attempts.delete(this.id); // the link works: forget earlier rebuild attempts
      this.mesh._emit('channel-open', { peer: this });
    };
    this.dc.onbufferedamountlow = () => this.writer.pump();
    this.dc.onclose = () => {
      this.open = false;
      this.writer.clear();
      this.chunks.clear();
      // Closed by the other side (or the network), not by us: a negotiated channel never reopens.
      if (!this.closed) this.mesh._channelClosed(this);
    };
    this.dc.onmessage = (ev) => this._onData(ev.data);

    // Second negotiated channel (id 1): film pieces. Reliable and ordered, like the first.
    this.filmOpen = false;
    this.filmQueue = []; // [{ buf, tag }] waiting for the buffer to drain
    this.filmQueued = 0; // bytes in filmQueue
    this.film = pc.createDataChannel('film', { negotiated: true, id: 1, ordered: true });
    this.film.binaryType = 'arraybuffer';
    this.film.bufferedAmountLowThreshold = FILM_LOW;
    this.film.onopen = () => {
      this.filmOpen = true;
      this.mesh._emit('film-open', { peer: this });
    };
    this.film.onclose = () => {
      const was = this.filmOpen;
      this.filmOpen = false;
      this.filmQueue = [];
      this.filmQueued = 0;
      // A peer we closed ourselves is reported by 'peer-removed'; a stale one must not disturb its replacement.
      if (was && !this.closed) this.mesh._emit('film-close', { peer: this });
    };
    this.film.onbufferedamountlow = () => this._pumpFilm();
    this.film.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) this.mesh._emit('film', { peer: this, data: ev.data });
    };

    pc.ontrack = (ev) => {
      const sid = ev.streams[0]?.id ?? '';
      if (ev.track.kind === 'audio') {
        this._audioSid = sid;
        this._setTrack(this.stream, 'audio', ev.track);
      } else {
        this._videoBySid.delete(sid); // re-insert: the latest stays last
        this._videoBySid.set(sid, ev.track);
      }
      const { camera, screen } = routeVideo(this._audioSid, this._videoBySid);
      this._setTrack(this.stream, 'video', camera);
      this._setTrack(this.screenStream, 'video', screen);
      this.mesh._emit('track', { peer: this });
    };
    // Encodings can be missing until a negotiation is done (e.g. for a screen transceiver just added).
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable' && !this.closed) this.mesh._applyBitrates();
    };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription?.type === 'offer') this.offerSentAt = Date.now();
        mesh.signaling.signal(id, { description: pc.localDescription });
      } catch (err) {
        console.warn('negotiation failed', err);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) mesh.signaling.signal(id, { candidate });
    };
    // Watchdog: if the connection doesn't come up, restart ICE (fresh
    // candidates). Covers rare negotiation races and network changes.
    this._attempts = 0;
    const watchdog = () => {
      this._watchdog = setTimeout(() => {
        if (pc.connectionState === 'connected' || pc.connectionState === 'closed') return;
        if (++this._attempts > 4) return;
        try {
          pc.restartIce();
        } catch {
          /* ignore */
        }
        watchdog();
      }, 8000 + this._attempts * 4000);
    };
    watchdog();
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this.mesh._emit('peer-state', { peer: this, state: s });
      if (s === 'failed') {
        try {
          pc.restartIce();
        } catch {
          /* ignore */
        }
      }
      if (s === 'disconnected') {
        clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected') pc.restartIce?.();
        }, 4000);
      }
    };
  }

  /** Keep at most one track of `kind` in `stream`: `track`, or none. */
  _setTrack(stream, kind, track) {
    for (const t of stream.getTracks()) if (t.kind === kind && t !== track) stream.removeTrack(t);
    if (track && !stream.getTracks().includes(track)) stream.addTrack(track);
  }

  _addScreenTx() {
    this.screenTx = this.pc.addTransceiver('video', { direction: 'sendonly', streams: [this.mesh.screenStream] });
    this.screenTx.sender.replaceTrack(this.mesh.tracks.screen || null).catch(() => {});
    this._preferCodecs(this.screenTx);
  }

  _preferCodecs(tx = this.videoTx) {
    // Prefer VP8/H.264 for video (hardware support everywhere), Opus for audio.
    try {
      const caps = RTCRtpReceiver.getCapabilities?.('video');
      if (caps && tx.setCodecPreferences) {
        const rank = (c) => (/vp8/i.test(c.mimeType) ? 0 : /h264/i.test(c.mimeType) ? 1 : /vp9/i.test(c.mimeType) ? 2 : 3);
        const codecs = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
        tx.setCodecPreferences(codecs);
      }
    } catch {
      /* not supported, use defaults */
    }
  }

  handleSignal(data) {
    // Process signaling messages strictly in order.
    this._queue = (this._queue || Promise.resolve()).then(() => this._handleSignal(data));
    return this._queue;
  }

  async _handleSignal(data) {
    const pc = this.pc;
    try {
      if (data.description) {
        const d = data.description;
        // "Perfect negotiation": https://w3c.github.io/webrtc-pc/#perfect-negotiation-example
        const readyForOffer = !this.makingOffer && (pc.signalingState === 'stable' || this.settingRemoteAnswer);
        const collision = d.type === 'offer' && !readyForOffer;
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        this.settingRemoteAnswer = d.type === 'answer';
        await pc.setRemoteDescription(d);
        this.settingRemoteAnswer = false;
        for (const c of this.pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (d.type === 'offer') {
          await pc.setLocalDescription();
          this.mesh.signaling.signal(this.id, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        if (!pc.remoteDescription) {
          this.pendingCandidates.push(data.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!this.ignoreOffer) console.warn('addIceCandidate failed', err);
        }
      }
    } catch (err) {
      this.settingRemoteAnswer = false;
      console.warn('signal handling failed', err);
    }
  }

  send(msg) {
    return this.writer.send(JSON.stringify(msg));
  }

  /**
   * Send one binary film message (an ArrayBuffer or typed array). It goes out at once while the channel's
   * buffer is below the high-water mark, otherwise it waits in a queue. `tag` lets dropFilm() remove it
   * again. An `urgent` message (a few bytes) goes to the channel at once, ahead of the queue; it cannot be
   * dropped. Returns false if the film channel is not open.
   */
  sendFilm(buf, tag = '', { urgent = false } = {}) {
    if (!this.filmOpen || this.film.readyState !== 'open') return false;
    if (urgent) {
      try {
        this.film.send(buf);
        return true;
      } catch {
        return false;
      }
    }
    this.filmQueue.push({ buf, tag });
    this.filmQueued += buf.byteLength;
    this._pumpFilm();
    return true;
  }

  _pumpFilm() {
    const ch = this.film;
    while (this.filmQueue.length && ch.readyState === 'open' && ch.bufferedAmount <= FILM_HIGH) {
      const { buf } = this.filmQueue.shift();
      this.filmQueued -= buf.byteLength;
      try {
        ch.send(buf);
      } catch {
        this.filmQueue = [];
        this.filmQueued = 0;
        return;
      }
    }
  }

  /** Remove queued (not yet handed to the channel) film messages with this tag. */
  dropFilm(tag) {
    if (!this.filmQueue.length) return;
    this.filmQueue = this.filmQueue.filter((m) => {
      if (m.tag !== tag) return true;
      this.filmQueued -= m.buf.byteLength;
      return false;
    });
  }

  /** Bytes of film data not yet delivered to the network (queued or buffered). */
  get filmBacklog() {
    return this.filmQueued + (this.film.readyState === 'open' ? this.film.bufferedAmount : 0);
  }

  _onData(raw) {
    if (typeof raw !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg && msg.type === '_chunk') {
      const whole = this.chunks.add(msg);
      if (whole === null) return;
      try {
        msg = JSON.parse(whole);
      } catch {
        return;
      }
      if (msg && msg.type === '_chunk') return; // chunks do not nest
    }
    if (msg && typeof msg.type === 'string') this.mesh._emit('message', { peer: this, msg });
  }

  close() {
    this.closed = true;
    clearTimeout(this._restartTimer);
    clearTimeout(this._watchdog);
    clearTimeout(this._staleCheck);
    clearInterval(this._sweepTimer);
    this.writer.clear();
    this.chunks.clear();
    try {
      this.dc.close();
      this.film.close();
    } catch {
      /* ignore */
    }
    this.pc.close();
  }
}

/** Set the upload limit of a sender (and how it degrades), if it changed. */
function capSender(sender, maxBitrate, degradation) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) return;
    const enc = params.encodings[0];
    if (enc.maxBitrate === maxBitrate && (!degradation || params.degradationPreference === degradation)) return;
    enc.maxBitrate = maxBitrate;
    if (degradation) params.degradationPreference = degradation;
    sender.setParameters(params).catch(() => {
      if (!degradation) return;
      // Not every browser takes degradationPreference: set the bitrate at least.
      const p = sender.getParameters();
      if (!p.encodings?.length) return;
      p.encodings[0].maxBitrate = maxBitrate;
      sender.setParameters(p).catch(() => {});
    });
  } catch {
    /* ignore */
  }
}

export class Mesh extends EventTarget {
  constructor(signaling, selfId, iceServers) {
    super();
    this.signaling = signaling;
    this.selfId = selfId;
    this.iceServers = iceServers;
    this.peers = new Map();
    this.tracks = { audio: null, video: null, screen: null };
    this.outStream = new MediaStream(); // camera and microphone
    this.screenStream = new MediaStream(); // our shared screen, in a stream of its own (see routeVideo)
    this.lowPower = false;

    // The newcomer initiates connections to everyone already in the room;
    // existing members wait for its offer. Avoiding simultaneous offers
    // ("glare") keeps the first connection fast and reliable.
    this.names = new Map();
    signaling.addEventListener('peer-joined', (e) => {
      this.names.set(e.detail.id, e.detail.name);
      this._emit('peer-announced', { id: e.detail.id, name: e.detail.name });
    });
    signaling.addEventListener('peer-left', (e) => this.removePeer(e.detail.id));
    signaling.addEventListener('signal', (e) => {
      const { from, data } = e.detail;
      if (!data || typeof data !== 'object') return;
      if (data.description?.type === 'offer' && !this._takeOffer(from)) return;
      let peer = this.peers.get(from);
      if (!peer) peer = this.addPeer(from, this.names.get(from) || '');
      // A new offer for a link that cannot take it: the other side rebuilt its connection, and only a fresh
      // RTCPeerConnection of ours can get the negotiated channels open again.
      else if (data.description?.type === 'offer' && this._needsFreshPeer(peer)) peer = this._rebuildLimited(from);
      if (peer) peer.handleSignal(data);
    });
    // Our own connection to the server was lost and is back. The server may have told the others that we
    // left (they then closed their side of our links) or not (it restarted, or it was a short blip).
    // Which one it was is visible in the links themselves, so judge each peer by its link state.
    signaling.addEventListener('reconnected', (e) => {
      const ids = new Set(e.detail.peers.map((p) => p.id));
      for (const p of e.detail.peers) {
        const have = this.peers.get(p.id);
        if (!have) this.addPeer(p.id, p.name);
        else if (!this._linkHealthy(have)) this.rebuildPeer(p.id, p.name); // we initiate, as a newcomer does
      }
      for (const [id, peer] of this.peers) {
        if (!ids.has(id) && peer.pc.connectionState !== 'connected') this.removePeer(id);
      }
    });
    this._attempts = new Map(); // peerId -> rebuilds since its data channel was last open
    this._lastRebuild = new Map(); // peerId -> time of the last rebuild
    this._offers = new Map(); // peerId -> { times: when we took its offers within OFFER_WINDOW_MS, warned: when we last said we ignore it }
  }

  /** May we take (and so answer) another offer from this peer? Counts it when we may. Kept across rebuilds of the link. */
  _takeOffer(id) {
    const now = Date.now();
    const seen = this._offers.get(id) || { times: [], warned: 0 };
    seen.times = seen.times.filter((t) => now - t < OFFER_WINDOW_MS);
    this._offers.set(id, seen);
    if (seen.times.length >= MAX_OFFERS_PER_PEER) {
      if (now - seen.warned >= OFFER_WINDOW_MS) {
        seen.warned = now;
        console.warn(`ignoring offers from ${id}: more than ${MAX_OFFERS_PER_PEER} in a minute`);
      }
      return false;
    }
    seen.times.push(now);
    return true;
  }

  /**
   * Can this peer not take a new offer from the other side? Either its data channel is dead, or we are the
   * impolite side and our own first offer got no answer for a long time (it was lost, e.g. the other side's
   * socket was down): we would ignore their offer and nobody would retry, so we yield. Only the impolite side
   * does this; the polite side already rolls back on a collision, so the two sides cannot both rebuild. A
   * young unanswered offer may just be a normal collision: the other side's rollback sorts that out, but if it
   * is still unanswered when it turns stale we rebuild then (our new offer is handled by the polite side).
   */
  _needsFreshPeer(peer) {
    if (peer.dc.readyState === 'closed') return true;
    const pc = peer.pc;
    if (peer.open || peer.polite || pc.signalingState !== 'have-local-offer' || pc.remoteDescription) return false;
    const wait = OFFER_STALE_MS - (Date.now() - (peer.offerSentAt || 0));
    if (wait <= 0) return true;
    if (peer._staleCheck) return false; // one pending check is enough
    peer._staleCheck = setTimeout(() => {
      peer._staleCheck = null;
      if (this.peers.get(peer.id) !== peer || peer.closed || peer.open || pc.signalingState !== 'have-local-offer' || pc.remoteDescription) return;
      this._rebuildLimited(peer.id);
    }, wait + 50);
    return false;
  }

  /**
   * rebuildPeer() for rebuilds that a timer or the other side asked for: they share one attempt counter (reset
   * when the channel opens, or when the last rebuild is over a minute old) and keep a minimum distance, so a
   * member that keeps closing its channel and sending offers cannot make us rebuild without limit. Returns
   * null when it holds back.
   */
  _rebuildLimited(id) {
    const n = this._attemptCount(id);
    if (n >= MAX_REBUILDS || Date.now() - (this._lastRebuild.get(id) || 0) < MIN_REBUILD_MS) return null;
    this._attempts.set(id, n + 1);
    return this.rebuildPeer(id);
  }

  /** Rebuilds since the channel last opened; forgotten when the last one is over REBUILD_DECAY_MS ago. */
  _attemptCount(id) {
    if (Date.now() - (this._lastRebuild.get(id) || 0) > REBUILD_DECAY_MS) this._attempts.delete(id);
    return this._attempts.get(id) || 0;
  }

  _linkHealthy(peer) {
    const s = peer.pc.connectionState;
    return peer.dc.readyState === 'open' && s !== 'closed' && s !== 'failed';
  }

  /**
   * The data channel of a peer closed while we still consider the person a member: rebuild the connection.
   * Only one side may start it, or both would offer at once and keep replacing each other's connections.
   * The side with the lower id goes first (soon). The other side normally gets that offer and rebuilds when it
   * arrives (see the 'signal' handler); it only acts on its own after a long wait, in case the other side
   * does not know that the link is dead (e.g. it still holds a stale half-open channel).
   */
  _channelClosed(peer) {
    const id = peer.id;
    const n = this._attemptCount(id);
    if (n >= MAX_REBUILDS) return; // keeps failing: leave it to the user (reload) instead of looping forever
    const delay = (this.selfId < id ? 1000 : 8000) * 2 ** Math.min(n, 3);
    setTimeout(() => {
      if (this.peers.get(id) !== peer || peer.closed || peer.dc.readyState === 'open') return;
      if (!this.signaling.joined) return; // 'reconnected' sorts the peers out once we are back
      this._rebuildLimited(id);
    }, delay);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  addPeer(id, name) {
    if (id === this.selfId) return null;
    let peer = this.peers.get(id);
    if (peer) {
      if (name) peer.name = name;
      return peer;
    }
    peer = new Peer(this, id, name);
    this.peers.set(id, peer);
    this._emit('peer-added', { peer });
    this._applyBitrates();
    return peer;
  }

  removePeer(id) {
    this.names.delete(id);
    this._attempts.delete(id);
    this._lastRebuild.delete(id);
    this._offers.delete(id);
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.close();
    this.peers.delete(id);
    this._emit('peer-removed', { peer });
    this._applyBitrates();
  }

  /**
   * Replace the connection to a member with a fresh one (same person). 'peer-removed' / 'peer-added' carry
   * `rebuilding` / `rebuilt`, so listeners reset what they know about the link but keep what they know about
   * the person (tile, profile) and don't announce a leave and a join.
   */
  rebuildPeer(id, name) {
    const old = this.peers.get(id);
    if (!old) return this.addPeer(id, name);
    old.close();
    this._lastRebuild.set(id, Date.now());
    const peer = new Peer(this, id, name || old.name);
    this.peers.set(id, peer);
    this._emit('peer-removed', { peer: old, rebuilding: true });
    this._emit('peer-added', { peer, rebuilt: true });
    this._applyBitrates();
    return peer;
  }

  /** Set (or clear) the outgoing audio/video track for every peer. */
  async setTrack(kind, track) {
    const old = this.tracks[kind];
    if (old) this.outStream.removeTrack(old);
    this.tracks[kind] = track;
    if (track) this.outStream.addTrack(track);
    await Promise.all([...this.peers.values()].map((p) => (kind === 'audio' ? p.audioTx : p.videoTx).sender.replaceTrack(track).catch(() => {})));
    this._applyBitrates();
  }

  /** Set (or clear) the shared screen for every peer. The first share adds a transceiver to each link. */
  async setScreenTrack(track) {
    const old = this.tracks.screen;
    if (old) this.screenStream.removeTrack(old);
    this.tracks.screen = track;
    if (track) this.screenStream.addTrack(track);
    await Promise.all([...this.peers.values()].map((p) => {
      if (!p.screenTx) {
        if (track) p._addScreenTx(); // it takes the track itself
        return null;
      }
      return p.screenTx.sender.replaceTrack(track).catch(() => {});
    }));
    this._applyBitrates();
  }

  /**
   * New ICE servers (renewed TURN credentials): new links use them, and existing ones for their next ICE restart
   * (a TURN allocation made with expired credentials cannot be renewed).
   */
  setIceServers(iceServers) {
    this.iceServers = iceServers;
    for (const p of this.peers.values()) {
      try {
        p.pc.setConfiguration({ iceServers, bundlePolicy: 'max-bundle' }); // as the link was created (see Peer)
      } catch {
        /* closed, or the browser refuses the change: the link keeps its servers */
      }
    }
  }

  setLowPower(v) {
    this.lowPower = v;
    this._applyBitrates();
  }

  _applyBitrates() {
    const n = this.peers.size;
    const sharing = !!this.tracks.screen;
    const camera = sharing ? Math.min(CAMERA_WHILE_SHARING, videoBudget(n, this.lowPower)) : videoBudget(n, this.lowPower);
    const screen = screenBudget(n, this.lowPower);
    for (const p of this.peers.values()) {
      capSender(p.videoTx.sender, camera);
      // Shared text must stay readable: on a slow link, drop frames rather than resolution.
      if (p.screenTx) capSender(p.screenTx.sender, screen, 'maintain-resolution');
    }
  }

  send(id, msg) {
    return this.peers.get(id)?.send(msg) || false;
  }

  /** Send a binary film message to one peer (see Peer.sendFilm). */
  sendFilm(id, buf, tag, opts) {
    return this.peers.get(id)?.sendFilm(buf, tag, opts) || false;
  }

  dropFilm(id, tag) {
    this.peers.get(id)?.dropFilm(tag);
  }

  broadcast(msg) {
    for (const p of this.peers.values()) p.send(msg);
  }

  close() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }
}
