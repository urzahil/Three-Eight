# Development and testing

Three-Eight is a Node.js application with the `ws` runtime dependency and Playwright-based browser tests. Node.js 22 or newer is required (the Docker image uses Node 24).

## Local development

```bash
npm ci
ADMIN_PASSWORD=local-dev-password npm start
```

`ADMIN_PASSWORD` must be at least 9 characters (the browser checks use `test-admin-password`).

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
| `test/screen-check.js` | Screen sharing, a late joiner seeing the share, one sharer at a time, share/movie exclusion and stopping. |
| `test/reconnect-check.js` | Peer links and chat recovering after a lost signaling connection or a server restart. |
| `test/lobby-check.js` | Joining while the camera/microphone prompt is unanswered, with devices attaching later. |

`npm test` runs the unit tests, including `test/swarm.test.mjs` for the movie-sharing protocol.

The app version appears in two places: `version` in `package.json` and the `#app-version` text in the Settings dialog (`public/index.html`). Bump both together; `test/version.test.js` fails if they differ.

Some checks can also be run directly:

```bash
node test/player-check.js test/fixtures/multi.mkv test/fixtures/multi.mp4
node test/e2e.js
node test/pip-check.js
node test/drive-check.js
node test/share-check.js
```

`npm run test:browser` prepares fixtures if needed, starts and stops test servers as required, and reports a PASS/FAIL line per check. `drive-check.js` and `share-check.js` use test services/fixtures; they do not require a real Google Drive account.
