// Browser test for reconnecting: after the signaling connection of one participant is lost (and the server
// perhaps restarted), the peer links must come back with working data channels (chat) on both sides.
// Starts its own server (and restarts it). No fixtures needed.
// Usage: node test/reconnect-check.js   (PORT, default 4751)
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = Number(process.env.PORT || 4751);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test';
const ROOM = 'reconnect-' + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-reconnect-'));
let server = null;

async function startServer() {
  server = spawn(process.execPath, [path.resolve(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, ADMIN_PASSWORD: ADMIN, TRUST_PROXY: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + '/healthz')).ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  const done = new Promise((r) => s.once('exit', r));
  s.kill('SIGKILL'); // a crash: nobody gets a peer-left
  await done;
}

// Every link of this page has both data channels open and a connected pc, and there are `n` of them.
const linksUp = (n) => {
  const peers = [...window.room.mesh.peers.values()];
  return peers.length === n && peers.every((p) => p.dc.readyState === 'open' && p.film.readyState === 'open' && p.pc.connectionState === 'connected');
};
const dump = (p) => p.evaluate(() => [...room.mesh.peers.values()].map((x) => ({ pc: x.pc.connectionState, dc: x.dc.readyState, film: x.film.readyState, signaling: room.signaling.joined })));

async function chat(from, to, text) {
  if (await from.locator('#sidebar').isHidden()) await from.click('#t-chat');
  await from.fill('#chat-input', text);
  await from.press('#chat-input', 'Enter');
  await waitFor(to, (t) => [...document.querySelectorAll('.msg .body')].some((b) => b.textContent === t), text, 15000);
}

(async () => {
  await startServer();
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    const login = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const made = await fetch(BASE + '/api/admin/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: ROOM, password: 'secret' }) });
    assert.equal(made.status, 201);

    const people = [];
    for (const name of ['Alice', 'Bob']) {
      const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
      await page.goto(`${BASE}/${ROOM}?debug`);
      await page.fill('#lobby-name', name);
      await page.fill('#lobby-password', 'secret');
      await page.click('#lobby-join');
      await page.waitForSelector('#room:not([hidden])');
      people.push(page);
    }
    const [alice, bob] = people;
    for (const p of people) await waitFor(p, linksUp, 1);
    await chat(alice, bob, 'hello 1');
    await chat(bob, alice, 'hello 2');
    console.log('both joined, chat works');

    // The "left"/"joined" notices the page itself printed (system messages in the chat log).
    const notices = (p) => p.evaluate(() => [...document.querySelectorAll('.msg.system')].map((m) => m.textContent));
    const peerObj = (p) => p.evaluate(() => { const x = [...room.mesh.peers.values()][0]; x.__mark ??= Math.random(); return x.__mark; });
    const sameLink = async (p, mark) => (await peerObj(p)) === mark;

    // --- 1. The signaling socket of one side dies (the server tells the other side that it left), once for each side.
    for (const [who, other, label] of [[alice, bob, 'Alice'], [bob, alice, 'Bob']]) {
      const before = (await notices(who)).length;
      await who.evaluate(() => room.signaling.ws.close());
      await waitFor(who, () => !room.signaling.joined || room.signaling.ws.readyState !== 1, null, 5000).catch(() => {});
      for (const p of people) await waitFor(p, linksUp, 1, 30000).catch(async (err) => {
        console.log('after socket loss:', label, JSON.stringify(await dump(alice)), JSON.stringify(await dump(bob)));
        throw err;
      });
      await chat(who, other, `after socket loss of ${label} (1)`);
      await chat(other, who, `after socket loss of ${label} (2)`);
      // The side that lost its socket was not told anybody left, and does not announce anything.
      const after = await notices(who);
      assert.deepStrictEqual(after.slice(before).filter((t) => /left|joined/.test(t)), [], `${label} printed notices: ${after}`);
      console.log(`socket of ${label} closed: both data channels open again, chat works both ways`);
    }

    // --- 2. The server restarts: nobody gets a peer-left, the healthy links must stay as they are.
    const markA = await peerObj(alice), markB = await peerObj(bob);
    await stopServer();
    await sleep(1500);
    await startServer();
    for (const p of people) await waitFor(p, () => room.signaling.joined, null, 30000);
    for (const p of people) await waitFor(p, linksUp, 1);
    assert(await sameLink(alice, markA) && await sameLink(bob, markB), 'the links were kept across the server restart');
    await chat(alice, bob, 'after restart 1');
    await chat(bob, alice, 'after restart 2');
    console.log('server restarted: same links kept, chat works');

    // --- 3. One side loses its socket and the server restarts at the same time.
    await alice.evaluate(() => room.signaling.ws.close());
    await sleep(100);
    await stopServer();
    await sleep(1500);
    await startServer();
    for (const p of people) await waitFor(p, () => room.signaling.joined, null, 30000);
    for (const p of people) await waitFor(p, linksUp, 1, 30000).catch(async (err) => {
      console.log('after socket loss + restart:', JSON.stringify(await dump(alice)), JSON.stringify(await dump(bob)));
      throw err;
    });
    await chat(alice, bob, 'after loss and restart 1');
    await chat(bob, alice, 'after loss and restart 2');
    console.log('socket loss + server restart: links up, chat works');

    // --- 4. A data channel dies on its own (no signaling involved): the link rebuilds itself, quietly.
    const tileName = (p) => p.evaluate(() => [...document.querySelectorAll('.tile:not(.self) .label span')].map((s) => s.textContent).join());
    const nameBefore = await tileName(alice);
    const nBefore = (await notices(alice)).length;
    const mark = await peerObj(alice);
    await alice.evaluate(() => [...room.mesh.peers.values()][0].dc.close());
    await waitFor(alice, (m) => { const x = [...room.mesh.peers.values()][0]; return x && x.__mark !== m && x.dc.readyState === 'open'; }, mark, 30000);
    for (const p of people) await waitFor(p, linksUp, 1);
    await chat(alice, bob, 'after channel loss 1');
    await chat(bob, alice, 'after channel loss 2');
    assert.strictEqual(await tileName(alice), nameBefore, 'tile name kept');
    const nAfter = await notices(alice);
    assert.deepStrictEqual(nAfter.slice(nBefore).filter((t) => /left|joined/.test(t)), [], 'no left/joined notices: ' + nAfter);
    console.log('dead data channel: link rebuilt by itself, chat works, no left/joined notices');

    // --- 5. Deadlock after a rebuild: the impolite side (higher id) rebuilds on its fallback timer, but its offer is lost
    // because the other side's signaling is dead; the other side then comes back, finds the link unhealthy and sends its
    // own offer. The impolite side sits in have-local-offer and must yield (rebuild) instead of ignoring that offer.
    // `waitMs`: how long the lost offer has been outstanding when the other offer arrives (old: handled at once;
    // young: handled by the deferred check).
    const ids = await Promise.all(people.map((p) => p.evaluate(() => room.mesh.selfId)));
    const [hi, lo] = ids[0] > ids[1] ? [alice, bob] : [bob, alice];
    const drop = (p, on) => p.evaluate((d) => {
      const sig = room.signaling;
      if (d) sig.signal = () => {}; // outgoing signals vanish (the socket is dead)
      else delete sig.signal; // back to the prototype method
    }, on);
    for (const waitMs of [4000, 0]) {
      await drop(hi, true);
      await drop(lo, true);
      const m = await peerObj(hi);
      await hi.evaluate(() => [...room.mesh.peers.values()][0].dc.close());
      // The impolite side rebuilds on its 8 s timer; its offer is lost.
      await waitFor(hi, (x) => { const peer = [...room.mesh.peers.values()][0]; return peer && peer.__mark !== x && peer.pc.signalingState === 'have-local-offer'; }, m, 30000);
      await sleep(waitMs);
      await drop(hi, false);
      await drop(lo, false);
      // The other side is back and rebuilds the link, as the 'reconnected' handler does.
      await lo.evaluate((id) => room.mesh.rebuildPeer(id), await hi.evaluate(() => room.mesh.selfId));
      for (const p of people) await waitFor(p, linksUp, 1, 30000).catch(async (err) => {
        console.log('after lost offer:', JSON.stringify(await dump(alice)), JSON.stringify(await dump(bob)));
        throw err;
      });
      await chat(hi, lo, `after lost offer (${waitMs}) 1`);
      await chat(lo, hi, `after lost offer (${waitMs}) 2`);
      console.log(`lost offer + rebuild on both sides (offer ${waitMs} ms old): link recovered, chat works`);
    }

    console.log('RECONNECT OK');
  } finally {
    await browser.close();
    await stopServer();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('RECONNECT FAILED', err);
  stopServer().finally(() => process.exit(1));
});
