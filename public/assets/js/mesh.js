// Full-mesh WebRTC: one RTCPeerConnection per remote participant.
// Audio/video and data (chat, movie sync) go directly browser-to-browser;
// the server only relays the initial handshake.

const CHUNK = 12 * 1024;

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
      this.mesh._emit('channel-open', { peer: this });
    };
    this.dc.onclose = () => {
      this.open = false;
    };
    this.dc.onmessage = (ev) => this._onData(ev.data);

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
    clearTimeout(this._restartTimer);
    clearTimeout(this._watchdog);
    try {
      this.dc.close();
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
      if (peer) peer.handleSignal(data);
    });
    signaling.addEventListener('reconnected', (e) => {
      const ids = new Set(e.detail.peers.map((p) => p.id));
      for (const p of e.detail.peers) if (!this.peers.has(p.id)) this.addPeer(p.id, p.name);
      for (const [id, peer] of this.peers) {
        if (!ids.has(id) && peer.pc.connectionState !== 'connected') this.removePeer(id);
      }
    });
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

  broadcast(msg) {
    for (const p of this.peers.values()) p.send(msg);
  }

  close() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }
}
