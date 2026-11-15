// The audio and subtitle menus of the movie controls.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { subtitleMatches } from '../drive.js';
import { $, icon, fmtSize } from './util.js';

export class MovieMenus {
  _initMenus() {
    const pairs = [['m-audio', 'm-audio-menu'], ['m-subs', 'm-subs-menu']];
    for (const [btn, menu] of pairs) {
      $(btn).onclick = (e) => {
        e.stopPropagation();
        const m = $(menu);
        const open = m.hidden;
        for (const [, other] of pairs) $(other).hidden = true;
        m.hidden = !open;
        this._renderMenus();
      };
    }
    // Also attached to the Picture-in-Picture document while it is open.
    this._onDocClick = (e) => {
      if (!e.target.closest('.menu')) for (const [, m] of pairs) $(m).hidden = true;
    };
    document.addEventListener('click', this._onDocClick);
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
      for (const id of ['m-audio-menu', 'm-subs-menu']) $(id).hidden = true;
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

    // Subtitles
    const sm = $('m-subs-menu');
    const sh = document.createElement('h4');
    sh.textContent = 'Subtitles (changes it for everyone)';
    const items = [this._menuItem('Off', !s.sub, () => this.sync.setSubtitle(null))];
    for (const t of info?.subtitleTracks || []) {
      let note = '';
      if (t.unsupported) note = ['not available when streaming', 'could not be loaded'].includes(t.unsupported) ? t.unsupported : 'not supported';
      else if (t.waiting) note = 'loads when selected'; // streaming: read on demand
      else if (t.progress < 1) note = `loading ${Math.round(t.progress * 100)}%`;
      else if (t.source === 'external') note = 'file';
      items.push(this._menuItem(t.label, s.sub === t.id, () => this.sync.setSubtitle(t.id), note, !!t.unsupported));
    }
    // Shared subtitle files we haven't received yet.
    for (const f of s.subFiles) {
      if (!info?.subtitleTracks.some((t) => t.id === f.id)) items.push(this._menuItem(f.name, s.sub === f.id, () => this.sync.setSubtitle(f.id), 'receiving…', true));
    }
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
    const load = document.createElement('button');
    load.type = 'button';
    load.append(icon('folder'), document.createTextNode('Load subtitle file (.srt, .vtt, .ass)…'));
    load.onclick = (e) => {
      e.stopPropagation();
      sm.hidden = true;
      $('sub-file').click();
    };
    sm.replaceChildren(sh, ...items, load);
  }
}
