// The movie: stage, controls, seek bar, overlays, loading a file, Media Session and full screen.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { audioContext } from '../media.js';
import { sameMovie } from '../sync.js';
import { decodeSubtitleBytes, SUBTITLE_ENCODINGS } from '../player/subtitles.js';
import { $, store, toast, setIcon, fmtTime, fmtSize, randomId, hashText, pipState } from './util.js';

// How long a click on the picture waits for a second click before it plays or pauses (see _initVideoClicks).
const DOUBLE_CLICK_MS = 300;

/**
 * Subtitle file bytes as { text, note }: Unicode as such, an older code page as set in Settings or, by default,
 * recognised (see decodeSubtitleBytes). `note` names that code page for the toast, so a wrong guess can be fixed.
 */
function decodeSubtitle(bytes) {
  const { text, encoding } = decodeSubtitleBytes(bytes, { encoding: store.get('subEncoding', 'auto'), lang: navigator.language });
  const label = /^utf-/.test(encoding) ? '' : SUBTITLE_ENCODINGS.find(([id]) => id === encoding)?.[1] || encoding;
  return { text, note: label ? ` Read as ${label}: if the text looks wrong, choose the file's encoding in Settings and load it again.` : '' };
}

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
    $('my-sub-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) return toast('Subtitle file is too large.', 'warn');
      const { text, note } = decodeSubtitle(new Uint8Array(await f.arrayBuffer()));
      // 'p' ids never match a shared file's 'x' id, so the room sharing the same file later can't remove ours.
      this.sync.addMySubtitleFile({ id: 'p' + (await hashText(text)), name: f.name, text });
      toast(`Subtitles “${f.name}” loaded just for you.${note}`, '', note ? 8000 : 0);
    });

    // Controls
    $('m-play').onclick = () => this._userAction(() => sync.toggle());
    $('m-back').onclick = () => this._userAction(() => sync.seek(Math.max(0, this._pos() - this.seekStep)));
    $('m-fwd').onclick = () => this._userAction(() => sync.seek(this._pos() + this.seekStep));
    this._initVideoClicks(box);
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
    // The time at the right end of the seek bar shows the film's length, or (clicked) the time remaining.
    this._showRemaining = store.get('movieRemaining', false) === true;
    $('m-duration').onclick = () => {
      this._showRemaining = !this._showRemaining;
      store.set('movieRemaining', this._showRemaining || null);
      this._renderTime();
    };
    this._initSeekBar();
    this._initMenus();

    // Hide controls when idle.
    let idleTimer = 0;
    const hide = () => {
      clearTimeout(idleTimer);
      if (!p.paused && !box.querySelector('.menu:not([hidden])')) box.classList.add('idle');
    };
    const wake = () => {
      box.classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(hide, 3000);
    };
    this._hideMovieControls = hide;
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

    this._timeTimer = setInterval(() => this._renderTime(), 250);
    this._renderStage();
  }

  _pos() {
    return this.sync.fileMatches && this.player.loaded ? this.player.time : this.sync.expectedPosition();
  }

  _userAction(fn) {
    audioContext();
    fn();
  }

  /**
   * Clicks on the picture. Play/pause is the whole room's, so a click must mean it:
   *  - mouse: a single click toggles, a double-click goes full screen only. The toggle waits DOUBLE_CLICK_MS for a
   *    second click (otherwise a double-click would pause and resume the film for everyone).
   *  - touch: a tap shows the hidden controls, or hides them when they are showing. It never plays or pauses: a
   *    tap meant to find the controls must not pause the film for everyone (the play button is right there).
   */
  _initVideoClicks(box) {
    const video = box.querySelector('video');
    let pointer = 'mouse';
    let wasIdle = false;
    let clickTimer = 0;
    // The video's own listener runs before the box's (which shows the controls): it sees whether they were hidden.
    video.addEventListener('pointerdown', (e) => {
      pointer = e.pointerType || 'mouse';
      wasIdle = box.classList.contains('idle');
    });
    video.addEventListener('click', (e) => {
      clearTimeout(clickTimer);
      if (pointer === 'touch') {
        if (!wasIdle) this._hideMovieControls?.();
        return;
      }
      if (e.detail > 1) return; // the second click of a double-click: 'dblclick' handles it
      clickTimer = setTimeout(() => this._userAction(() => this.sync.toggle()), DOUBLE_CLICK_MS);
    });
    video.addEventListener('dblclick', () => {
      clearTimeout(clickTimer);
      this.toggleFullscreen();
    });
  }

  /** Decode subtitle bytes and share them with the room (from a local file or Google Drive). */
  async _shareSubtitle(name, bytes, message) {
    const { text, note } = decodeSubtitle(bytes);
    const id = 'x' + (await hashText(text));
    this.sync.addSubtitleFile({ id, name, text });
    toast((message || `Subtitles “${name}” shared with everyone.`) + note, '', note ? 8000 : 0);
  }

  openMovieDialog() {
    // Choosing a movie while someone shares their screen is refused (closing or joining one is not affected).
    if (!this.sync.state.movie && !this.sync.localFile && !this._screenAllowsMovie()) return;
    this._renderMovieDialog();
    this._renderDriveSection();
    const d = $('movie-dialog');
    // The close handler acts on returnValue, and closing with Esc (or a phone's back gesture) leaves it as it was
    // (HTML spec; Firefox and Safari follow it): without this, Esc would repeat the last choice, e.g. "Close the
    // movie for everyone".
    d.returnValue = '';
    d.showModal();
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

  /** The subtitle we show (the room's or our own) is an embedded track we lack, and someone has it: get it from them. */
  _wantCues() {
    const id = this.sync.subtitle;
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
    if (asRoom && !this._screenAllowsMovie()) {
      file.close?.();
      return;
    }
    // A file of another name is asked about now; one with the same name (often a re-encode of the same film)
    // once its duration is known, below.
    let asked = false;
    if (s.movie && !sameMovie(quick, s.movie) && file.name !== s.movie.name) {
      asked = true;
      const choice = await this._askMismatch(`Everyone else is watching “${s.movie.name}” (${fmtSize(s.movie.size)}), but you picked “${file.name}” (${fmtSize(file.size)}).`);
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
      toast(err.userMessage || (file.remote && err.remote ? err.message : 'Could not open this file: ' + (err.message || err)), 'warn', err.permanent ? 25000 : 0);
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
    const room = this.sync.state.movie;
    if (!asRoom && !asked && room && !sameMovie(info, room)) {
      // Same name, but the length (or the content) says it is another film: ask, rather than quietly playing it
      // for us alone.
      const len = (m) => (m.duration ? `, ${fmtTime(m.duration)}` : '');
      const choice = await this._askMismatch(`Everyone else is watching “${room.name}” (${fmtSize(room.size)}${len(room)}). Your “${file.name}” has the same name but is a different file (${fmtSize(file.size)}${len(info)}).`);
      if (this.player.file !== file) return; // another file was picked meanwhile
      if (choice === 'cancel') {
        this.player.unload();
        this._renderStage();
        return;
      }
      asRoom = choice === 'room';
    }
    this.sync.setLocalFile(info, asRoom);
    if (asRoom && file.drive?.folder) this._autoDriveSubtitle(file); // in the background: never holds up playback
    if (asRoom) {
      const msg = { id: randomId(), from: this.id, name: this.name, text: `🎬 Started a movie: ${file.name}`, ts: this.signaling.now() };
      this._addChat(msg); // in our own log too, like everything else we say
      this.mesh.broadcast({ type: 'chat', msg });
    }
    this._renderStage();
    this._renderMenus();
  }

  /** Show the "different file" dialog; resolves 'mine', 'room' or 'cancel'. */
  _askMismatch(text) {
    $('mismatch-text').textContent = text;
    return new Promise((resolve) => {
      const d = $('mismatch-dialog');
      d.addEventListener('close', () => resolve(d.returnValue), { once: true });
      d.returnValue = 'cancel';
      d.showModal();
    });
  }

  _renderStage() {
    const s = this.sync.state;
    const active = !!s.movie || !!this.sync.localFile || !!this.loadingMovie;
    const wasHidden = $('stage').hidden;
    $('stage').hidden = !active;
    this._renderScreen(); // the screen share gives way to the movie; also sets the 'watching' layout
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
    // At the end the room's state still says "playing", but there is nothing left to pause: offer Play (again).
    const playing = !this.sync.state.paused && !this.sync.atEnd();
    if (playing === this._shownPlaying) return; // called by the time ticker too
    this._shownPlaying = playing;
    setIcon($('m-play'), playing ? 'pause' : 'play');
  }

  _refreshVolume() {
    const v = this.player.video;
    setIcon($('m-mute'), v.muted || v.volume === 0 ? 'volume-off' : 'volume');
    $('m-volume').value = v.muted ? 0 : v.volume;
  }

  /** ↑ / ↓: the movie's volume, only for us (like the slider), shown over the picture for a moment. Up also unmutes. */
  _stepMovieVolume(delta) {
    const v = this.player.video;
    v.volume = Math.round(Math.max(0, Math.min(1, v.volume + delta)) * 100) / 100;
    if (delta > 0) v.muted = false;
    store.set('movieVolume', v.volume);
    this._refreshVolume();
    this._flashMovieNote(v.muted ? `Muted (volume ${Math.round(v.volume * 100)}%)` : `Volume ${Math.round(v.volume * 100)}%`);
  }

  /** A short note over the picture (also in full screen and in the floating window, which hold the movie box). */
  _flashMovieNote(text) {
    const el = $('m-note');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(this._movieNoteTimer);
    this._movieNoteTimer = setTimeout(() => { el.hidden = true; }, 1200);
  }

  _renderTime() {
    if ($('stage').hidden || this._dragging) return;
    const d = this.sync.state.movie?.duration || this.player.duration || 0;
    const t = this._pos();
    this._showTimes(t, d);
    $('m-progress').style.width = d ? `${Math.min(100, (t / d) * 100)}%` : '0';
    this._refreshPlayButton(); // the room's clock reaches the end without any media event
    const b = this.player.loaded ? this.player.buffered.find(([a, e]) => a <= t + 0.5 && e >= t) : null;
    $('m-buffered').style.left = b && d ? `${(b[0] / d) * 100}%` : '0';
    $('m-buffered').style.width = b && d ? `${((b[1] - b[0]) / d) * 100}%` : '0';
  }

  /** Writes the elapsed time and, at the right end of the seek bar, the length or the time remaining. */
  _showTimes(t, d) {
    $('m-time').textContent = fmtTime(t);
    $('m-duration').textContent = this._showRemaining ? `\u2212${fmtTime(Math.ceil(Math.max(0, d - t)))}` : fmtTime(d);
    // The seek bar is a slider for assistive technology too: its value, in whole seconds (no chatter in between).
    const now = Math.floor(t);
    const max = Math.floor(d);
    if (now === this._ariaSeek?.now && max === this._ariaSeek?.max) return;
    this._ariaSeek = { now, max };
    const bar = $('m-seek');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(max));
    bar.setAttribute('aria-valuenow', String(Math.min(now, max || now)));
    bar.setAttribute('aria-valuetext', max ? `${fmtTime(t)} of ${fmtTime(d)}` : fmtTime(t));
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
        this._showTimes(timeAt(e.clientX), d);
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
      if (e.key === 'ArrowLeft') this.sync.seek(Math.max(0, this._pos() - this.seekStep));
      else if (e.key === 'ArrowRight') this.sync.seek(this._pos() + this.seekStep);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  _announce({ peer, prev, state, resetMine }) {
    const who = this.profileOf(peer.id).name;
    const by = state.by === peer.id ? who : this.profileOf(state.by).name;
    if (!sameMovie(prev.movie, state.movie)) {
      if (state.movie) {
        // Joining a room that already plays a film: `by` is whoever acted last (paused, seeked...), not who
        // started it, so nobody is named. Whether a friend's copy can be streamed is only known once they
        // announce it, so it is not promised either.
        const joined = prev.seq === 0;
        const how = this.drive && state.movie.drive ? 'Stream it from Google Drive' : state.movie.size > 0 ? 'Open your copy, or stream it from a friend who shares theirs,' : 'Open your copy';
        toast(`${joined ? 'The room is watching' : `${by} started`} “${state.movie.name}”. ${how} to watch along.`);
      } else toast(`${by} closed the movie.`);
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
      const mine = resetMine ? '. Your own subtitle choice was reset.' : '';
      toast((state.sub ? `${by} turned on subtitles${t ? ': ' + t.label : ''}` : `${by} turned subtitles off`) + mine);
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
