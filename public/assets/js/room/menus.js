// The audio and subtitle menus of the movie controls.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { subtitleMatches } from '../drive.js';
import { $, icon, fmtSize } from './util.js';

// The menu buttons of the movie controls and their menus.
const MENUS = [['m-audio', 'm-audio-menu'], ['m-subs', 'm-subs-menu']];

export class MovieMenus {
  _initMenus() {
    for (const [btn, menu] of MENUS) {
      $(btn).setAttribute('aria-haspopup', 'true');
      $(btn).setAttribute('aria-controls', menu);
      $(btn).setAttribute('aria-expanded', 'false');
      $(btn).onclick = (e) => {
        e.stopPropagation();
        this._openMenu($(menu).hidden ? menu : null);
        this._renderMenus();
      };
    }
    // Also attached to the Picture-in-Picture document while it is open.
    this._onDocClick = (e) => {
      if (!e.target.closest('.menu')) this._openMenu(null);
    };
    document.addEventListener('click', this._onDocClick);
  }

  /** Show one of the movie menus (by id), or none; their buttons say which is open (aria-expanded). */
  _openMenu(id) {
    for (const [btn, menu] of MENUS) {
      $(menu).hidden = menu !== id;
      $(btn).setAttribute('aria-expanded', String(menu === id));
    }
  }

  _menuItem(label, on, onClick, note, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = on ? 'on' : '';
    const tick = icon('check');
    tick.classList.add('tick');
    const span = document.createElement('span');
    span.textContent = label;
    b.append(tick, span);
    if (note) {
      const s = document.createElement('small');
      s.textContent = note;
      b.append(s);
    }
    b.disabled = !!disabled;
    b.onclick = (e) => {
      e.stopPropagation();
      onClick();
      this._openMenu(null);
    };
    return b;
  }

  _renderMenus() {
    const info = this.player.info;
    const s = this.sync.state;
    // Audio
    const am = $('m-audio-menu');
    const ah = document.createElement('h4');
    ah.textContent = 'Audio (changes it for everyone)';
    const audioTracks = info?.audioTracks || [];
    am.replaceChildren(ah, ...(audioTracks.length
      ? audioTracks.map((t) => this._menuItem(t.label, s.audio === t.index, () => this.sync.setAudio(t.index), t.supported ? '' : t.note || 'not playable here'))
      : [this._menuItem(this.player.loaded ? 'Default' : 'Load the movie first', true, () => {}, '', true)]));
    $('m-audio').hidden = audioTracks.length < 2;

    // Subtitles: the room's choice, then our own (which only changes what this browser shows).
    const sm = $('m-subs-menu');
    const sh = document.createElement('h4');
    sh.textContent = 'Subtitles (changes it for everyone)';
    const tracks = [];
    for (const t of info?.subtitleTracks || []) {
      let note = '';
      if (t.unsupported) note = ['not available when streaming', 'could not be loaded'].includes(t.unsupported) ? t.unsupported : 'not supported';
      else if (t.waiting) note = 'loads when selected'; // streaming: read on demand
      else if (t.progress < 1) note = `loading ${Math.round(t.progress * 100)}%`;
      else if (t.source === 'external') note = 'file';
      else if (t.source === 'private') note = 'only for you';
      tracks.push({ id: t.id, label: t.label, note, disabled: !!t.unsupported, mine: t.source === 'private' });
    }
    // Shared subtitle files we haven't received yet.
    for (const f of s.subFiles) {
      if (!info?.subtitleTracks.some((t) => t.id === f.id)) tracks.push({ id: f.id, label: f.name, note: 'receiving…', disabled: true });
    }
    const items = [this._menuItem('Off', !s.sub, () => this.sync.setSubtitle(null))];
    // Files loaded just for us stay out of the room's list: nobody else could show them.
    for (const t of tracks) if (!t.mine) items.push(this._menuItem(t.label, s.sub === t.id, () => this.sync.setSubtitle(t.id), t.note, t.disabled));
    // Subtitle files next to the movie on Drive (ones already shared show up above as normal entries).
    const dsubs = this._driveSubtitles();
    if (dsubs) {
      const shared = new Set(s.subFiles.map((f) => f.name));
      // A folder can hold several films with their subtitles: list only this film's (none if none match).
      const files = dsubs.items.filter((f) => subtitleMatches(s.movie.name, f.name) && !shared.has(f.name));
      const dh = document.createElement('h4');
      dh.textContent = 'From Google Drive';
      if (dsubs.status === 'loading') items.push(dh, this._menuItem('Loading…', false, () => {}, '', true));
      else if (dsubs.status === 'error') items.push(dh, this._menuItem('Could not list the folder', false, () => { this._driveSubs = null; this._renderMenus(); }, 'retry'));
      else if (files.length) {
        items.push(dh);
        for (const f of files) items.push(this._menuItem(f.name, false, () => this._shareDriveSubtitle(f), fmtSize(f.size)));
      }
      if (dsubs.status === 'ok' && files.length) {
        const lh = document.createElement('h4');
        lh.textContent = 'From your device';
        items.push(lh);
      }
    }
    items.push(this._loadButton('Load subtitle file (.srt, .vtt, .ass)…', 'sub-file'));

    // Just for me: follow the room, turn subtitles off, pick another track, or load a file nobody else gets.
    if (info) {
      const mine = this.sync.mySub;
      const mh = document.createElement('h4');
      mh.textContent = 'Just for me';
      items.push(mh, this._menuItem('Same as everyone', mine === undefined, () => this.sync.setMySubtitle(undefined)));
      if (s.sub) items.push(this._menuItem('Off', mine === null, () => this.sync.setMySubtitle(null)));
      for (const t of tracks) {
        if (t.id !== s.sub) items.push(this._menuItem(t.label, mine === t.id, () => this.sync.setMySubtitle(t.id), t.note, t.disabled));
      }
      items.push(this._loadButton('Load a file just for me…', 'my-sub-file'));
    }
    sm.replaceChildren(sh, ...items);
  }

  _loadButton(label, inputId) {
    const b = document.createElement('button');
    b.type = 'button';
    b.append(icon('folder'), document.createTextNode(label));
    b.onclick = (e) => {
      e.stopPropagation();
      this._openMenu(null);
      $(inputId).click();
    };
    return b;
  }
}
