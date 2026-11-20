// Keyboard shortcuts.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { $ } from './util.js';
import { ScreenShare } from '../media.js';

// Elements that Space activates by itself.
const ACTIVATES_ON_SPACE = 'button, a[href], summary, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"]';

function modalOpen(doc) {
  for (const d of doc?.querySelectorAll('dialog[open]') || []) {
    try {
      if (d.matches(':modal')) return true;
    } catch {
      return true; // no :modal support: every open dialog counts
    }
  }
  return false;
}

export class Keyboard {
  _initKeyboard() {
    // Also attached to the Picture-in-Picture document while it is open.
    this._onKeydown = (e) => {
      if (this.left) return; // the page stays open on "You left the room": no camera, mic or fullscreen from here
      if (e.target.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
      // A modal dialog owns the keyboard, even when focus is on the page behind it (after a click on the backdrop).
      if (modalOpen(e.target.ownerDocument)) return;
      // Space on a focused button, link or similar presses that control: it must not pause the movie for everyone.
      if (e.key === ' ' && e.target.closest(ACTIVATES_ON_SPACE)) return;
      const movie = !$('stage').hidden && this.sync.fileMatches;
      // Caps Lock gives "K" without Shift: the same shortcut. Shift + letter stays free.
      const key = e.key.length === 1 && !e.shiftKey ? e.key.toLowerCase() : e.key;
      switch (key) {
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
        case 's':
          if (!ScreenShare.supported) return;
          this.toggleScreen();
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
