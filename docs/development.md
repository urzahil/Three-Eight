# Development and testing

Three-Eight is a Node.js application with the `ws` runtime dependency and Playwright-based browser tests. Node.js 18 or newer is required (the Docker image uses Node 22).


## Local development

```bash
npm ci
ADMIN_PASSWORD=test npm start
```

The app starts on port 4567 by default. Open `http://localhost:4567`; localhost is treated as a secure context by browsers for camera/microphone access.

## Test commands

Run the unit tests:

```bash
npm test
```

The browser checks use Playwright and Chromium. Install Chromium once:


```bash
npx playwright install chromium
```

Generate media fixtures if needed:

```bash
bash test/make-fixtures.sh
```

Run the browser suite:

```bash
npm run test:browser
```

You can select individual browser checks by passing names after `--`, for example:

```bash
npm run test:browser -- e2e lobby-check
```

The browser suite requires ffmpeg and Playwright's Chromium. Each browser script has a five-minute timeout. CI runs the browser suite in its browser job.

## Individual checks

| Script | Purpose |
|---|---|
| `test/player-check.js` | Standalone player playback, remuxing/native playback, track selection, seeking and subtitles. |
| `test/e2e.js` | End-to-end room/admin flow, joining, media, chat, movie sync, subtitles and late join. |
| `test/pip-check.js` | Document PiP, native PiP fallback, compact PiP and room controls. |
| `test/drive-check.js` | Drive integration against fake Google, streaming, caching, subtitles, quota handling and reconnects. |
| `test/share-check.js` | Peer movie sharing, synchronization, seeking, audio changes and sharing opt-out. |
| `test/swarm.test.mjs` | Unit tests for the movie-sharing protocol; included by `npm test`. |

Some checks can also be run directly:

```bash
node test/player-check.js test/fixtures/multi.mkv test/fixtures/multi.mp4
node test/e2e.js
node test/pip-check.js
node test/drive-check.js
node test/share-check.js
```

`npm run test:browser` prepares fixtures if needed, starts and stops test servers as required, and reports a PASS/FAIL line per check. `drive-check.js` and `share-check.js` use test services/fixtures; they do not require a real Google Drive account.
