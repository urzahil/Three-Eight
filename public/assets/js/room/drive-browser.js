// The room's Google Drive folder: its client, the browser in the movie dialog and Drive subtitles.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { pickSubtitle, DriveClient } from '../drive.js';
import { $, toast, icon, fmtTime, fmtSize } from './util.js';

export class DriveBrowser {
  /**
   * Apply the room's Drive settings, { token, folder } (from the welcome message, a reconnect or an admin
   * change). null removes them. The same folder with a new token (after a reconnect) keeps the client,
   * its cached listings and the files being streamed: they read the token again for every request.
   */
  _setDrive(cfg) {
    const ok = cfg && typeof cfg === 'object' && typeof cfg.token === 'string' && typeof cfg.folder === 'string';
    const folder = ok ? cfg.folder : '';
    if (ok && this.drive && folder === this.driveFolder) {
      this.drive.setToken(cfg.token);
      return;
    }
    if (!ok && !this.drive) return;
    this.driveFolder = folder;
    this.drive = ok ? new DriveClient({ room: this.roomName, token: cfg.token, folder }) : null;
    this.driveTrail = null;
    this.driveRootName = '';
    this._driveShown = null;
    this._driveSubs = null;
    if (!this.initialized) return;
    if ($('movie-dialog').open) {
      this._renderMovieDialog();
      this._renderDriveSection();
    }
    this._renderStage();
  }

  _renderDriveSection() {
    const on = !!this.drive;
    $('drive-section').hidden = !on;
    $('movie-dialog').classList.toggle('has-drive', on);
    if (!on) return;
    if (!this.driveTrail) {
      this.driveTrail = [{ id: this.drive.folder, name: this.driveRootName || 'Drive folder' }];
      const drive = this.drive;
      drive.folderInfo().then((info) => {
        if (drive !== this.drive || !this.driveTrail) return;
        this.driveRootName = info.name;
        this.driveTrail[0].name = info.name;
        this._renderDriveCrumbs();
      }, () => { /* keep the fallback name; listing shows the real error */ });
    }
    this._renderDriveCrumbs();
    this._loadDriveFolder();
  }

  _renderDriveCrumbs() {
    const nav = $('drive-crumbs');
    nav.replaceChildren();
    const last = this.driveTrail.length - 1;
    this.driveTrail.forEach((c, i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '›';
        nav.append(sep);
      }
      if (i === last) {
        const here = document.createElement('span');
        here.className = 'here';
        here.setAttribute('aria-current', 'location');
        here.textContent = c.name;
        here.title = c.name;
        nav.append(here);
      } else {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = c.name;
        b.title = c.name;
        b.onclick = () => {
          this.driveTrail.length = i + 1;
          this._renderDriveCrumbs();
          this._loadDriveFolder();
        };
        nav.append(b);
      }
    });
  }

  async _loadDriveFolder() {
    const drive = this.drive;
    const folder = this.driveTrail[this.driveTrail.length - 1];
    const token = ++this._driveToken;
    const list = $('drive-list');
    const note = (text, cls = '') => {
      const p = document.createElement('p');
      p.className = 'muted ' + cls;
      p.textContent = text;
      return p;
    };
    this._driveShown = null;
    list.replaceChildren(note('Loading…'));
    let items;
    try {
      items = await drive.list(folder.id);
    } catch (err) {
      if (token !== this._driveToken || drive !== this.drive) return;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn';
      retry.textContent = 'Try again';
      retry.onclick = () => this._loadDriveFolder();
      list.replaceChildren(note(err.message || 'Could not load the folder.', 'error'), retry);
      return;
    }
    if (token !== this._driveToken || drive !== this.drive) return;
    this._driveShown = items;
    this._renderDriveItems();
  }

  _renderDriveItems() {
    const items = this._driveShown;
    if (!items) return;
    const list = $('drive-list');
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No videos or subtitle files in this folder.';
      list.replaceChildren(p);
      return;
    }
    const room = this.sync.state.movie;
    const canSub = !!(room || this.sync.localFile);
    const rows = items.map((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'drive-item';
      b.dataset.kind = f.kind;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = f.name;
      name.title = f.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      if (f.kind === 'video') {
        meta.textContent = [fmtSize(f.size), f.durationMs ? fmtTime(f.durationMs / 1000) : ''].filter(Boolean).join(' · ');
        if (room && (room.drive?.id === f.id || (room.size && room.size === f.size && room.name === f.name))) {
          b.classList.add('current');
          b.setAttribute('aria-current', 'true');
          meta.textContent = 'now playing' + (meta.textContent ? ' · ' + meta.textContent : '');
        }
        b.onclick = () => this._streamDriveFile(f);
      } else if (f.kind === 'subtitle') {
        meta.textContent = canSub ? 'subtitles' : 'pick a movie first';
        b.disabled = !canSub;
        b.onclick = () => this._shareDriveSubtitle(f, b);
      } else {
        b.onclick = () => {
          this.driveTrail.push({ id: f.id, name: f.name });
          this._renderDriveCrumbs();
          this._loadDriveFolder();
        };
      }
      b.append(icon(f.kind === 'folder' ? 'folder' : f.kind === 'video' ? 'film' : 'cc'), name, meta);
      return b;
    });
    list.replaceChildren(...rows);
  }

  _streamDriveFile(f) {
    let file;
    try {
      const folder = this.driveTrail[this.driveTrail.length - 1].id;
      file = this.drive.remoteFile({ ...f, folder }, this.swarm);
    } catch (err) {
      toast(err.message, 'warn');
      return;
    }
    $('movie-dialog').close('drive');
    this.chooseMovieFile(file);
  }

  async _shareDriveSubtitle(f, button) {
    if (button) button.disabled = true;
    try {
      await this._shareSubtitle(f.name, await this.drive.downloadText(f));
      if ($('movie-dialog').open) $('movie-dialog').close('subtitles');
    } catch (err) {
      toast(err.message || 'Could not download the subtitles.', 'warn', err.permanent ? 25000 : 0);
      if (button) button.disabled = false;
    }
  }

  /** Subtitle files in the folder of the room's Drive movie, for the CC menu. Listed lazily (the listing is cached). */
  _driveSubtitles() {
    const m = this.sync.state.movie;
    const folder = this.drive && m?.drive?.folder;
    if (!folder) return null;
    let st = this._driveSubs;
    if (!st || st.folder !== folder) {
      const drive = this.drive;
      st = this._driveSubs = { folder, status: 'loading', items: [] };
      drive.list(folder).then((items) => {
        st.status = 'ok';
        st.items = items.filter((f) => f.kind === 'subtitle');
      }, (err) => {
        st.status = 'error';
        st.error = err.message;
      }).then(() => {
        if (this._driveSubs === st) this._renderMenus();
      });
    }
    return st;
  }

  /** Started a movie from Drive for the room: share the subtitle file next to it, if there is a clear match. */
  async _autoDriveSubtitle(file) {
    const drive = this.drive;
    const m = file.drive;
    if (!drive || !m?.folder) return;
    let pick = null;
    try {
      pick = pickSubtitle(file.name, await drive.list(m.folder), navigator.language);
      const st = this.sync.state;
      if (!pick || drive !== this.drive || st.sub || st.subFiles.length || st.movie?.name !== file.name) return;
      await this._shareSubtitle(pick.name, await drive.downloadText(pick), `Subtitles “${pick.name}” loaded from Google Drive. Turn them off in the CC menu.`);
    } catch (err) {
      console.warn('Automatic subtitles failed', err);
      toast(`Could not load subtitles${pick ? ` “${pick.name}”` : ''} from Google Drive.`, 'warn');
    }
  }
}
