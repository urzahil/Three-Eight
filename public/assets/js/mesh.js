// Full-mesh WebRTC: one RTCPeerConnection per remote participant.
// Audio/video and data (chat, movie sync) go directly browser-to-browser;
// the server only relays the initial handshake.

const CHUNK = 12 * 1024;

// The film channel carries binary film pieces only, so they never queue up in front of chat and sync
// messages on the JSON channel. Sends wait in a queue while more than FILM_HIGH bytes are buffered.
const FILM_HIGH = 1024 * 1024;
const FILM_LOW = 256 * 1024;

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

class Peer {
  constructor(mesh, id, name) {
    this.mesh = mesh;
    this.id = id;
    this.name = name;
    this.polite = mesh.selfId < id;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.stream = new MediaStream();
    this.media = { audio: false, video: false };
    this.chunks = new Map();
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
    this._preferCodecs();

    this.dc = pc.createDataChannel('data', { negotiated: true, id: 0, ordered: true });
    this.dc.binaryType = 'arraybuffer';
    this.dc.onopen = () => {
      this.open = true;
      this.mesh._applyBitrates();
      this.mesh._attempts.delete(this.id); // the link works: forget earlier rebuild attempts
      this.mesh._emit('channel-open', { peer: this });
    };
    this.dc.onclose = () => {
      this.open = false;
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
      if (!this.stream.getTracks().includes(ev.track)) {
        for (const t of this.stream.getTracks()) if (t.kind === ev.track.kind) this.stream.removeTrack(t);
        this.stream.addTrack(ev.track);
      }
      this.mesh._emit('track', { peer: this });
    };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
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

  _preferCodecs() {
    // Prefer VP8/H.264 for video (hardware support everywhere), Opus for audio.
    try {
      const caps = RTCRtpReceiver.getCapabilities?.('video');
      if (caps && this.videoTx.setCodecPreferences) {
        const rank = (c) => (/vp8/i.test(c.mimeType) ? 0 : /h264/i.test(c.mimeType) ? 1 : /vp9/i.test(c.mimeType) ? 2 : 3);
        const codecs = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
        this.videoTx.setCodecPreferences(codecs);
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
    if (this.dc.readyState !== 'open') return false;
    const s = JSON.stringify(msg);
    if (s.length <= CHUNK) {
      this.dc.send(s);
      return true;
    }
    const mid = Math.random().toString(36).slice(2);
    const n = Math.ceil(s.length / CHUNK);
    for (let i = 0; i < n; i++) {
      this.dc.send(JSON.stringify({ type: '_chunk', mid, i, n, d: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
    }
    return true;
  }

  /**
   * Send one binary film message (an ArrayBuffer or typed array). It goes out at once while the channel's
   * buffer is below the high-water mark, otherwise it waits in a queue. `tag` lets dropFilm() remove it
   * again. Returns false if the film channel is not open.
   */
  sendFilm(buf, tag = '') {
    if (!this.filmOpen || this.film.readyState !== 'open') return false;
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
    if (msg.type === '_chunk') {
      if (typeof msg.mid !== 'string' || !(msg.n > 0 && msg.n < 2000)) return;
      let c = this.chunks.get(msg.mid);
      if (!c) {
        c = { parts: new Array(msg.n), got: 0 };
        this.chunks.set(msg.mid, c);
        if (this.chunks.size > 20) this.chunks.delete(this.chunks.keys().next().value);
      }
      if (c.parts[msg.i] == null) {
        c.parts[msg.i] = String(msg.d);
        c.got++;
      }
      if (c.got === msg.n) {
        this.chunks.delete(msg.mid);
        try {
          msg = JSON.parse(c.parts.join(''));
        } catch {
          return;
        }
      } else return;
    }
    if (msg && typeof msg.type === 'string') this.mesh._emit('message', { peer: this, msg });
  }

  close() {
    this.closed = true;
    clearTimeout(this._restartTimer);
    clearTimeout(this._watchdog);
    try {
      this.dc.close();
      this.film.close();
    } catch {
      /* ignore */
    }
    this.pc.close();
  }
}

export class Mesh extends EventTarget {
  constructor(signaling, selfId, iceServers) {
    super();
    this.signaling = signaling;
    this.selfId = selfId;
    this.iceServers = iceServers;
    this.peers = new Map();
    this.tracks = { audio: null, video: null };
    this.outStream = new MediaStream();
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
      let peer = this.peers.get(from);
      if (!peer) peer = this.addPeer(from, this.names.get(from) || '');
      // A new offer for a link whose data channel is dead: the other side rebuilt its connection, and
      // only a fresh RTCPeerConnection of ours can get the negotiated channels open again.
      else if (data.description?.type === 'offer' && peer.dc.readyState === 'closed') peer = this.rebuildPeer(from);
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
    const n = this._attempts.get(id) || 0;
    if (n >= 6) return; // keeps failing: leave it to the user (reload) instead of looping forever
    const delay = (this.selfId < id ? 1000 : 8000) * 2 ** Math.min(n, 3);
    setTimeout(() => {
      if (this.peers.get(id) !== peer || peer.closed || peer.dc.readyState === 'open') return;
      if (!this.signaling.joined) return; // 'reconnected' sorts the peers out once we are back
      this._attempts.set(id, n + 1);
      this.rebuildPeer(id);
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

  setLowPower(v) {
    this.lowPower = v;
    this._applyBitrates();
  }

  _applyBitrates() {
    const n = this.peers.size;
    const max = videoBudget(n, this.lowPower);
    for (const p of this.peers.values()) {
      const sender = p.videoTx.sender;
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) continue;
        const enc = params.encodings[0];
        if (enc.maxBitrate === max) continue;
        enc.maxBitrate = max;
        sender.setParameters(params).catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }

  send(id, msg) {
    return this.peers.get(id)?.send(msg) || false;
  }

  /** Send a binary film message to one peer (see Peer.sendFilm). */
  sendFilm(id, buf, tag) {
    return this.peers.get(id)?.sendFilm(buf, tag) || false;
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
