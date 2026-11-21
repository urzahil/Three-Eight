// The settings dialog and the preferences it controls.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { $, store, setIcon, toast } from './util.js';
import { SUBTITLE_ENCODINGS } from '../player/subtitles.js';

const MAX_SUB_DELAY = 600; // seconds either way
const SUB_DELAY_MOVIES = 50; // movies whose subtitle delay is remembered

export class Settings {
  _updateSeekTitles() {
    $('m-back').title = `Back ${this.seekStep} s (←)`;
    $('m-fwd').title = `Forward ${this.seekStep} s (→)`;
  }

  _initSettings() {
    const onFs = () => {
      const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      document.body.classList.toggle('fullscreen', fs);
      setIcon($('m-full'), fs ? 'shrink' : 'expand');
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);

    const subScale = store.get('subScale', 1);
    $('subs-layer').style.setProperty('--sub-scale', subScale);
    $('set-subsize').value = String(subScale);
    const seekStep = Number(store.get('seekStep', 10));
    this.seekStep = [5, 10, 15, 30, 60].includes(seekStep) ? seekStep : 10;
    $('set-seekstep').value = String(this.seekStep);
    this._updateSeekTitles();
    $('set-lowband').checked = store.get('lowBandwidth', false);
    this.mesh.setLowPower($('set-lowband').checked);
    $('set-noise').checked = this.media.processing;
    $('set-share').checked = this.swarm.share;
    $('set-share').onchange = (e) => {
      this.swarm.setShare(e.target.checked);
      store.set('shareFile', e.target.checked);
    };

    $('set-audio-dev').onchange = (e) => this._changeDevice('audio', e.target.value);
    $('set-video-dev').onchange = (e) => this._changeDevice('video', e.target.value);
    $('set-noise').onchange = (e) => {
      this.media.setProcessing(e.target.checked);
      store.set('processing', e.target.checked);
    };
    $('set-lowband').onchange = (e) => {
      this.mesh.setLowPower(e.target.checked);
      store.set('lowBandwidth', e.target.checked);
    };
    $('set-subsize').onchange = (e) => {
      $('subs-layer').style.setProperty('--sub-scale', e.target.value);
      store.set('subScale', Number(e.target.value));
      this.compactPip?.setSubScale(e.target.value);
    };
    $('set-seekstep').onchange = (e) => {
      this.seekStep = Number(e.target.value);
      store.set('seekStep', this.seekStep);
      this._updateSeekTitles();
    };
    // Only browsers with Document PiP have a choice of style.
    $('set-pipstyle-label').hidden = this.pipMode !== 'document';
    $('set-pipstyle').value = store.get('pipStyle', 'floating') === 'compact' ? 'compact' : 'floating';
    $('set-pipstyle').onchange = (e) => {
      store.set('pipStyle', e.target.value);
      this.closePip(); // the next click uses the new style
    };
    // Older subtitle files are in a code page; "Automatic" recognises the common ones (see decodeSubtitleBytes).
    const enc = $('set-subenc');
    enc.replaceChildren(...SUBTITLE_ENCODINGS.map(([id, label]) => new Option(label, id)));
    const savedEnc = store.get('subEncoding', 'auto');
    enc.value = SUBTITLE_ENCODINGS.some(([id]) => id === savedEnc) ? savedEnc : 'auto';
    enc.onchange = (e) => store.set('subEncoding', e.target.value === 'auto' ? null : e.target.value);
    $('set-subdelay').oninput = (e) => {
      const v = Number(e.target.value);
      const delay = Number.isFinite(v) ? Math.max(-MAX_SUB_DELAY, Math.min(MAX_SUB_DELAY, v)) : 0;
      this.player.subtitleDelay = delay;
      this._saveSubDelay(delay);
    };
    // A delay belongs to one movie (one file's subtitles): another movie starts with its own, or none.
    this.sync.addEventListener('state', () => this._restoreSubDelay());
    this._restoreSubDelay();
    $('settings-dialog').addEventListener('close', () => {
      const name = $('set-name').value.trim().slice(0, 40);
      if (name && name !== this.name) {
        this.name = name;
        store.set('name', name);
        this.signaling.rename(name);
        this._broadcastProfile();
        this._updateTile(this.id);
        this._renderPeople();
      }
    });
  }

  /** Which movie a subtitle delay is kept for: its fingerprint, its Drive file, or its name and size. '' without one. */
  _subDelayKey() {
    const m = this.sync.state.movie;
    if (!m) return '';
    return m.fp || (m.drive?.id ? `d:${m.drive.id}` : `${m.name}:${m.size}`);
  }

  _savedSubDelays() {
    const list = store.get('subDelays', []);
    return Array.isArray(list) ? list.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1])) : [];
  }

  /** The room's movie changed (or closed): use the delay this browser kept for it, else none. */
  _restoreSubDelay() {
    const key = this._subDelayKey();
    if (key === this._subDelayFor) return;
    this._subDelayFor = key;
    const saved = key ? this._savedSubDelays().find((e) => e[0] === key)?.[1] : 0;
    const delay = Number.isFinite(saved) ? saved : 0;
    this.player.subtitleDelay = delay;
    $('set-subdelay').value = String(delay);
  }

  /** Keep the delay for the current movie (the most recent SUB_DELAY_MOVIES movies). */
  _saveSubDelay(delay) {
    const key = this._subDelayKey();
    if (!key) return;
    const list = this._savedSubDelays().filter((e) => e[0] !== key);
    if (delay) list.push([key, delay]);
    store.set('subDelays', list.length ? list.slice(-SUB_DELAY_MOVIES) : null);
  }

  async _changeDevice(kind, deviceId) {
    if (!(await this.media.setDevice(kind, deviceId))) toast(`Could not start that ${kind === 'audio' ? 'microphone' : 'camera'}.`, 'warn');
    $(`set-${kind}-dev`).value = this.media.currentDeviceId(kind); // the device actually in use
    store.set('media', { ...store.get('media', {}), [kind === 'audio' ? 'audioDevice' : 'videoDevice']: this.media.deviceIds[kind] });
  }

  async openSettings() {
    $('set-name').value = this.name;
    const d = await this.media.devices();
    for (const kind of ['audio', 'video']) {
      const sel = $(`set-${kind}-dev`);
      sel.replaceChildren(...d[kind].map((dev, i) => new Option(dev.label || `${kind === 'audio' ? 'Microphone' : 'Camera'} ${i + 1}`, dev.deviceId)));
      sel.value = this.media.currentDeviceId(kind);
    }
    $('settings-dialog').showModal();
  }
}
