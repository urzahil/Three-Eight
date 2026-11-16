// The movie: stage, controls, seek bar, overlays, loading a file, Media Session and full screen.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { audioContext } from '../media.js';
import { sameMovie } from '../sync.js';
import { $, store, toast, setIcon, fmtTime, fmtSize, randomId, hashText, pipState } from './util.js';

export class Movie {
  _initMovie() {
    const p = this.player;
    const sync = this.sync;
    const box = $('movie-box');

    $('movie-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      $('movie-dialog').close('file');
      if (f) this.chooseMovieFile(f);
    });
    $('movie-dialog').addEventListener('close', () => {
      const v = $('movie-dialog').returnValue;
      if (v === 'unload') {
        p.unload();
        sync.clearLocalFile();
      } else if (v === 'close') {
        p.unload();
        sync.clearLocalFile();
        sync.closeMovie();
      }
    });
    $('sub-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) return toast('Subtitle file is too large.', 'warn');
      await this._shareSubtitle(f.name, new Uint8Array(await f.arrayBuffer()));
    });

    // Controls
    $('m-play').onclick = () => this._userAction(() => sync.toggle());
    $('m-back').onclick = () => this._userAction(() => sync.seek(Math.max(0, this._pos() - this.seekStep)));
    $('m-fwd').onclick = () => this._userAction(() => sync.seek(this._pos() + this.seekStep));
    box.querySelector('video').addEventListener('click', () => this._userAction(() => sync.toggle()));
    box.querySelector('video').addEventListener('dblclick', () => this.toggleFullscreen());
    $('m-volume').value = p.video.volume;
    $('m-volume').oninput = (e) => {
      p.video.volume = Number(e.target.value);
      p.video.muted = false;
      store.set('movieVolume', p.video.volume);
      this._refreshVolume();
    };
    $('m-mute').onclick = () => {
      p.video.muted = !p.video.muted;
      this._refreshVolume();
    };
    $('m-full').onclick = () => this.toggleFullscreen();
    this._initSeekBar();
    this._initMenus();

    // Hide controls when idle.
    let idleTimer = 0;
    const wake = () => {
      box.classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!p.paused && !box.querySelector('.menu:not([hidden])')) box.classList.add('idle');
      }, 3000);
    };
    box.addEventListener('pointermove', wake);
    box.addEventListener('pointerdown', wake);
    p.addEventListener('pause', wake);

    // Player events
    p.addEventListener('tracks', () => this._renderMenus());
    // `long` messages (a serious, lasting problem such as a used-up quota) need time to be read.
    p.addEventListener('notice', (e) => toast(e.detail.text, 'warn', e.detail.long ? 25000 : 0));
    p.addEventListener('fatal', (e) => {
      toast(e.detail.text, 'warn', e.detail.long ? 25000 : 0);
      this._renderStage();
    });
    p.addEventListener('status', (e) => {
      if (e.detail.text) $('m-ready').textContent = e.detail.text;
    });
    for (const ev of ['play', 'pause', 'ended']) p.addEventListener(ev, () => this._refreshPlayButton());

    sync.addEventListener('state', () => {
      if ($('movie-dialog').open) {
        this._renderMovieDialog();
        this._renderDriveItems(); // subtitle files become available once a movie is chosen
      }
      this._updatePlaybackState();
      this._renderStage();
      this._renderMenus();
      this._renderPeople();
      this._wantCues();
    });
    sync.addEventListener('status', () => {
      this._renderReady();
      this._renderPeople();
    });
    sync.addEventListener('blocked', () => this._renderStage());
    sync.addEventListener('remote-change', (e) => this._announce(e.detail));

    setInterval(() => this._renderTime(), 250);
    this._renderStage();
  }

  _pos() {
    return this.sync.fileMatches && this.player.loaded ? this.player.time : this.sync.expectedPosition();
  }

  _userAction(fn) {
    audioContext();
    fn();
  }

  /** Decode subtitle bytes and share them with the room (from a local file or Google Drive). */
  async _shareSubtitle(name, bytes, message) {
    let text = new TextDecoder().decode(bytes);
    if (text.includes('�')) {
      // Not UTF-8: most older subtitle files are Windows-1252 / Latin-1.
      try {
        text = new TextDecoder('windows-1252').decode(bytes);
      } catch {
        /* keep */
      }
    }
    const id = 'x' + (await hashText(text));
    this.sync.addSubtitleFile({ id, name, text });
    toast(message || `Subtitles “${name}” shared with everyone.`);
  }

  openMovieDialog() {
    this._renderMovieDialog();
    this._renderDriveSection();
    $('movie-dialog').showModal();
  }

  _renderMovieDialog() {
    const s = this.sync.state;
    const has = this.sync.localFile;
    const drive = !!this.drive;
    $('movie-dialog-current').hidden = !has && !s.movie;
    $('movie-unload').hidden = !has;
    const share = 'The film is never stored on the server; only play/pause/seek and track choices are shared.';
    if (s.movie && !has) {
      const friends = this.swarm.holders(s.movie);
      const ways = [];
      if (friends.length) ways.push(friends.length === 1 ? `${this.profileOf(friends[0]).name}’s copy` : 'a friend’s copy');
      if (drive && s.movie.drive) ways.push('Google Drive');
      $('movie-dialog-text').textContent = `Everyone is watching “${s.movie.name}” (${fmtSize(s.movie.size)}). ${ways.length ? `Stream it from ${ways.join(' or ')}, or choose your own copy of the same file.` : 'Choose your own copy of the same file.'}`;
    } else if (has) {
      $('movie-dialog-text').textContent = `You're watching “${has.name}”. Pick another file to switch, or stop. Friends without the file can stream it from your copy (turn this off in Settings).`;
    } else if (drive) {
      $('movie-dialog-text').textContent = `Pick a movie from the room’s Google Drive folder, or choose a file on your device. ${share}`;
    } else {
      $('movie-dialog-text').textContent = `Choose a movie file on your device. Friends who don’t have it can stream it from your copy. ${share}`;
    }
  }

  /** Ask the room for the cues of a streamed film's embedded subtitle track; true if they were installed. */
  async _askCues(id) {
    const p = this.player;
    const file = p.file;
    if (!file?.remote || !p.needsCues(id)) return false;
    const cues = await this.swarm.fetchCues(id);
    if (!cues || p.file !== file || !p.needsCues(id)) {
      if (!cues) this._cueFail.set(id, { at: Date.now(), who: this.swarm._cueHolders(id).map((h) => h.id).join() });
      return false;
    }
    this._cueFail.delete(id);
    return p.installCues(id, cues);
  }

  /** The room's selected subtitle is an embedded track we lack, and someone has it: get it from them. */
  _wantCues() {
    const id = this.sync.state.sub;
    const p = this.player;
    if (!id || !/^e\d+$/.test(id) || !p.file?.remote || !p.needsCues(id) || !this.swarm.hasCueHolder(id)) return;
    const failed = this._cueFail.get(id);
    // Don't ask again right after a failure, unless different people have it now.
    if (failed && Date.now() - failed.at < 15000 && failed.who === this.swarm._cueHolders(id).map((h) => h.id).join()) return;
    this._askCues(id);
  }

  /**
   * Stream the room's movie with one click (a user gesture): from Google Drive and/or friends' copies. Both
   * read through the swarm, which prefers friends who have the whole file and uses Drive for the rest.
   */
  _streamRoomMovie() {
    const m = this.sync.state.movie;
    if (!m || !(m.size > 0)) return;
    try {
      if (this.drive && m.drive) {
        this.chooseMovieFile(this.drive.remoteFile({ id: m.drive.id, name: String(m.name || 'Movie'), size: Number(m.size), folder: m.drive.folder }, this.swarm));
      } else {
        this.chooseMovieFile(this.swarm.openRemote({ name: String(m.name || 'Movie'), size: Number(m.size), fp: m.fp }));
      }
    } catch (err) {
      toast(err.message, 'warn');
    }
  }

  async chooseMovieFile(file) {
    const s = this.sync.state;
    const quick = { name: file.name, size: file.size, duration: 0 };
    let asRoom = !s.movie;
    if (s.movie && !sameMovie(quick, s.movie) && file.name !== s.movie.name) {
      $('mismatch-text').textContent = `Everyone else is watching “${s.movie.name}” (${fmtSize(s.movie.size)}), but you picked “${file.name}” (${fmtSize(file.size)}).`;
      const choice = await new Promise((resolve) => {
        const d = $('mismatch-dialog');
        d.addEventListener('close', () => resolve(d.returnValue), { once: true });
        d.returnValue = 'cancel';
        d.showModal();
      });
      if (choice === 'cancel') {
        file.close?.(); // a streamed file stops sharing
        return;
      }
      asRoom = choice === 'room';
    }
    this.loadingMovie = true;
    this.loadingRemote = !!file.remote;
    this.loadingPeers = !!file.peerOnly;
    file.swarm?.activate();
    this._renderStage();
    try {
      await this.player.load(file, { audioIndex: asRoom ? 0 : s.audio });
    } catch (err) {
      console.error(err);
      toast(file.remote && err.remote ? err.message : 'Could not open this file: ' + (err.message || err), 'warn', err.permanent ? 25000 : 0);
      this.player.unload();
      this.loadingMovie = false;
      this._renderStage();
      return;
    }
    if (!this.loadingMovie || this.player.file !== file) return; // cancelled
    this.loadingMovie = false;
    // Prime playback inside this user gesture so later remote "play" commands
    // aren't blocked by autoplay rules (Safari).
    const v = this.player.video;
    if (v.paused) {
      const wasMuted = v.muted;
      v.muted = true;
      this.sync.expectMediaChange(2000);
      v.play().then(() => {
        this.sync.expectMediaChange(1000);
        if (this.sync.state.paused) v.pause();
        v.muted = wasMuted;
      }).catch(() => { v.muted = wasMuted; });
    }
    const info = { name: file.name, size: file.size, duration: Math.round(this.player.duration * 10) / 10 };
    if (file.drive) info.drive = { ...file.drive };
    if (!file.remote) {
      // A copy on this device can feed friends who have none. Its content fingerprint (a few small reads) tells
      // the others which file it is; when it cannot be computed the movie is matched by size and duration only.
      const film = this.swarm.openLocal(file);
      const fp = await film.ready;
      if (this.player.file !== file) return; // another file was picked meanwhile
      if (fp) info.fp = fp;
    } else if (file.swarm?.fp) info.fp = file.swarm.fp;
    this.sync.setLocalFile(info, asRoom);
    if (asRoom && file.drive?.folder) this._autoDriveSubtitle(file); // in the background: never holds up playback
    if (asRoom) this.mesh.broadcast({ type: 'chat', msg: { id: randomId(), from: this.id, name: this.name, text: `🎬 Started a movie: ${file.name}`, ts: this.signaling.now() } });
    this._renderStage();
    this._renderMenus();
  }

  _renderStage() {
    const s = this.sync.state;
    const active = !!s.movie || !!this.sync.localFile || !!this.loadingMovie;
    const wasHidden = $('stage').hidden;
    $('stage').hidden = !active;
    $('main').classList.toggle('watching', active);
    if (wasHidden !== !active) this._layout();
    if (!active) this.closePip();
    this._syncMediaSession();
    this._refreshToolbar();
    const ov = $('movie-overlay');
    ov.replaceChildren();
    let overlay = null;
    if (this.loadingMovie) {
      overlay = this._overlay('Opening movie…', this.loadingPeers ? 'Connecting to your friend…' : this.loadingRemote ? 'Connecting to Google Drive…' : 'Reading the file on your device.', 'Cancel', () => {
        this.loadingMovie = false;
        this.player.unload();
        this._renderStage();
      });
    } else if (s.movie && !this.sync.localFile) {
      const fromDrive = !!(this.drive && s.movie.drive && s.movie.size > 0);
      const friends = s.movie.size > 0 ? this.swarm.holders(s.movie) : [];
      const own = { label: 'Use my own copy…', onClick: () => $('movie-file').click() };
      const stream = () => this._streamRoomMovie();
      let title = `“${s.movie.name}”`;
      let text = `${fmtSize(s.movie.size)}${s.movie.duration ? ' · ' + fmtTime(s.movie.duration) : ''}. `;
      let button;
      let others = [own];
      if (friends.length) {
        const from = friends.length === 1 ? `${this.profileOf(friends[0]).name}'s copy` : "a friend's copy";
        button = `Stream from ${from}`;
        if (fromDrive) others = [{ label: 'Stream from Google Drive', onClick: stream }, own];
        text += `Stream it from ${from}${fromDrive ? ' or Google Drive' : ''}, or use your own copy of this file, to join in.`;
      } else if (fromDrive) {
        button = 'Stream from Google Drive';
        text += 'Stream it from Google Drive, or use your own copy of this file, to join in.';
      } else {
        button = 'Choose file…';
        text += 'Choose your copy of this file to join in.';
        others = [];
      }
      if (!s.paused) text += ' The movie is already playing — you will jump right in.';
      overlay = this._overlay(title, text, button, friends.length || fromDrive ? stream : () => $('movie-file').click(), others);
    } else if (!s.movie && this.sync.localFile) {
      overlay = this._overlay('Movie closed', 'The movie was closed for everyone.', 'OK', () => {
        this.player.unload();
        this.sync.clearLocalFile();
      });
    } else if (this.sync.blocked) {
      overlay = this._overlay('Ready', 'Your browser needs a click before it can play.', 'Start playback', () => {
        this.sync.unblock();
        this._renderStage();
      });
    }
    if (overlay) ov.appendChild(overlay);
    ov.hidden = !overlay;
    this._refreshPlayButton();
    this._renderReady();
  }

  _overlay(title, text, button, onClick, second = null) {
    const wrap = document.createElement('div');
    wrap.className = 'stack';
    const h = document.createElement('h2');
    h.textContent = title;
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = text;
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = button;
    b.onclick = onClick;
    wrap.append(h, p, b);
    for (const sec of [].concat(second || [])) {
      const b2 = document.createElement('button');
      b2.className = 'btn secondary';
      b2.textContent = sec.label;
      b2.onclick = sec.onClick;
      wrap.append(b2);
    }
    return wrap;
  }

  _renderReady() {
    const s = this.sync.state;
    if (!s.movie) return;
    if (!s.paused) this._startedMovie = s.movie;
    const started = this._startedMovie && sameMovie(this._startedMovie, s.movie);
    let ready = this.sync.fileMatches ? 1 : 0;
    let total = 1;
    const waiting = [];
    for (const [id] of this.mesh.peers) {
      total++;
      const st = this.sync.peerStatus.get(id);
      if (st && st.matches) ready++;
      else waiting.push(this.profileOf(id).name);
    }
    $('m-ready').textContent = total === 1 || (started && ready === total) ? '' : ready === total ? `Everyone ready (${total})` : `${ready}/${total} ready${waiting.length ? ' · waiting for ' + waiting.slice(0, 2).join(', ') : ''}`;
  }

  _refreshPlayButton() {
    const playing = !this.sync.state.paused;
    setIcon($('m-play'), playing ? 'pause' : 'play');
  }

  _refreshVolume() {
    const v = this.player.video;
    setIcon($('m-mute'), v.muted || v.volume === 0 ? 'volume-off' : 'volume');
    $('m-volume').value = v.muted ? 0 : v.volume;
  }

  _renderTime() {
    if ($('stage').hidden || this._dragging) return;
    const d = this.sync.state.movie?.duration || this.player.duration || 0;
    const t = this._pos();
    $('m-time').textContent = fmtTime(t);
    $('m-duration').textContent = fmtTime(d);
    $('m-progress').style.width = d ? `${Math.min(100, (t / d) * 100)}%` : '0';
    const b = this.player.loaded ? this.player.buffered.find(([a, e]) => a <= t + 0.5 && e >= t) : null;
    $('m-buffered').style.left = b && d ? `${(b[0] / d) * 100}%` : '0';
    $('m-buffered').style.width = b && d ? `${((b[1] - b[0]) / d) * 100}%` : '0';
  }

  _initSeekBar() {
    const bar = $('m-seek');
    const timeAt = (x) => {
      const r = bar.getBoundingClientRect();
      const d = this.sync.state.movie?.duration || this.player.duration || 0;
      return Math.max(0, Math.min(1, (x - r.left) / r.width)) * d;
    };
    const showHover = (x) => {
      const r = bar.getBoundingClientRect();
      $('m-hover').hidden = false;
      $('m-hover').style.left = `${Math.max(0, Math.min(r.width, x - r.left))}px`;
      $('m-hover').textContent = fmtTime(timeAt(x));
    };
    bar.addEventListener('pointermove', (e) => {
      showHover(e.clientX);
      if (this._dragging) {
        const d = this.sync.state.movie?.duration || this.player.duration || 1;
        $('m-progress').style.width = `${(timeAt(e.clientX) / d) * 100}%`;
        $('m-time').textContent = fmtTime(timeAt(e.clientX));
      }
    });
    bar.addEventListener('pointerleave', () => { if (!this._dragging) $('m-hover').hidden = true; });
    bar.addEventListener('pointerdown', (e) => {
      this._dragging = true;
      try {
        bar.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
      showHover(e.clientX);
    });
    bar.addEventListener('pointerup', (e) => {
      if (!this._dragging) return;
      this._dragging = false;
      $('m-hover').hidden = true;
      this._userAction(() => this.sync.seek(timeAt(e.clientX)));
    });
    bar.addEventListener('pointercancel', () => { this._dragging = false; });
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') this.sync.seek(Math.max(0, this._pos() - 5));
      else if (e.key === 'ArrowRight') this.sync.seek(this._pos() + 5);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  _announce({ peer, prev, state }) {
    const who = this.profileOf(peer.id).name;
    const by = state.by === peer.id ? who : this.profileOf(state.by).name;
    if (!sameMovie(prev.movie, state.movie)) {
      if (state.movie) toast(`${by} started “${state.movie.name}”. ${this.drive && state.movie.drive ? 'Stream it from Google Drive' : state.movie.size > 0 && state.by === peer.id ? `Stream it from ${who}'s copy` : 'Open your copy'} to watch along.`);
      else toast(`${by} closed the movie.`);
      return;
    }
    if (prev.paused !== state.paused) toast(`${by} ${state.paused ? 'paused' : 'pressed play'}`);
    else if (Math.abs(state.pos - this.sync.expectedPosition(prev)) > 2) toast(`${by} jumped to ${fmtTime(state.pos)}`);
    if (prev.audio !== state.audio) {
      const t = this.player.audioTracks?.[state.audio];
      toast(`${by} switched audio${t ? ' to ' + t.label : ''}`);
    }
    if (prev.sub !== state.sub) {
      const t = state.sub ? this.player.subtitles.get(state.sub) : null;
      toast(state.sub ? `${by} turned on subtitles${t ? ': ' + t.label : ''}` : `${by} turned subtitles off`);
    }
  }

  toggleFullscreen() {
    if (pipState.window) return; // the floating window has no full screen
    const el = document.documentElement;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (el.requestFullscreen || el.webkitRequestFullscreen) {
      const r = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      r?.catch?.(() => {});
    } else if (this.player.video.webkitEnterFullscreen) {
      this.player.video.webkitEnterFullscreen(); // iPhone: video-only full screen
    }
  }

  _syncMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const file = this.sync.localFile;
    const on = !!file && this.player.loaded;
    this._updatePlaybackState();
    if (on === this._mediaSession) return;
    this._mediaSession = on;
    const sync = this.sync;
    const seekBy = (d, dir) => this._userAction(() => sync.seek(Math.max(0, this._pos() + dir * (d?.seekOffset || this.seekStep))));
    const handlers = on ? {
      play: () => { if (sync.state.paused) this._userAction(() => sync.play()); },
      pause: () => { if (!sync.state.paused) this._userAction(() => sync.pause()); },
      seekbackward: (d) => seekBy(d, -1),
      seekforward: (d) => seekBy(d, 1),
      seekto: (d) => { if (Number.isFinite(d?.seekTime)) this._userAction(() => sync.seek(d.seekTime)); },
    } : {};
    for (const action of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto']) {
      try {
        navigator.mediaSession.setActionHandler(action, handlers[action] || null);
      } catch {
        /* action not supported */
      }
    }
    try {
      navigator.mediaSession.metadata = on && typeof MediaMetadata !== 'undefined' ? new MediaMetadata({ title: file.name }) : null;
    } catch {
      /* ignore */
    }
  }

  /** Chrome's PiP play/pause button reflects this, so keep it equal to the shared state. */
  _updatePlaybackState() {
    if (!('mediaSession' in navigator)) return;
    const on = !!this.sync.localFile && this.player.loaded;
    try {
      navigator.mediaSession.playbackState = on ? (this.sync.state.paused ? 'paused' : 'playing') : 'none';
    } catch {
      /* ignore */
    }
  }
}
