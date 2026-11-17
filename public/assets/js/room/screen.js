// Screen sharing: one person at a time, and never while a movie is open (both use the stage).
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.
//
// Who shares is part of each person's profile (`screen`: the time the share started on the room clock, or 0).
// A share starts only from our own click or key press, never from a message. If two people start at nearly the
// same moment, the later one (by start time, then by id) stops its own share; if a movie starts during a share
// (a race, or an older client), the sharer stops.

import { ScreenShare } from '../media.js';
import { $, toast, setIcon } from './util.js';

export class Screen {
  _initScreen() {
    this.screen = new ScreenShare();
    this.screenSince = 0; // room-clock time our share started, 0 when not sharing
    this._screenStreamShown = null;
    $('t-share').hidden = !ScreenShare.supported;
    $('t-share').onclick = () => this.toggleScreen();
    $('screen-stop').onclick = () => this.screen.stop();
    $('screen-full').onclick = () => this._toggleScreenFullscreen();
    $('screen-video').addEventListener('dblclick', () => this._toggleScreenFullscreen());

    this.screen.addEventListener('change', async () => {
      this.screenSince = this.screen.active ? this.signaling.now() : 0;
      this._renderScreen(); // at once: the picker is closed
      await this.mesh.setScreenTrack(this.screen.track);
      if (this.left) return;
      this._broadcastProfile();
      this._renderPeople();
      if (this.screen.active) this._screenConflicts();
    });
    this.mesh.addEventListener('track', () => this._renderScreen());
    this.mesh.addEventListener('peer-removed', () => this._renderScreen());
    this.mesh.addEventListener('message', (e) => {
      if (e.detail.msg.type !== 'profile') return; // Tiles has stored it already (its listener comes first)
      this._screenConflicts();
      this._renderScreen();
    });
    this.sync.addEventListener('state', () => this._screenConflicts());
    this._renderScreen();
  }

  /** A movie is open, opening, or chosen by the room. */
  _movieActive() {
    return !!this.sync.state.movie || !!this.sync.localFile || !!this.loadingMovie;
  }

  /** Id of the friend who shares (the earliest, if a race left two), or null. */
  _remoteSharer() {
    let best = null;
    for (const id of this.mesh.peers.keys()) {
      const since = this.profiles.get(id)?.screen || 0;
      if (!since) continue;
      if (!best || since < best.since || (since === best.since && id < best.id)) best = { id, since };
    }
    return best;
  }

  /** Id of whoever shares their screen (us included), or null. */
  _sharer() {
    return this.screen?.active ? this.id : this._remoteSharer()?.id || null;
  }

  /** Our share gives way to a movie, and to a friend who started sharing first. */
  _screenConflicts() {
    if (!this.screen?.active) return;
    if (this._movieActive()) {
      this.screen.stop();
      toast('Screen sharing stopped: a movie was started.', 'warn');
      return;
    }
    const other = this._remoteSharer();
    if (other && (other.since < this.screenSince || (other.since === this.screenSince && other.id < this.id))) {
      this.screen.stop();
      toast(`${this.profileOf(other.id).name} started sharing first. Only one person can share at a time.`, 'warn');
    }
  }

  async toggleScreen() {
    if (this.screen.active) return this.screen.stop();
    if (this.screen.pending || !ScreenShare.supported) return;
    if (this._movieActive()) return toast('Close the movie first: a movie and a screen share can’t run at the same time.', 'warn');
    const other = this._remoteSharer();
    if (other) return toast(`${this.profileOf(other.id).name} is sharing their screen. Only one person can share at a time.`, 'warn');
    this._renderShareButton();
    try {
      await this.screen.start();
    } catch (err) {
      // Closing the picker without choosing is a NotAllowedError too: say nothing then.
      if (err.name === 'NotAllowedError' && /system/i.test(err.message)) toast('Your system blocked screen recording. Allow it for this browser in the system settings, then try again.', 'warn', 10000);
      else if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast('Could not share the screen: ' + (err.message || err.name), 'warn');
    }
    this._renderShareButton();
  }

  /** Before a movie starts: false, with a message, while anyone shares their screen. */
  _screenAllowsMovie() {
    const id = this._sharer();
    if (!id) return true;
    toast(id === this.id ? 'Stop sharing your screen first: a movie and a screen share can’t run at the same time.' : `${this.profileOf(id).name} is sharing their screen. Start the movie when they stop.`, 'warn');
    return false;
  }

  _renderShareButton() {
    const btn = $('t-share');
    const on = !!this.screen?.active;
    btn.classList.toggle('active', on);
    setIcon(btn, on ? 'screen-off' : 'screen');
    btn.querySelector('span').textContent = on ? 'Stop sharing' : 'Share screen';
    btn.disabled = !!this.screen?.pending;
  }

  _renderScreen() {
    if (!this.screen) return; // before _initScreen
    this._renderShareButton();
    const id = this._movieActive() ? null : this._sharer(); // the movie has the stage
    const box = $('screen-box');
    const video = $('screen-video');
    const wasHidden = $('screen-stage').hidden;
    $('screen-stage').hidden = !id;
    let stream = null;
    if (id === this.id) {
      if (this._ownScreen?.getVideoTracks()[0] !== this.screen.track) this._ownScreen = new MediaStream([this.screen.track]);
      stream = this._ownScreen;
      $('screen-label').textContent = 'Your screen';
    } else if (id) {
      stream = this.mesh.peers.get(id)?.screenStream || null;
      $('screen-label').textContent = `${this.profileOf(id).name}’s screen`;
    }
    box.classList.toggle('mine', id === this.id);
    $('screen-mine').hidden = id !== this.id;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      if (stream) video.play().catch(() => {});
    }
    if (!id && (document.fullscreenElement || document.webkitFullscreenElement) === box) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    $('main').classList.toggle('watching', this._movieActive() || !!id);
    if (wasHidden !== !id) this._layout();
  }

  _toggleScreenFullscreen() {
    const box = $('screen-box');
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (box.requestFullscreen || box.webkitRequestFullscreen)?.call(box)?.catch?.(() => {});
  }
}
