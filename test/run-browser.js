// Runs the Playwright browser checks one after another and prints a PASS/FAIL line for each.
// Usage: node test/run-browser.js [name ...]     (npm run test:browser; no names = every script not in SKIP_IN_CI when CI is set)
// Needs ffmpeg (for test/fixtures, generated on first use) and Playwright's Chromium (`npx playwright install chromium`).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const TEST_DIR = __dirname;
const ROOT = path.resolve(TEST_DIR, '..');
const FIXTURES = path.join(TEST_DIR, 'fixtures');
const TIMEOUT_MS = Number(process.env.BROWSER_TEST_TIMEOUT_MS || 5 * 60 * 1000); // per script: a hang fails instead of stalling
const ADMIN_PASSWORD = 'test';

// kind 'server': needs a server at BASE (the runner starts one on a free port, with its own empty data dir).
// kind 'self':   starts its own server (and picks its own data dir); `port` scripts read PORT from the environment.
const SCRIPTS = [
  { name: 'e2e', file: 'e2e.js', kind: 'server' },
  { name: 'pip-check', file: 'pip-check.js', kind: 'server' },
  { name: 'screen-check', file: 'screen-check.js', kind: 'server' },
  { name: 'player-check', file: 'player-check.js', kind: 'server', args: ['fixtures/multi.mkv', 'fixtures/multi.mp4'].map((f) => path.join(TEST_DIR, f)) },
  { name: 'share-check', file: 'share-check.js', kind: 'self' },
  { name: 'drive-check', file: 'drive-check.js', kind: 'self' },
  { name: 'reconnect-check', file: 'reconnect-check.js', kind: 'self', port: true },
  { name: 'lobby-check', file: 'lobby-check.js', kind: 'self', port: true },
];

// Scripts left out of the default run when CI is set (they run when named on the command line). Each entry needs a reason.
const SKIP_IN_CI = {
  // (none at the moment)
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = new Set();
const tempDirs = new Set();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function mkTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

// Start a command in its own process group so that the whole tree (script + browsers) can be killed.
function start(cmd, args, env, onData) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.add(child);
  child.exited = new Promise((resolve) => child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal }); }));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return child;
}

function killTree(child, signal = 'SIGKILL') {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  killTree(child, 'SIGTERM');
  const done = await Promise.race([child.exited.then(() => true), sleep(3000).then(() => false)]);
  if (!done) { killTree(child); await child.exited; }
}

function cleanup() {
  for (const c of children) killTree(c);
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  tempDirs.clear();
}

function ensureFixtures() {
  if (fs.existsSync(FIXTURES)) return;
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('test/fixtures is missing and ffmpeg is not installed: install ffmpeg (e.g. `sudo apt-get install ffmpeg`) and run again');
  }
  console.log('generating test/fixtures (bash test/make-fixtures.sh) ...');
  const r = spawnSync('bash', [path.join(TEST_DIR, 'make-fixtures.sh')], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    fs.rmSync(FIXTURES, { recursive: true, force: true }); // do not leave a half-made directory that would skip generation next time
    throw new Error('generating the fixtures failed');
  }
}

async function startServer(log) {
  const port = await freePort();
  const dir = mkTemp('te-browser-data-');
  const child = start(process.execPath, [path.join(ROOT, 'server', 'server.js')],
    { PORT: String(port), DATA_DIR: dir, ADMIN_PASSWORD, TRUST_PROXY: 'false' }, (d) => log.push(`[server] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(base + '/healthz')).ok) return { base, child }; } catch { /* not up yet */ }
    await sleep(100);
  }
  await stop(child);
  throw new Error('server did not start on port ' + port);
}

async function runOne(s) {
  const log = [];
  const t0 = Date.now();
  let server = null;
  let status = 'PASS';
  let note = '';
  try {
    // A private TMPDIR: the scripts that start their own server make data dirs (and browsers make profiles) there, removed afterwards.
    const env = { ADMIN_PASSWORD, TMPDIR: mkTemp('te-browser-tmp-') };
    if (s.kind === 'server') {
      server = await startServer(log);
      env.BASE = server.base;
    }
    if (s.port) env.PORT = String(await freePort());
    const child = start(process.execPath, [path.join(TEST_DIR, s.file), ...(s.args || [])], env, (d) => log.push(String(d)));
    let timer;
    const result = await Promise.race([
      child.exited,
      new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (result === 'timeout') {
      status = 'FAIL';
      note = `timed out after ${Math.round(TIMEOUT_MS / 1000)}s`;
      await stop(child);
    } else {
      killTree(child); // browsers a crashed script left behind
      if (result.code !== 0) { status = 'FAIL'; note = result.signal ? `killed by ${result.signal}` : `exit code ${result.code}`; }
    }
  } catch (err) {
    status = 'FAIL';
    note = err.message;
  } finally {
    await stop(server && server.child);
    for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    tempDirs.clear();
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${status}  ${s.name.padEnd(16)} ${secs}s${note ? '  (' + note + ')' : ''}`);
  if (status === 'FAIL') console.log(`----- output of ${s.name} -----\n${log.join('').trimEnd()}\n----- end of ${s.name} -----`);
  return status === 'PASS';
}

async function main() {
  const names = process.argv.slice(2);
  const unknown = names.filter((n) => !SCRIPTS.some((s) => s.name === n || s.file === n || s.file === n + '.js'));
  if (unknown.length) throw new Error(`unknown script(s): ${unknown.join(', ')} (known: ${SCRIPTS.map((s) => s.name).join(', ')})`);
  let selected = names.length
    ? SCRIPTS.filter((s) => names.some((n) => s.name === n || s.file === n || s.file === n + '.js'))
    : SCRIPTS;
  if (!names.length && process.env.CI) {
    for (const s of selected) if (SKIP_IN_CI[s.name]) console.log(`SKIP  ${s.name} (CI: ${SKIP_IN_CI[s.name]})`);
    selected = selected.filter((s) => !SKIP_IN_CI[s.name]);
  }
  ensureFixtures();
  const t0 = Date.now();
  let failed = 0;
  for (const s of selected) if (!(await runOne(s))) failed++;
  console.log(`${selected.length - failed}/${selected.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return failed ? 1 : 0;
}

// On Ctrl-C: ask the scripts to stop first (Playwright closes its browser on SIGTERM; after a SIGKILL the browser would be left
// running), then kill whatever is left and delete the temp dirs.
let interrupted = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (interrupted) return;
    interrupted = true;
    await Promise.all([...children].map((c) => stop(c)));
    cleanup();
    process.exit(130);
  });
}
process.on('exit', cleanup);

main().then((code) => { process.exitCode = code; }, (err) => { console.error(err.message); process.exitCode = 1; });
