// Keyboard shortcuts.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { $ } from './util.js';
import { ScreenShare } from '../media.js';

/**
 * Every shortcut, as the "?" list shows it and README.md and docs/movie-player.md document it (test/shortcuts.test.mjs
 * checks both, and that the handler below acts on each). `keys`: what to press, as written in the documentation;
 * `codes`: the KeyboardEvent.key values; `movie`: only while you have joined the movie that is playing; `available`:
 * whether this browser has it (else the list leaves it out). `{step}` is the seek step chosen in Settings.
 */
export const SHORTCUTS = [
  { keys: ['Space', 'k'], codes: [' ', 'k'], action: 'Play / pause', movie: true },
  { keys: ['←', '→'], codes: ['ArrowLeft', 'ArrowRight'], action: 'Back / forward {step} s', movie: true },
  { keys: ['j', 'l'], codes: ['j', 'l'], action: 'Back / forward {step} s (like ← / →)', movie: true },
  { keys: ['↑', '↓'], codes: ['ArrowUp', 'ArrowDown'], action: 'Movie volume up / down (only for you)', movie: true },
  { keys: ['p'], codes: ['p'], action: 'Picture-in-picture on / off', movie: true, available: (room) => !!room.pipMode },
  { keys: ['f'], codes: ['f'], action: 'Full screen on / off' },
  { keys: ['m'], codes: ['m'], action: 'Microphone on / off' },
  { keys: ['v'], codes: ['v'], action: 'Camera on / off' },
  { keys: ['s'], codes: ['s'], action: 'Share your screen on / off', available: () => ScreenShare.supported },
  { keys: ['c'], codes: ['c'], action: 'Open / close the chat' },
  { keys: ['?'], codes: ['?'], action: 'Show this list' },
];

const VOLUME_STEP = 0.05;

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
      // Caps Lock gives "K" without Shift: the same shortcut. Shift + letter stays free ("?" is Shift + "/" on many
      // layouts, and not a letter).
      const key = e.key.length === 1 && !e.shiftKey ? e.key.toLowerCase() : e.key;
      switch (key) {
        case ' ':
        case 'k':
          if (!movie) return;
          this._userAction(() => this.sync.toggle());
          break;
        case 'ArrowLeft':
        case 'j':
          if (!movie) return;
          this.sync.seek(Math.max(0, this._pos() - this.seekStep));
          break;
        case 'ArrowRight':
        case 'l':
          if (!movie) return;
          this.sync.seek(this._pos() + this.seekStep);
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          if (!movie) return; // otherwise the arrows scroll the page as usual
          this._stepMovieVolume(key === 'ArrowUp' ? VOLUME_STEP : -VOLUME_STEP);
          break;
        case '?':
          // Not from the floating window: the list opens in the main window, which may be hidden behind others.
          if (e.target.ownerDocument !== document) return;
          this.openShortcuts();
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

  /** The "?" list: what works in this browser, with the seek step chosen in Settings. */
  openShortcuts() {
    const rows = SHORTCUTS.filter((s) => !s.available || s.available(this)).map((s) => {
      const tr = document.createElement('tr');
      const keys = document.createElement('td');
      s.keys.forEach((k, i) => {
        if (i) keys.append(' / ');
        const kbd = document.createElement('kbd');
        kbd.textContent = k;
        keys.append(kbd);
      });
      const action = document.createElement('td');
      action.textContent = s.action.replace('{step}', this.seekStep) + (s.movie ? ' *' : '');
      tr.append(keys, action);
      return tr;
    });
    $('keys-list').replaceChildren(...rows);
    $('keys-dialog').showModal();
  }
}
