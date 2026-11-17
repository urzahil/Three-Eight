// Picture-in-picture: Document PiP (floating window), compact PiP and native video PiP.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { CompactPip } from '../player/compactpip.js';
import { $, store, toast, icon, setIcon, pipState } from './util.js';

export class Pip {
  _initPip() {
    const video = this.player.video;
    const documentPip = 'documentPictureInPicture' in window;
    const nativePip = !!document.pictureInPictureEnabled;
    this.pipMode = documentPip ? 'document' : nativePip ? 'native' : null;
    $('m-pip').hidden = !this.pipMode;
    $('m-pip').onclick = () => this.togglePip();
    if (!documentPip && !('pictureInPictureEnabled' in document)) {
      // Firefox: its own PiP button renders the caption track, so keep it
      // showing, but hide Firefox's in-page rendering (our overlay draws it).
      document.documentElement.classList.add('native-cue-hidden');
      this.player.setNativeCaptionsMode('showing');
    }
    video.addEventListener('enterpictureinpicture', () => this._refreshPip());
    video.addEventListener('leavepictureinpicture', () => this._refreshPip());
    // Compact mode puts a proxy <video> in PiP, not the movie element.
    document.addEventListener('enterpictureinpicture', () => this._refreshPip(), true);
    document.addEventListener('leavepictureinpicture', () => this._refreshPip(), true);
  }

  togglePip() {
    if (pipState.window || this.compactPip) return this.closePip();
    if (!this.player.loaded) return;
    if (this.pipMode === 'document') return store.get('pipStyle', 'floating') === 'compact' ? this._openCompactPip() : this._openDocumentPip();
    if (this.pipMode === 'native') return this._toggleNativePip();
  }

  closePip() {
    pipState.window?.close();
    this.compactPip?.close();
  }

  /** Canvas-based native PiP: no browser title bar, play/pause only. Must run inside the click handler. */
  async _openCompactPip() {
    if (this._pipOpening) return;
    this._pipOpening = true;
    const pip = new CompactPip(this.player, { subScale: store.get('subScale', 1) });
    this.compactPip = pip;
    pip.addEventListener('close', () => {
      if (this.compactPip === pip) this.compactPip = null;
      this._refreshPip();
      this._updatePlaybackState();
    });
    // The PiP buttons may toggle the proxy <video> directly (outside Media Session handlers).
    pip.addEventListener('userpause', () => {
      if (!this.sync.state.paused) this._userAction(() => this.sync.pause());
      pip.resume(); // keep the PiP picture updating
    });
    pip.addEventListener('userplay', () => {
      if (this.sync.state.paused) this._userAction(() => this.sync.play());
    });
    try {
      await pip.open();
    } catch (err) {
      console.warn('Could not open compact picture-in-picture', err);
      pip.close();
      toast('Picture-in-picture is not available for this video.', 'warn');
      return;
    } finally {
      this._pipOpening = false;
    }
    this._refreshPip();
    this._updatePlaybackState();
  }

  async _toggleNativePip() {
    const v = this.player.video;
    try {
      if (document.pictureInPictureElement === v) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch (err) {
      console.warn('Picture-in-picture failed', err);
      toast('Picture-in-picture is not available for this video.', 'warn');
    }
  }

  async _openDocumentPip() {
    if (this._pipOpening) return;
    this._pipOpening = true;
    const box = $('movie-box');
    const v = this.player.video;
    const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
    const width = 480;
    const height = Math.max(200, Math.min(600, Math.round(width / aspect)));
    let win;
    try {
      win = await documentPictureInPicture.requestWindow({ width, height });
      await this._preparePipDocument(win.document);
    } catch (err) {
      console.warn('Could not open the floating window', err);
      win?.close();
      toast('Could not open the floating window.', 'warn');
      return;
    } finally {
      this._pipOpening = false;
    }
    // Leaving the room or closing the movie while the window was being set up: don't move the movie box into it.
    if (win.closed || this.left || !this.player.loaded) {
      win.close();
      return;
    }

    const placeholder = document.createElement('div');
    placeholder.id = 'pip-placeholder';
    placeholder.className = 'pip-placeholder';
    placeholder.append(this._overlay('Playing in a floating window', 'The movie, its subtitles and the controls are in their own window.', 'Bring it back', () => this.closePip()));

    pipState.window = win;
    pipState.document = win.document;
    $('stage').append(placeholder);
    this._moveMovieBox(() => pipState.document.body.append(box), win);
    for (const [type, fn] of [['keydown', this._onKeydown], ['click', this._onDocClick]]) pipState.document.addEventListener(type, fn);
    win.addEventListener('resize', () => this.player.renderer.layout());
    win.setInterval(() => this._renderTime(), 250); // the main tab's timers may be throttled
    win.addEventListener('pagehide', () => this._onPipClosed(), { once: true });
    this._refreshPip();
  }

  /** Make the PiP document look like the page: same styles and icon sprite. */
  async _preparePipDocument(doc) {
    doc.title = this.sync.localFile?.name || document.title;
    doc.body.className = 'pip-window';
    if (document.documentElement.dataset.ui) doc.documentElement.dataset.ui = document.documentElement.dataset.ui;
    const sprite = document.body.querySelector(':scope > svg');
    if (sprite) doc.body.prepend(doc.importNode(sprite, true));
    const loads = [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => {
      const copy = link.cloneNode(true);
      copy.href = link.href; // absolute: the new document's base URL is not ours
      doc.head.append(copy);
      return new Promise((resolve) => {
        copy.addEventListener('load', resolve);
        copy.addEventListener('error', resolve);
      });
    });
    await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 1500))]);
  }

  /**
   * Moving a <video> between documents can pause it: don't let that look like a
   * user action, then resume if the room is playing.
   */
  _moveMovieBox(move, win) {
    this.sync.expectMediaChange(2000);
    move();
    this.player.renderer.layout();
    this.player.kickRenderLoop();
    if (win) win.requestAnimationFrame?.(() => this.player.renderer.layout());
    if (!this.sync.state.paused && this.player.paused) this.player.play().catch(() => {});
  }

  _onPipClosed() {
    if (!pipState.window) return;
    const box = $('movie-box');
    pipState.window = null;
    pipState.document = null;
    document.getElementById('pip-placeholder')?.remove();
    this._moveMovieBox(() => $('stage').prepend(box));
    this.sync.expectMediaChange(2000);
    this._refreshPip();
  }

  _refreshPip() {
    const pe = document.pictureInPictureElement;
    const active = !!pipState.window || (!!pe && (pe === this.player.video || pe === this.compactPip?.proxy));
    const btn = $('m-pip');
    btn.classList.toggle('active', active);
    setIcon(btn, active ? 'pip-exit' : 'pip');
    btn.title = active ? (pipState.window ? 'Return to page (p)' : 'Exit picture-in-picture (p)') : 'Picture-in-picture (p)';
  }
}
