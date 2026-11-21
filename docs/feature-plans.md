# Feature plans

Implementation notes for features that Three-Eight did not have when they were written. Those built since are marked
**Done** in the table, and their sections say what was built. Each section is meant to be picked up on its own
(by a person or a Claude session): what to build, where it goes in the code, the edge cases that matter, and how to
test it. They are not ordered by priority; the table says what each costs and what it is worth.

| # | Feature | Size | Touches the server | Notes |
|---|---|---|---|---|
| 1 | [Per-person volume and mute](#1-per-person-volume-and-mute) | S | no | Purely local |
| 2 | [Speaker / headphone picker](#2-speaker--headphone-picker) | S | no | Chrome, Edge, Firefox |
| 3 | [Devices plugged in or removed mid-call](#3-devices-plugged-in-or-removed-mid-call) | S | no | |
| 4 | [Resume where you left off](#4-resume-where-you-left-off) | S | no | |
| 5 | [Next episode from the Drive folder](#5-next-episode-from-the-drive-folder) | M | no | |
| 6 | [Countdown before play](#6-countdown-before-play) | S | no | Compatible with older clients |
| 7 | [Pause for everyone while someone buffers](#7-pause-for-everyone-while-someone-buffers) | M | no | |
| 8 | [Only the starter controls playback](#8-only-the-starter-controls-playback) | M | no | A courtesy, not security |
| 9 | [Lock-screen progress bar](#9-lock-screen-progress-bar) | S | no | |
| 10 | [Screen sharing with tab audio](#10-screen-sharing-with-tab-audio) | L | no | Changes how video tracks are routed |
| 11 | [Subtitle style](#11-subtitle-style) | S | no | |
| 12 | [Connection quality indicator](#12-connection-quality-indicator) | M | no | |
| 13 | [Chat notifications and reactions](#13-chat-notifications-and-reactions) | M | no | |
| 14 | [More keyboard shortcuts and a shortcuts list](#14-more-keyboard-shortcuts-and-a-shortcuts-list) | S | no | |
| 15 | [Admin: rename, room size, last activity, backup](#15-admin-rename-room-size-last-activity-backup) | L | yes | Security-sensitive: needs an Opus review |
| 16 | [Reload the TLS certificate without a restart](#16-reload-the-tls-certificate-without-a-restart) | S | yes | **Done** |
| 17 | [Translations](#17-translations) | L | a little | |

## Working on this repository

- One feature per branch, named `feature/<short-kebab-description>` (see `CLAUDE.md`), one pull request each.
- The room is one class assembled from parts: each `public/assets/js/room/*.js` file is a class whose methods are
  installed on `Room` by `mixin()` (`room/util.js`). A method name may exist only once across all parts (`mixin`
  throws otherwise), so prefix new helpers with the part's topic.
- Everything a peer sends is untrusted: validate and bound it where it is received (see `cleanState()` in `sync.js`,
  `_cleanChat()` in `room/chat.js`, `parseHave()` in `player/swarm.js`). A new field in the shared playback state must be
  added to `emptyState()` and `cleanState()`, and older clients must keep working when they ignore it.
- Tests: `npm test` (unit, Node) for anything that can run without a browser; the browser checks in `test/*-check.js`
  and `test/e2e.js` (`npm run test:browser`, needs ffmpeg) for UI flows. Add to an existing check where one covers the
  area rather than creating a new script.
- Documentation: user-visible behaviour goes in `README.md` (short) and `docs/movie-player.md` or the relevant
  `docs/*.md` page; keyboard shortcuts are listed in both `README.md` and `docs/movie-player.md`.
- The version shown in Settings is not bumped per pull request.

---

## 1. Per-person volume and mute

**Goal.** Turn one person down (a loud microphone, someone eating) or mute them, only for yourself.

**Where.** `room/tiles.js`. A remote person's audio plays through their tile's `<video>` (`_makeTile`, which is not
muted for remote tiles), so the volume is that element's `volume` / `muted`.

**Steps.**
1. In `_makeTile` (remote tiles only), add a small control that appears on hover or long-press: a mute button and a
   range input (0–1, step 0.05). Use a class for styles (the CSP forbids inline `style=""` in HTML; setting
   `element.style.x` from scripts is fine).
2. Apply it to `t.video.volume` / `t.video.muted`. The speaking indicator (`watchLevel` on the incoming track) stays
   as it is: it shows that they speak, whatever we hear.
3. Remember it per name (`store` key `peerVolume`, a bounded map `{ name: volume }`), since participant ids change with
   every tab. Apply it in the `'peer-added'` and `'profile'` handlers once the name is known.
4. Show "muted for you" in the people list (`_renderPeople`).

**Edge cases.** A rebuilt link keeps the tile (`rebuilding` in `'peer-removed'`): keep the setting. iOS Safari ignores
`volume` on media elements: hide the slider there (feature-detect by setting `volume = 0.5` on a test element and
reading it back) and keep only mute.

**Tests.** Browser check in `test/e2e.js`: Bob mutes Alice, Alice's tile video on Bob is `muted`, Alice is not affected.

## 2. Speaker / headphone picker

**Goal.** Choose where call audio and the movie play (headphones while the laptop speakers stay silent).

**Where.** `room/settings.js` (a new select next to Microphone and Camera), `index.html` (the select, hidden when
unsupported), `room/tiles.js` and `player/player.js` (the elements to route).

**Steps.**
1. Supported when `'setSinkId' in HTMLMediaElement.prototype`. Hide the setting otherwise (Safari).
2. List outputs from `media.devices()` (extend it with `kind === 'audiooutput'`). Chrome lists them once a microphone
   permission exists; Firefox lists none and needs `navigator.mediaDevices.selectAudioOutput()` from a click, so offer
   a "Choose…" button there.
3. Apply with `el.setSinkId(id)` to every remote tile video, the movie `<video>` (`this.player.video`) and future tiles
   (in `_makeTile`). The compact PiP proxy video is muted and needs nothing.
4. Store the choice (`store` key `audioOutput`); if the device is gone at start (`setSinkId` rejects with
   `NotFoundError`), fall back to the default silently and say so once.

**Edge cases.** The Document PiP window moves the movie `<video>` into another document: the sink stays with the
element. Apply again after a `devicechange` (see 3).

**Tests.** Hard to test headless (no real outputs); unit-test the "is it supported / which id to use" logic, and check
in a browser check that choosing the default calls `setSinkId('')` without errors.

## 3. Devices plugged in or removed mid-call

**Goal.** Plugging in a headset shows it in the device lists at once; unplugging the microphone in use switches to the
default one instead of leaving you silent.

**Where.** `media.js` (`LocalMedia`), `app.js` (lobby lists), `room/settings.js` (settings lists).

**Steps.**
1. `LocalMedia` listens to `navigator.mediaDevices` `'devicechange'` and emits a `'devices'` event.
2. The lobby (`fillDevices` in `startLobby`) and Settings (`openSettings`, if the dialog is open) refill their selects on
   it.
3. In `_watchEnded`, when the audio track ends while `micOn` is true and the page has not left (`!this.stopped`),
   acquire the default microphone again (`_acquire('audio')`, which falls back from a missing saved device). Do it once
   per ended track (a microphone that keeps failing must not loop) and emit `'audio'` either way, so the mesh gets the
   new track (`mesh.setTrack` is already called from the `'change'` handler in `room/tiles.js`).
4. Same for the camera only if it was on: reopen the default camera; if that fails, leave it off (as today).

**Edge cases.** Some systems fire `devicechange` several times in a row: debounce (300 ms). On iOS, opening a camera ends
the other one (see the comments in `_setDevice`): never reopen the camera from `devicechange` alone, only after its
track ended.

**Tests.** `test/media.test.mjs` has fake devices: end the audio track while the mic is on and check that a new track
is requested once, and that a second failure does not request again.

## 4. Resume where you left off

**Goal.** Starting a movie the room watched before offers "Resume at 1:23:45".

**Where.** `room/movie.js` (`chooseMovieFile`, `_renderStage`), a small store helper like the per-movie subtitle delay in
`room/settings.js` (`_subDelayKey`, `_saveSubDelay`).

**Steps.**
1. Key a film like the subtitle delay does: `movie.fp`, else `d:<drive id>`, else `name:size`. Reuse `_subDelayKey()`
   (rename it to something general, such as `_movieKey()`, and use it for both).
2. Save `{ pos, at: Date.now() }` per key (`store` key `positions`, the 50 most recent) every 15 s while the room plays,
   on pause, and on `pagehide`. Do not save in the first 2 minutes or the last 5 minutes (nothing to resume).
3. When this browser starts a movie for the room (`asRoom` in `chooseMovieFile`) and has a saved position, show a
   second button in the stage overlay or a toast with an action: "Resume at 1:23:45". It calls `this.sync.seek(pos)`,
   which is a normal room seek.
4. Drop the saved position when the film reaches the end (`sync.atEnd()`).

**Edge cases.** Only the person who starts the movie is asked (others joining follow the room anyway). Two people
starting at once: whichever state is newer wins, as for any seek.

**Tests.** Browser check: play to 30 s (use a short `RESUME_MIN` test knob, e.g. through `?debug`), close the movie,
open it again: the resume offer seeks both browsers.

## 5. Next episode from the Drive folder

**Goal.** For series nights: when an episode ends, offer the next file of the folder, with a countdown everyone sees.

**Where.** `room/drive-browser.js` (listing, `_streamDriveFile`), `room/movie.js` (`chooseMovieFile`, the stage
overlay), `sync.js` (end of film).

**Steps.**
1. The next episode is the next `kind === 'video'` item after the current one in the folder listing (the server already
   sorts by name with numeric collation, see `_list` in `server/drive.js`). The current one is `state.movie.drive.id`
   in `state.movie.drive.folder`.
2. When `sync.atEnd()` becomes true, every browser that has Drive shows an overlay "Next: <name> in 10 s" with
   "Play now" and "Cancel". Only a click starts it (autoplay rules, and nobody should be surprised); the countdown is
   a suggestion.
3. Starting it calls `chooseMovieFile(this.drive.remoteFile(...), { asRoom: true })`: add that option so the
   "different file" dialog is skipped, since replacing the room's film is the point.
4. Show the episode list in the Drive dialog with the current one marked (it already marks "now playing").

**Edge cases.** Two people clicking "Play now" at once: both commit the same movie; the newer state wins and the other
browser follows. Local files: not supported (the browser cannot read the folder); say so nowhere, just do not offer it.

**Tests.** `test/drive-check.js` uses the fake Google: put two short videos in a folder, play the first to its end, click
"Play now", and check both browsers have the second.

## 6. Countdown before play

**Goal.** "3, 2, 1" before the film starts, so nobody misses the first seconds.

**Where.** `sync.js` (`play()`, `expectedPosition`, `_apply`), `room/movie.js` (overlay).

**Design.** A countdown is a play whose start time is in the future: commit `{ paused: false, pos, at: now + 3000 }`.
For `now < at`, `expectedPosition()` returns `pos` and `_apply` keeps the element paused at `pos`, with a timer that
plays it at `at` (on the room clock). Older clients compute `pos + (now − at)/1000`, 3 s before `pos`, reaching `pos` at
`at`: they play 3 extra seconds before it and are in step from then on. When `pos` is under 3 s (starting from the
beginning) their target is negative for a moment and they keep seeking to 0 until it is not: harmless, but check that
`_tick` does not log or toast anything while that happens.

**Steps.**
1. In `expectedPosition`: `if (!s.paused && this.now() < s.at) return s.pos;`.
2. In `_apply` and `_tick`: while `now < at`, seek to `pos` if needed, stay paused, and set a timer for `at − now`.
3. A setting "Count down before playing" (per person: whoever presses play decides). The overlay shows the remaining
   seconds for everyone while `state.at > now`.
4. Pressing pause during the countdown commits a normal pause.

**Edge cases.** Clock offsets are a few milliseconds: fine. A newcomer arriving mid-countdown sees the rest of it.

**Tests.** `test/sync.test.mjs`: with a fake clock, a state with `at` in the future keeps `expectedPosition` at `pos`,
and an old-style computation stays consistent (the doc's claim above).

## 7. Pause for everyone while someone buffers

**Goal.** A room option: when one viewer stalls (slow Drive, slow friend), everyone waits instead of that viewer
catching up with a jump.

**Where.** `sync.js`, `room/movie.js` (the option and the "waiting for Bob" text in `m-ready`).

**Design.** The viewer who buffers knows it first and best, so it holds the room itself:
1. A new state field `hold` (participant id or null), validated in `cleanState` (`typeof === 'string'`, at most 64
   characters) and set to null by every ordinary commit.
2. When "wait for everyone" is on (a field `wait: true` in the state, so the whole room shares the choice) and our
   player has been buffering (`readyState < 3` while the room plays) for 1.5 s, commit
   `{ paused: true, pos: player.time, hold: selfId }`.
3. When we can play again (`canplay` / `readyState >= 3`) and the state is still our hold, commit a play.
4. A hold by someone who left (`'peer-removed'`) is released by the member with the lowest id (to avoid everyone doing
   it), with a play.
5. Anyone pressing play overrides it (an ordinary commit clears `hold`).

**Edge cases.** Flapping on a borderline connection: after an auto-resume, ignore new stalls for 10 s. Two viewers
stalling: the second sees the state paused and does nothing; when the first resumes, the second may hold again.

**Tests.** `test/sync.test.mjs` with a fake player whose `readyState` drops: the hold is committed after 1.5 s, released
on recovery, and not committed when `wait` is off.

## 8. Only the starter controls playback

**Goal.** A room option for big groups: only the person who started the movie can play, pause and seek; others can
still change their own volume and subtitles ("just for me").

**Where.** `sync.js` (`_onMessage` accepting states), `room/movie.js` and `room/keyboard.js` (disabled controls).

**Design.** A state field `lock` (participant id or null). While it is set, a received state that changes `paused`,
`pos`/`at` (other than by expected progress), `audio`, `sub` or the movie is ignored unless `s.by === lock`. The lock
holder can unlock. If the holder leaves the room, the lock is dropped (by everyone, on `'peer-removed'`).

This is a courtesy against accidents, not security: a modified client can send anything (peers are friends).

**Steps.**
1. Field in `emptyState` and `cleanState`.
2. Receiving side check in `_onMessage('sync-state')`.
3. UI: a lock toggle in the movie dialog for the starter; play/seek controls and shortcuts disabled for the others,
   with a tooltip "Only Alice controls playback".
4. Older clients do not know the lock and can still change playback: their states are ignored by newer clients, which
   splits the room. Document that everyone should use the same version (the app reloads from the server each time, so
   in practice this is short).

**Tests.** `test/sync.test.mjs`: states from others are refused while locked, accepted after unlock and after the holder
left.

## 9. Lock-screen progress bar

**Goal.** Phones and system media controls show the film's position and length, and scrubbing there works.

**Where.** `room/movie.js` (`_syncMediaSession`, `_updatePlaybackState`).

**Steps.**
1. Call `navigator.mediaSession.setPositionState({ duration, position, playbackRate: 1 })` when the state changes and
   every few seconds while playing (not every frame), guarded with try/catch (it throws if `position > duration`).
2. The existing `seekto` handler already seeks the room.
3. Clear it (`setPositionState()` with no argument) when the movie closes.

**Tests.** A browser check can read `navigator.mediaSession` calls through a stub installed with `page.addInitScript`.

## 10. Screen sharing with tab audio

**Goal.** Share a browser tab with its sound (a video site, a game), as Chrome and Edge allow.

**Where.** `media.js` (`ScreenShare`, `SCREEN_CONSTRAINTS`), `mesh.js` (transceivers and `routeVideo`), `room/screen.js`.

**Why it is large.** Receivers currently tell the camera from the screen by which stream also carries audio
(`routeVideo`: the camera is the video track of the stream with the microphone). A screen stream with audio would break
that rule.

**Steps.**
1. Announce the screen's stream id in the profile message (`profile.screenStream`, validated like the other profile
   fields in `room/tiles.js`), and route by it in `Peer.ontrack`: the video of that stream is the screen, its audio the
   screen's sound. Keep `routeVideo` as the fallback for older clients.
2. `getDisplayMedia({ audio: true, systemAudio: 'exclude', ... })` (tab audio only, never the whole system's), keep the
   audio track instead of stopping it, and add a second send-only audio transceiver for it the first time a share has
   audio (like `_addScreenTx`).
3. Receivers play it through `#screen-video` (unmute it for remote shares; keep it muted for our own).
4. Bitrate: Opus at 64–96 kbit/s is plenty; no change to `_applyBitrates` needed.
5. The sharer hears the tab locally anyway; tell them (a line under "You're sharing your screen") that their
   microphone may pick it up without headphones.

**Edge cases.** A window or whole-screen share has no audio in most browsers: the transceiver simply sends nothing.
Firefox and Safari do not capture tab audio: the option is just absent.

**Tests.** `test/screen-check.js` already shares with Chromium's fake capture (`--use-fake-ui-for-media-stream`,
`--auto-select-desktop-capture-source=...`). Fake capture may not deliver audio: if not, test the routing in
`test/mesh.test.mjs` (a screen stream that carries audio must not take the camera's place) and check the receiver side
by hand in Chrome with a real tab.

## 11. Subtitle style

**Goal.** Choose the subtitle colour, a background box for readability, and the position (raise the bottom line above
burnt-in text or a TV's overscan).

**Where.** `room/settings.js`, `index.html`, `assets/css/style.css` (`.subs`, `.subs span`, the `--sub-text` and
`--sub-outline` variables), `player/subtitles.js` (`SubtitleRenderer.layout` for the position), `player/compactpip.js`
(it draws subtitles on a canvas with colours read from the CSS variables).

**Steps.**
1. Settings: colour (white, yellow, light grey), background (none, semi-transparent box), and position (bottom offset in
   % of the picture height: 0–20).
2. Apply as CSS variables on `#subs-layer` (`--sub-text`, a new `--sub-box`, `--sub-lift`), so the Document PiP window
   (which clones the stylesheets and moves the same elements) follows.
3. Compact PiP: read the same variables in `CompactPip.open()` (it already reads `--sub-text` and `--sub-outline`) and
   draw a box behind the lines when one is set.
4. Native caption tracks (Safari PiP, iPhone full screen) use the system's caption style: leave them.

**Tests.** A browser check reads the computed style of a rendered subtitle line after changing the settings.

## 12. Connection quality indicator

**Goal.** See why someone's picture freezes: a small signal-strength icon on each tile, with details (round trip,
packet loss, "relayed through the TURN server") in its tooltip.

**Where.** `mesh.js` (a `stats()` method on `Peer`), `room/tiles.js` (the icon).

**Steps.**
1. Every 5 s (only while the page is visible), call `pc.getStats()` for each peer. From the selected candidate pair
   (`type === 'candidate-pair' && nominated && state === 'succeeded'`, or via `transport.selectedCandidatePairId`)
   read `currentRoundTripTime`; from `inbound-rtp` for video, `packetsLost` / `packetsReceived` deltas and
   `framesPerSecond`; from the local and remote candidates, `candidateType === 'relay'`.
2. Grade: good (RTT < 150 ms, loss < 2 %), fair, poor. Show 1–3 bars; hide when good, to keep tiles clean, or always:
   a setting is not needed, pick one.
3. The people list shows the same text.

**Edge cases.** Stats objects differ between browsers (Safari lacks some fields): treat missing values as unknown, not
as bad. Do not run while hidden: `getStats` on many peers costs CPU on phones.

**Tests.** Unit-test the grading function with stats fixtures from Chrome, Firefox and Safari (save real reports as JSON).

## 13. Chat notifications and reactions

**Goal.** Notice new messages while the tab is in the background or the movie is full screen; send quick reactions
(😂 😮 ❤️ 👏) that float over the picture.

**Where.** `room/chat.js`, `room/movie.js` (an overlay layer inside `#movie-box`, so it also appears in full screen and in
the floating window), `index.html`.

**Steps.**
1. Unread count in the title while hidden: `document.title = '(3) ' + room title`; reset on `visibilitychange` to
   visible with the chat open.
2. Optional sound (a short tone through `audioContext()` in `media.js`), and optional system notifications
   (`Notification.requestPermission()` from a Settings toggle, never on its own) for messages while hidden.
3. Reactions: a new data-channel message `{ type: 'reaction', emoji }`. Accept only emoji from a fixed list (never
   arbitrary text), at most 5 a second per peer. Render as a short CSS animation in a layer over the movie, or in the
   tile when no movie is open. Buttons in the movie controls and a key (`r` opens the picker).

**Edge cases.** In full screen the sidebar is hidden (`.fullscreen` styles): show the newest chat line briefly over the
picture as well (a setting, off by default).

**Tests.** Browser check: Bob sends a reaction, it appears in Alice's movie box; a reaction outside the list is
dropped.

## 14. More keyboard shortcuts and a shortcuts list

**Goal.** `↑` / `↓` for the movie volume, `j` / `l` as alternatives to the arrows, and `?` to show all shortcuts.

**Where.** `room/keyboard.js`, `room/movie.js` (`_refreshVolume`), `index.html` (a `<dialog>` with the table).

**Steps.**
1. `ArrowUp` / `ArrowDown`: change `this.player.video.volume` by 0.05 (local, like the slider: save `movieVolume`,
   call `_refreshVolume`), only while the movie is shown, and show a brief volume indicator.
2. `?` (Shift + `/` on many layouts: compare `e.key === '?'`, which the current "Shift + letter stays free" rule allows
   since it is not a letter) opens the shortcuts dialog. Generate its table from one list that also feeds the
   documentation check below.
3. Update the tables in `README.md` and `docs/movie-player.md`.

**Edge cases.** Arrow keys scroll the page when nothing handles them: call `preventDefault` only when acting. Inputs,
dialogs and modifier keys are already excluded by `_onKeydown`.

**Tests.** `test/e2e.js` already presses keys: add `ArrowUp` / `ArrowDown` and check the volume, and `?` opens the dialog.

## 15. Admin: rename, room size, last activity, backup

**Goal.** Manage rooms without editing files: rename a room, give it a smaller size limit, see when it was last used,
and download or restore the room list.

**Where.** `server/store.js`, `server/server.js` (admin API in `handleApi`), `public/admin.html`,
`public/assets/js/admin.js`. **Security-sensitive** (admin API, room access, password hashes): get the change reviewed by
an Opus model, as `CLAUDE.md` requires.

**Steps.**
1. **Room size.** A `maxSize` field (1 … `MAX_ROOM_SIZE`) in the room record, checked in `loadRoom`, set through
   `PUT /api/admin/rooms/:name/size`, used in `handleJoin` (`room.maxSize || MAX_ROOM_SIZE`). Lowering it does not
   remove anyone already in the room.
2. **Last activity.** In memory: the time the last member left (and "now" while someone is in). Persisting it would mean
   a rooms.json write on every join; instead write it at most every 10 minutes, or keep it in memory only and show
   "since the server started".
3. **Rename.** The room's key and name change, which changes the Drive cookie name (`driveCookieName`), the token claims
   (`r`) and the room version: simplest and safe is to disconnect the members (`kickRoom` with a code such as
   `room-renamed` and the new name, which the client shows with a link to the new address). Validate the new name like
   `create` (`RoomStore.validName`, not existing yet), move the record in one `_commit`, then `dropDriveStreams` for the
   old name.
4. **Backup.** `GET /api/admin/export` answers rooms.json as an attachment (`Content-Disposition: attachment`,
   `Cache-Control: no-store`); it contains password hashes, so only for a logged-in admin. `POST /api/admin/import`
   (JSON, the existing content-type check applies) validates every record with `loadRoom` and either merges (skip names
   that exist) or replaces, as the admin chooses; it must not accept `__proto__` keys (the store already uses
   prototype-less objects: keep it so).

**Edge cases.** A rename to a name that differs only in case is a rename of the display name only (same key): allow it
without disconnecting anyone. Import while members are in rooms: rooms that disappear are kicked like a deletion.

**Tests.** `test/server.test.js`: each endpoint needs the admin cookie; import rejects malformed records and prototype
keys; rename disconnects members with the new name and keeps the password; `maxSize` refuses the extra member with
`room-full`.

## 16. Reload the TLS certificate without a restart

**Done.** `reloadTls()` in `server/server.js`, as described below. Unchanged files are left alone, and a certificate
that has expired or is not valid yet is refused like one that does not parse (it would fail every browser; the current
one may still work). The `SIGHUP` handler is installed only with TLS, so without it the signal still stops the server.
The log gives the certificate's expiry date at startup and after each reload. Node.js cannot create a certificate by
itself: `test/self-signed.js` builds a small self-signed one with `node:crypto` (DER by hand), so the test needs no
`openssl` binary. The test in `test/server.test.js` also covers a key that does not match, files that do not parse, an
expired certificate and a missing file. Documented in `docs/deployment.md` ("Without a reverse proxy").

**Goal.** With `TLS_CERT` / `TLS_KEY` (no reverse proxy), a renewed certificate (Let's Encrypt every 60–90 days) is
picked up without restarting the server.

**Where.** `server/server.js` (where the HTTPS server is created).

**Steps.**
1. On `SIGHUP`, and every 12 hours, read both files again; if they changed and parse (`tls.createSecureContext` does not
   throw), call `server.setSecureContext({ cert, key })` and log it. On failure keep the old context and log why.
2. Document it in `docs/deployment.md` (e.g. certbot's `--deploy-hook "pkill -HUP -f server/server.js"`, or
   `docker kill -s HUP three-eight`).

**Tests.** `test/server.test.js`: start with one self-signed certificate (generate with `crypto` in the test), replace the
files, send `SIGHUP`, and check that a new TLS connection sees the new certificate.

## 17. Translations

**Goal.** The interface in the visitor's language (English stays the default).

**Where.** Every UI string: `index.html`, `admin.html`, `room/*.js`, `app.js`, `player/player.js` (notices), and the
server's user-facing messages.

**Steps.**
1. A tiny helper `t(key, params)` in `public/assets/js/i18n.js` with one dictionary file per language
   (`i18n/en.js`, `i18n/<lang>.js`), chosen from `navigator.languages`, with a Settings override. No library is needed.
2. Static HTML: `data-i18n="key"` (and `data-i18n-title`, `data-i18n-placeholder`), filled in at start. Keep the English
   text in the HTML as the fallback.
3. Server messages: the join errors already carry a `code` (`bad-password`, `room-full`, ...): translate by code on the
   client and use the server's English `message` only as a fallback. Drive errors carry English text: add codes the
   same way (`DriveError` already distinguishes `permanent`, `retryable`; give each message a stable code).
4. Plurals and word order differ between languages: use whole sentences with placeholders (`'{name} paused'`), never
   string concatenation.
5. A unit test that every key in `en.js` exists in each other dictionary, and that no key is unused.

**Edge cases.** Names, room names and file names are data: never translate them. Dates and times already use the
browser's locale (`toLocaleTimeString` in the chat).
