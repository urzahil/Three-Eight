// Keyboard shortcuts.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { $ } from './util.js';

export class Keyboard {
  _initKeyboard() {
    // Also attached to the Picture-in-Picture document while it is open.
    this._onKeydown = (e) => {
      if (e.target.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
      const movie = !$('stage').hidden && this.sync.fileMatches;
      switch (e.key) {
        case ' ':
        case 'k':
          if (!movie) return;
          this._userAction(() => this.sync.toggle());
          break;
        case 'ArrowLeft':
          if (!movie) return;
          this.sync.seek(Math.max(0, this._pos() - this.seekStep));
          break;
        case 'ArrowRight':
          if (!movie) return;
          this.sync.seek(this._pos() + this.seekStep);
          break;
        case 'f':
          this.toggleFullscreen();
          break;
        case 'm':
          this.toggleMic();
          break;
        case 'v':
          this.toggleCam();
          break;
        case 'c':
          this.toggleSidebar('chat');
          break;
        case 'p':
          if (!movie || !this.player.loaded || !this.pipMode) return;
          this.togglePip();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    document.addEventListener('keydown', this._onKeydown);
  }
}
