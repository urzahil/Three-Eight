# Three-Eight

Video meetups and movie nights with friends, entirely in the browser (Chrome, Firefox, Safari, Edge; desktop and mobile). Nobody installs anything.

- **Video call**: camera, microphone, mute and camera-off, device selection, speaking indicators, and chat.
- **Watch a movie together**: one person opens a file (or picks one from the room's Google Drive folder) and the room keeps playback in sync. Friends who don't have the file can stream it from that person's copy, or open their own. If anyone plays, pauses or seeks, it happens for everybody. Choosing an **audio track** or **subtitles** also changes it for everybody.
- **Picture-in-picture**: pop the movie out into a small floating window and keep chatting or browsing. Our subtitles and controls come with it, and play, pause and seek in the floating window still affect the whole room.
- **Rooms with passwords**: rooms are created on an admin page. Each one lives at `https://three-eight.example.com/ROOM_NAME`.
- **Peer to peer**: audio, video, chat, sync messages and shared movie pieces go directly between browsers over WebRTC. The server only serves the page and relays the short connection handshake, so its CPU and bandwidth use are tiny (apart from Google Drive films, see below).

## How it works

```
             ┌──────────── signaling only (tiny JSON over WebSocket) ───────────┐
  Browser A ─┤                                                                  ├─ Browser B
             └─ audio · video · chat · movie sync · movie pieces (WebRTC, P2P) ─┘
```

- **Server** (`server/`): Node.js with one dependency (`ws`). It serves the static app, stores rooms and their scrypt-hashed passwords in `/data/rooms.json`, checks the password when someone joins, relays WebRTC offers, answers and ICE candidates between members of the same room, and answers clock-sync pings. If a room has a Google Drive folder, it also reads that folder as a Google service account and streams the movies to the room's members (`server/drive.js`).
- **Calls** (`public/assets/js/mesh.js`): a full mesh with one `RTCPeerConnection` per pair of people. Each person uploads one stream per friend, and video bitrate goes down automatically as the room grows. This works best with up to about 6–8 people.
- **Movie sync** (`public/assets/js/sync.js`): everyone shares a small playback state: playing or paused, position, timestamp on the shared server clock, audio track and subtitle track. Any change is broadcast over WebRTC data channels and the newest change wins. Each browser works out where the movie should be right now and corrects drift. It speeds up or slows down by a few percent for small offsets and seeks for large ones. In testing, browsers stayed within about 10 ms of each other.
- **Movie files are never stored on the server.** A movie is a local file, or comes from the room's Google Drive folder, which the server reads from Google and streams on (nothing is written to its disk). Movie data now also travels *between browsers*: viewers send each other pieces of the film over a second WebRTC data channel (`public/assets/js/player/swarm.js`), and a friend without the file can stream it from someone's copy. The page compares file size and name to warn when someone has a different file; there are no checksums, so sharing relies on the same trust as picking a matching file: it's meant for friends.

### Audio tracks and subtitles in every browser

Browsers don't let a page switch the audio track of a video file, except Safari. To work around this, Three-Eight includes a small **in-browser remuxer** (`public/assets/js/player/`):

1. It reads the container directly from the file, in pieces: from your device, from a friend's copy, or from the server. It supports **MKV/WebM** and **MP4/MOV/M4V**.
2. It repackages the video track plus the *selected* audio track into fragmented MP4 on the fly. It then feeds that to the `<video>` element through Media Source Extensions. No re-encoding happens, so CPU use is low.
3. It extracts embedded text subtitles (SRT, ASS/SSA, WebVTT, MP4 timed text) and draws them over the video. It can also load external `.srt`, `.vtt` and `.ass` files. A loaded subtitle file is sent to everyone in the room automatically.

Simple files with a single audio track that you open from your device play natively. Films you stream (from a friend or from Google Drive) always go through the remuxer, because their pieces arrive from other browsers.

### Picture-in-picture

The PiP button (or `p`) behaves differently per browser, because our subtitles are drawn by the page rather than by the video element:

- **Chrome and Edge** offer two styles, chosen in *Settings* under *Picture-in-picture style* (changing it closes an open PiP window; the next click uses the new style):
  - *Floating player* (default) uses Document Picture-in-Picture. The whole player moves into a floating window, so our subtitles, controls, audio and subtitle menus, and the seek bar keep working. Close the window or click *Bring it back* to return it to the page. The browser adds a title bar showing the site address, which pages cannot remove.
  - *Compact video* has no title bar: the window shows only the video and our subtitles, with play/pause (shared with the room). There are no menus or seek bar in the window, so change audio and subtitle tracks from the page. This style redraws the movie frames and subtitles on a canvas and plays that in the browser's native video PiP, which costs slightly more CPU.
- **Safari** (desktop and iOS) uses the system video PiP. Our subtitles are mirrored into a native caption track, which Safari shows as captions in the PiP window. Pausing or playing from the system PiP controls is sent to the room.
- **Firefox** has no PiP API for pages, so use Firefox's own PiP toggle on the video. The subtitles are exposed as a caption track, which Firefox may show there (best effort).

Media keys and the buttons of system PiP windows use the Media Session API and also control the room.

**Codec limits** come from what browsers can decode. Video: H.264, HEVC (Safari, and Chrome/Edge with hardware support), VP9 and AV1. Audio: AAC, Opus, FLAC and MP3. **AC-3/E-AC-3** only plays in Safari. **DTS and TrueHD** play nowhere. Tracks a browser can't play are marked in the audio menu. **Image-based subtitles** (PGS/VobSub from Blu-ray/DVD rips) aren't supported, so use an `.srt` instead. If a movie only has AC-3/DTS audio, you can add an AAC track once, losslessly for the video:

```bash
ffmpeg -i movie.mkv -map 0 -c copy -map 0:a:0 -c:a:1 aac -b:a:1 384k movie-aac.mkv
```

## Running it

### Docker (recommended)

```bash
cp .env.example .env        # set ADMIN_PASSWORD
docker compose up -d --build
```

The server listens on **port 4567**. Rooms are kept in the `three-eight-data` volume.

Or without compose:

```bash
docker build -t three-eight .
```

```bash
docker run -d --name three-eight -p 4567:4567 -e ADMIN_PASSWORD=change-me -e TRUST_PROXY=true -v three-eight-data:/data three-eight
```

### HTTPS is required

Browsers only allow camera and microphone access on HTTPS pages (or `localhost`). Put a TLS reverse proxy in front of port 4567 and make sure it forwards WebSockets (`/ws`).

**Caddy** (gets certificates automatically):

```
three-eight.example.com {
    reverse_proxy 127.0.0.1:4567
}
```

**nginx**:

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;   # mobile networks often connect over IPv6
    server_name three-eight.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    location / {
        proxy_pass http://127.0.0.1:4567;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
    }
}
```

With `TRUST_PROXY=true` (the compose default), the server takes the client IP from `X-Forwarded-For`, which is used for login rate limiting. It also marks the admin cookie `Secure` and sends `Strict-Transport-Security`. `true` (or `1`, `yes`) means one trusted proxy: the server uses the last entry of `X-Forwarded-For`, the one your proxy appended, and ignores anything the client put before it. If there are several proxies in a row (say a CDN in front of nginx), set `TRUST_PROXY` to their number, e.g. `TRUST_PROXY=2`: the client address is then the second entry from the right. Setting it higher than the real number of proxies lets clients spoof their address.

Browsers must open the WebSocket from the same host as the page. If the address people use differs from the `Host` header your proxy passes on, list it in `ALLOWED_ORIGINS` (e.g. `https://calls.example.com`). If you publish port 4567 directly to the internet without a proxy, set `TRUST_PROXY=false`, or bind the port to localhost only (`"127.0.0.1:4567:4567"`).

**Works on Wi-Fi but not on mobile data?** If the lobby says *Can’t reach the server, retrying…* and then *Could not connect to the server*, the page loaded but the WebSocket (`/ws`) did not get through. Mobile networks (4G/5G) usually connect over IPv6. If your domain has an `AAAA` record, the proxy must forward WebSockets on its IPv6 listener too. Test with `curl -6 -i -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://three-eight.example.com/ws`, which should answer `101 Switching Protocols`. If you get into the room but a friend's tile stays on *connecting…* / *connection failed*, the problem is the carrier's NAT instead; see [Do I need TURN?](#do-i-need-turn).

### Without Docker

```bash
npm ci
ADMIN_PASSWORD=change-me npm start
```

For local testing, `http://localhost:4567` counts as a secure context, so camera and mic work.

## Using it

1. Open `https://three-eight.example.com/admin`, log in with `ADMIN_PASSWORD`, and create a room, for example `movienight`, with a password. The admin page also shows who is online in each room. From there you can change passwords (and optionally kick everyone) or delete rooms. Optionally attach a Google Drive folder to a room (see below).
2. Send friends `https://three-eight.example.com/movienight` and the password.
3. Each person enters a display name, which is remembered in the browser's local storage, plus the room password. They can also choose to remember the password on that device.
4. To watch together, one person clicks **Movie** and picks a film: a file from their device, or one from the room's Google Drive folder. Everyone else gets a button to join in; see [Watching a movie](#watching-a-movie) for the options. Use the player controls, the audio (🎧) and subtitle (CC) menus, or keyboard shortcuts: `space` play/pause, `←`/`→` ±10 s (adjustable in Settings), `f` full screen, `p` picture-in-picture, `m` mic, `v` camera, `c` chat.

Tip: use headphones during the movie, so your microphone doesn't send the film's sound to your friends. Movie volume is per person.

## Watching a movie

Whatever the source, playback is the same: everyone sees the same moment of the film, and play, pause, seek, audio track and subtitles are shared by the room. There are three ways to have the film in your browser, and people in the same room can use different ones.

| | Your own copy | A friend's copy | The room's Google Drive folder |
|---|---|---|---|
| **You need** | the same file on your device | nothing | nothing (the admin attaches the folder) |
| **How to start** | **Movie → Choose movie file…**, or **Use my own copy…** when a film is already playing | **Stream from <name>'s copy** | **Movie → From Google Drive**, or **Stream from Google Drive** when a film is already playing |
| **Where the film comes from** | your disk | the friend's browser, and other friends who already have the pieces | the Three-Eight server (which reads Google Drive), and other friends who already have the pieces |
| **Upload it costs** | nothing (others may stream from you, see below) | each viewer passes on roughly its share | each viewer passes on roughly its share; the server sends about one copy |
| **Browsers** | all | with Media Source Extensions (Chrome, Edge, Firefox, current Safari) | all (without Media Source Extensions it plays straight from the server) |
| **People list shows** | own copy | streaming (from <name>) | streaming (Drive) |

### Your own copy

Everyone opens their own copy of the same file, and only play/pause/seek and track choices travel between browsers. This is the original Three-Eight way and the lightest one: nothing is uploaded or downloaded. The page compares file size and name, and warns when someone picks a different file (you can then use it just for yourself, or switch everyone to it). Opening your own copy is always possible, even when friends are streaming, and saves your connection if you have the file anyway.

### Streaming from a friend's copy

When someone has the room's film open from their device, everyone else is offered **Stream from <name>'s copy** (with several people sharing: **Stream from a friend's copy**). The film goes browser to browser over WebRTC; nothing passes through the server, and the room doesn't need a Google Drive folder.

- **Upload:** the person sharing sends about one copy of the film in total, however many friends stream it. Each piece of the film is fetched from them once by one friend, who passes it on to the others, so every friend uploads roughly its share. (Measured with three friends: the sharer uploaded about 1.0–1.2 × the part of the film they watched, instead of 3 × when everyone downloaded from the sharer.) The sharer's connection still has to carry the film's bitrate about once: 2 Mbps is plenty for a typical 1080p file, a 4K remux needs much more.
- **When the sharer leaves:** friends keep watching what they already have, and parts nobody has loaded can't be played. They see a message instead of a frozen player.
- **Opting out:** sharing is automatic while someone has the room's film open from a file. Turn it off in **Settings → Share my movie file with the room**; friends are then not offered your copy, and your file is not read for them.
- **Browsers:** streaming from a copy needs Media Source Extensions. A browser without them (old iOS) has to open its own file.

### From the room's Google Drive folder

If the admin attached a Google Drive folder to the room ([setup below](#google-drive-folders)), the **Movie** dialog lists it under **From Google Drive**, with its subfolders. Picking a film streams it for you and makes it the room's film; everyone else gets **Stream from Google Drive** (or can still use their own copy).

- The Three-Eight server reads the folder from Google; browsers never contact Google.
- Viewers share pieces with each other just like with a friend's copy, so the server sends each part of a film about once, however many people watch. If a friend stops answering or leaves, the others fetch the missing pieces from the server instead.
- A browser without Media Source Extensions (old iOS) plays the film straight from the server and doesn't take part in sharing; that costs the server a full copy for that viewer.
- If Google temporarily blocks a heavily downloaded file ("download quota exceeded"), people see that message; use a local copy until it clears.

### Mixing sources

People in one room can mix the three: some open their own copy, some stream. Anyone who has the film open from their device is also a source for the others, including for Drive films (when the file sizes match), which takes load off the server. A viewer can switch at any time: open the **Movie** dialog to use their own copy, or **Stop using my file** to go back to streaming.

There are no checksums: files are matched by size (and name), so sharing relies on the same trust as picking a matching file. It's meant for friends.

### Subtitles

Subtitles are shared by the room like the audio track: turning them on or off changes it for everybody (each person can still adjust the subtitle delay in Settings).

- **Subtitle files** (`.srt`, `.vtt`, `.ass`): load one with **CC → Load subtitle file…**. It is sent to everyone in the room, including people who join later, whatever way they watch.
- **From the Drive folder:** a subtitle file next to the film with a matching name loads automatically for everyone when someone starts the film from Drive. Names like `Arrival.srt`, `Arrival.en.srt` or `Arrival ENG.srt` count; with several matches, the one without a language suffix wins, then the one in the browser's language. The other matching files are listed under **From Google Drive** in the CC menu. Subtitle files of other films in the same folder are not listed there, but you can still pick any file from the **Movie** dialog.
- **Embedded subtitles** (inside the film file): someone who has the file reads the track from it. People who are streaming receive the extracted subtitle text from them, so it appears for everyone at about the same time. If nobody has loaded the track yet, a streaming viewer reads it from the stream itself (slowly, a little at a time), or, for MKV files that don't index their subtitles, sees a message that it will appear once someone in the room has loaded it. A separate `.srt` next to the film is always the fastest option.
- **Image-based subtitles** (PGS/VobSub from Blu-ray/DVD rips) aren't supported; use an `.srt` instead.

## Google Drive folders

An admin can attach one Google Drive folder to a room. Rooms without a folder look the same as before.

How it works: the Three-Eight server signs in to Google as a **service account** and reads the folder. Members never contact Google: their browsers fetch folder listings and movie data from the Three-Eight server, which only answers requests that carry a token it handed out when they joined the room (the token is tied to the room, its password and its folder, and expires after 12 hours). It only serves files inside the room's folder (and its subfolders), even though the service account may be able to read more. Movies are not stored on disk. The server keeps a short-lived cache in memory (`DRIVE_CACHE_MB`) and fetches each part of a film from Google about once.

Setup:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a dedicated project. Do **not** attach a billing account.
2. Enable the **Google Drive API** for that project.
3. Create a **service account** (*IAM & Admin → Service accounts*). It needs no roles.
4. Open the service account, go to *Keys → Add key → Create new key → JSON*, and put the downloaded file on the server. Set `GOOGLE_SERVICE_ACCOUNT` to its path (the path of the file, not the service account's email) and restart. With Docker Compose, save the file next to `docker-compose.yml` as `google-service-account.json`, uncomment the `volumes` line that mounts it (read-only), and add `GOOGLE_SERVICE_ACCOUNT=/run/secrets/google-service-account.json` to `.env`:

   ```yaml
   volumes:
     - ./google-service-account.json:/run/secrets/google-service-account.json:ro
   ```

5. In Google Drive, share each room's folder with the service account's email address (it looks like `name@project.iam.gserviceaccount.com`) as **Viewer**. One service account serves all rooms; each room only sees its own folder. The folders don't need to be public ("Anyone with the link" can be turned off).
6. On the admin page, click **Drive…** next to the room and paste the folder link. The dialog shows the email to share with. After saving, the server checks that it can read the folder and tells you.

Notes:

- **Bandwidth:** thanks to sharing between viewers, the server's upload only needs to carry the film's bitrate about once, plus a little more when someone seeks to a part nobody has yet. Without sharing (only one person watching, or a browser without Media Source Extensions) it sends one copy per viewer.
- **Security:** keep the key file private (don't commit it; it is in `.gitignore`). It can read whatever is shared with that service account, so share only what you want available. To revoke access, delete the key in Google Cloud (*Service accounts → Keys*), or stop sharing the folder with the service account.
- In Docker the server runs as the `node` user, so the mounted key file must be readable by it (for example `chmod 644 google-service-account.json` on a single-user host).
- If `GOOGLE_SERVICE_ACCOUNT` is set but the file cannot be read, the server logs why and runs with Drive disabled. The admin dialog then says that the variable is not set.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4567` | HTTP port |
| `ADMIN_PASSWORD` | random, printed at start | Password for `/admin` |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where `rooms.json` is stored |
| `TRUST_PROXY` | `false` (`true` in compose) | Trust `X-Forwarded-For` / `X-Forwarded-Proto`: `true`/`1`/`yes` for one proxy, a number for that many proxies in a row |
| `ALLOWED_ORIGINS` | — | Comma-separated extra origins allowed to open the WebSocket (the page's own host is always allowed) |
| `MAX_ROOM_SIZE` | `12` | Max participants per room |
| `STUN_URLS` | Google + Cloudflare STUN | Comma-separated STUN URLs |
| `TURN_URLS` | — | Comma-separated TURN URLs (optional) |
| `TURN_SECRET` | — | coturn `static-auth-secret` (ephemeral credentials) |
| `TURN_USERNAME` / `TURN_PASSWORD` | — | Static TURN credentials (alternative to the secret) |
| `GOOGLE_SERVICE_ACCOUNT` | — | Path to a Google service account JSON key, for room Drive folders (optional, see above) |
| `DRIVE_CACHE_MB` | `256` | Memory for the movie cache while streaming from Drive (minimum `32`; lower values are raised) |
| `TLS_CERT` / `TLS_KEY` | — | Serve HTTPS directly instead of using a proxy |

### Do I need TURN?

Usually not. STUN is enough for most home connections. Some friends may be behind very strict NAT, like certain mobile carriers or corporate networks. Their tile then shows "connection failed", and only they are affected. A TURN server ([coturn](https://github.com/coturn/coturn)) fixes this by relaying *their* media. That uses bandwidth on whatever host runs coturn, so it's opt-in. Configure coturn with `use-auth-secret` and `static-auth-secret=...`, then set `TURN_URLS` and `TURN_SECRET`. `docker-compose.yml` has a ready-made, commented-out `turn` service with the steps to enable it.

## Customizing the look

All colors are CSS variables at the top of `public/assets/css/style.css` (the `:root` block). The admin page uses the same stylesheet.

To change the accent color (yellow/orange by default), edit:

```css
--accent: #f2a541;      /* buttons, logo, seek bar, highlights, links, focus rings */
--accent-ink: #1b1305;  /* text drawn on top of the accent (e.g. primary buttons) */
```

If you pick a darker accent, set `--accent-ink` to a light color (e.g. `#ffffff`) so button text stays readable.

Two places can't read CSS variables, so change them by hand to match:

- The icon `public/assets/icon.svg` has both colors hard-coded: `fill="#f2a541"` (the accent background) and `fill="#1b1305"` (the `--accent-ink` text). Change both.
- The `theme-color` meta tag in `public/index.html` (`#0f1115`, the color some mobile browsers paint their toolbar) matches `--bg`: change it if you change `--bg`.

Other variable groups in the same block:

- Backgrounds: `--bg`, `--bg-2`, `--bg-3`; borders: `--line`; text: `--text`, `--muted`.
- Danger: `--danger`, `--danger-text`, `--danger-border` (leave/delete, muted mic and camera, errors); `--hover` (button hover).
- Warning (pill and toast): `--warn-bg`, `--warn-text`, `--warn-border`.
- `--ok`: speaking indicator and mic level meter.
- Subtitles: `--sub-text`, `--sub-outline`. These are also used by the compact picture-in-picture window.
- Avatars: `--avatar-1` ... `--avatar-10` (each participant gets one by hashing their id), plus `--avatar-fallback` and `--on-color` (text on avatars and badges).
- Overlays and video: `--video-bg` (behind video), `--label-bg`, `--backdrop`, `--movie-overlay`, `--controls-scrim`, `--tooltip-bg`, `--round-bg`, `--meter-bg`, `--hover-overlay`, `--seek-track`, `--seek-buffered`, `--time-text`, `--shadow-color`.

When running with Docker, rebuild the image after editing: `docker compose up -d --build`.

## Development and tests

```bash
npm ci
ADMIN_PASSWORD=test npm start
```

The tests drive real Chromium with Playwright and generate media with ffmpeg:

```bash
bash test/make-fixtures.sh
```

```bash
node test/player-check.js test/fixtures/multi.mkv test/fixtures/multi.mp4
```

```bash
node test/e2e.js
```

```bash
node test/pip-check.js
```

```bash
node test/drive-check.js
```

```bash
node test/share-check.js
```

`drive-check.js` starts its own server as a service account against a fake Google (`test/fake-google.js`): browsing a folder and its subfolders, streaming a movie through the remuxer and natively (without MSE), room sync while streaming, subtitles from the folder, a download quota error, two viewers sharing one fetch from Google, three viewers sharing a film (it counts the bytes our server sends, which should be about one copy; one viewer then freezes and leaves, and the others keep playing), a token refresh on reconnect, live changes to the room's folder, and a check that the browser never contacts Google. `share-check.js` tests a room without Drive: one person opens a file, a friend streams it from their copy, with sync, seeking and audio changes, and the Settings opt-out. `npm test` also runs unit tests for the sharing protocol (`test/swarm.test.mjs`). `player-check.js` tests the in-browser player on its own: native or remux mode, audio track switching, seeking and subtitles. `e2e.js` tests the whole flow: the admin creates a room, a wrong password is rejected, two people join with fake cameras, video flows peer to peer, mute and camera state and chat arrive on the other side, and the movie syncs. The movie part covers play, pause, seeking, audio and subtitle changes, a shared subtitle file, and a late joiner. Finally the admin deletes the room and everyone is disconnected. `pip-check.js` tests picture-in-picture: the Document PiP window (the movie box moves there, subtitles still render, controls inside it drive the other person, and closing it brings the player back), the native-PiP fallback (the subtitles are mirrored into a caption track, and a pause made directly on the `<video>` reaches the room), and the compact style (chosen in Settings: the canvas stream is in native PiP, the subtitles and video are drawn on the canvas, a pause on the PiP element reaches the room, and leaving PiP cleans up).

## License

GPL-3.0 — see [LICENSE](LICENSE).
