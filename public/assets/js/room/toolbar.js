// Toolbar buttons, the sidebar and its tabs.
// Methods of the Room (installed on its prototype by app.js); `this` is the Room.

import { $, store, showMessage, toast, setIcon } from './util.js';

export class Toolbar {
  _initToolbar() {
    $('t-mic').onclick = () => this.toggleMic();
    $('t-cam').onclick = () => this.toggleCam();
    $('t-chat').onclick = () => this.toggleSidebar('chat');
    $('t-movie').onclick = () => this.openMovieDialog();
    $('t-settings').onclick = () => this.openSettings();
    $('t-leave').onclick = () => {
      this.leave(true);
      showMessage('You left the room', 'Thanks for hanging out!');
      this._offerRejoin();
    };
    $('copy-link').onclick = async () => {
      const url = location.origin + '/' + encodeURIComponent(this.roomName);
      try {
        await navigator.clipboard.writeText(url);
        toast('Room link copied. Share the password separately.');
      } catch {
        prompt('Room link', url);
      }
    };
    // A microphone or camera that was unplugged while on is replaced by the default one (see LocalMedia._reopen).
    this.media.addEventListener('change', (e) => {
      if (!e.detail.ended) return;
      const audio = e.detail.kind === 'audio';
      const what = audio ? 'microphone' : 'camera';
      const track = audio ? this.media.audioTrack : this.media.videoTrack;
      if (track) toast(`Your ${what} was disconnected. Now using ${track.label ? `“${track.label}”` : 'the default one'}.`);
      else toast(`Your ${what} was disconnected.`, 'warn');
    });
    $('sidebar-close').onclick = () => this.toggleSidebar(null);
    for (const tab of document.querySelectorAll('.tab')) tab.onclick = () => this._selectTab(tab.dataset.tab);
    this._refreshToolbar();
  }

  /** A "Rejoin" button on the message screen (the lobby of this room again). */
  _offerRejoin() {
    $('message-rejoin')?.remove();
    const again = document.createElement('a');
    again.id = 'message-rejoin';
    again.className = 'btn primary';
    again.href = location.pathname;
    again.textContent = 'Rejoin';
    $('message-text').after(again);
  }

  _refreshToolbar() {
    const micOn = this.media.micOn && !!this.media.audioTrack;
    $('t-mic').classList.toggle('off', !micOn);
    setIcon($('t-mic'), micOn ? 'mic' : 'mic-off');
    $('t-mic').querySelector('span').textContent = micOn ? 'Mute' : 'Unmute';
    const camOn = !!this.media.videoTrack;
    $('t-cam').classList.toggle('off', !camOn);
    setIcon($('t-cam'), camOn ? 'cam' : 'cam-off');
    $('t-cam').querySelector('span').textContent = camOn ? 'Stop video' : 'Start video';
    $('t-chat').classList.toggle('active', !$('sidebar').hidden);
    $('t-movie').classList.toggle('active', !$('stage').hidden);
  }

  async toggleMic() {
    const ok = await this.media.toggleMic();
    if (!ok) toast('Could not access a microphone.', 'warn');
    store.set('media', { ...store.get('media', {}), mic: this.media.micOn });
  }

  async toggleCam() {
    const ok = await this.media.setCam(!this.media.camOn);
    if (!ok) toast('Could not start the camera.', 'warn');
    store.set('media', { ...store.get('media', {}), cam: this.media.camOn });
  }

  toggleSidebar(tab) {
    const sb = $('sidebar');
    if (!tab || (!sb.hidden && this.tab === tab)) sb.hidden = true;
    else {
      sb.hidden = false;
      this._selectTab(tab);
    }
    this._refreshToolbar();
    this._layout();
  }

  _selectTab(tab) {
    this.tab = tab;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === tab);
    $('tab-chat').hidden = tab !== 'chat';
    $('tab-people').hidden = tab !== 'people';
    if (tab === 'chat') {
      this.unread = 0;
      $('chat-badge').hidden = true;
      $('chat-log').scrollTop = $('chat-log').scrollHeight;
      if (matchMedia('(pointer: fine)').matches) $('chat-input').focus();
    }
    if (tab === 'people') this._renderPeople();
  }
}
