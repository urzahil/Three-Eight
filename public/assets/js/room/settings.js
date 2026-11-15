// The settings dialog and the preferences it controls.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { $, store, setIcon } from './util.js';

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
    $('set-subdelay').oninput = (e) => {
      this.player.subtitleDelay = Number(e.target.value) || 0;
    };
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

  async _changeDevice(kind, deviceId) {
    await this.media.setDevice(kind, deviceId);
    store.set('media', { ...store.get('media', {}), [kind === 'audio' ? 'audioDevice' : 'videoDevice']: deviceId });
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
