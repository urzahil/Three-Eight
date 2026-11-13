// Manual/CI check of the in-browser media pipeline in headless Chromium.
// Usage: node test/player-check.js <file> [<file>...]   (server must run on :4567)
const { chromium } = require('playwright');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:4567';

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  let failed = false;
  for (const f of process.argv.slice(2)) {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('  [console]', m.text()); });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    await page.goto(BASE + '/healthz');
    await page.setContent('<input type=file id=f><div id=stage style="position:relative;width:640px;height:360px"><video id=v muted></video><div id=o></div></div>');
    await page.setInputFiles('#f', path.resolve(f));
    const res = await page.evaluate(async (base) => {
      const { MoviePlayer } = await import(base + '/assets/js/player/player.js');
      const v = document.getElementById('v');
      const p = new MoviePlayer(v, document.getElementById('o'));
      window.p = p;
      const notices = [];
      p.addEventListener('notice', (e) => notices.push(e.detail.text));
      p.addEventListener('fatal', (e) => notices.push('FATAL ' + e.detail.text));
      await p.load(document.getElementById('f').files[0]);
      const info = p.info;
      await p.play();
      await new Promise((r) => setTimeout(r, 2500));
      const t1 = p.time;
      const audioBytes1 = v.webkitAudioDecodedByteCount;
      // switch audio
      if (info.audioTracks.length > 1) await p.setAudioTrack(1);
      await new Promise((r) => setTimeout(r, 2000));
      const t2 = p.time;
      const audioBytes2 = v.webkitAudioDecodedByteCount;
      // seek far
      p.seek(25);
      await new Promise((r) => setTimeout(r, 2000));
      const t3 = p.time;
      // subtitles
      const subs = p.info.subtitleTracks;
      let subText = '';
      if (subs.length) {
        p.setSubtitle(subs[0].id);
        p.seek(21);
        await new Promise((r) => setTimeout(r, 800));
        subText = document.getElementById('o').innerText;
      }
      // seek back
      p.seek(2);
      await new Promise((r) => setTimeout(r, 1500));
      const t4 = p.time;
      return {
        mode: info.mode, duration: info.duration,
        audio: info.audioTracks.map((a) => `${a.label} [${a.supported ? 'ok' : 'unsupported'}]`),
        subs: p.info.subtitleTracks.map((s) => `${s.id} ${s.label} cues=${p.subtitles.get(s.id).cues.length} ${s.unsupported || ''}`),
        t1, t2, t3, t4, audioBytes1, audioBytes2, subText,
        frames: v.getVideoPlaybackQuality().totalVideoFrames, dropped: v.getVideoPlaybackQuality().droppedVideoFrames,
        err: v.error && v.error.message, notices,
      };
    }, BASE);
    console.log(f, JSON.stringify(res, null, 1));
    if (!(res.t1 > 1.5 && res.t2 > res.t1 && res.t3 > 25 && res.t4 > 2 && res.t4 < 5)) { failed = true; console.log('  -> FAILED timing checks'); }
    await page.close();
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
