# Three-Eight

Video meetups and movie nights with friends, entirely in the browser (Chrome, Firefox, Safari, Edge; desktop and mobile). Nobody installs anything.

- **Video call**: camera, microphone, mute and camera-off, device selection, speaking indicators, and chat.
- **Watch a movie together**: everyone opens their own copy of the file and the room keeps playback in sync. If anyone plays, pauses or seeks, it happens for everybody. Choosing an **audio track** or **subtitles** also changes it for everybody.
- **Picture-in-picture**: pop the movie out into a small floating window and keep chatting or browsing. Our subtitles and controls come with it, and play, pause and seek in the floating window still affect the whole room.
- **Rooms with passwords**: rooms are created on an admin page. Each one lives at `https://threeeight.urzahil.rocks/ROOM_NAME`.
- **Peer to peer**: audio, video, chat and sync messages go directly between browsers over WebRTC. The server only serves the page and relays the short connection handshake, so its CPU and bandwidth use are tiny.

## How it works

```
             ┌──────────── signaling only (tiny JSON over WebSocket) ───────────┐
  Browser A ─┤                                                                  ├─ Browser B
             └────── audio · video · chat · movie sync (WebRTC, direct P2P) ─────┘
```

- **Server** (`server/`): Node.js with one dependency (`ws`). It serves the static app, stores rooms and their scrypt-hashed passwords in `/data/rooms.json`, checks the password when someone joins, relays WebRTC offers, answers and ICE candidates between members of the same room, and answers clock-sync pings.
- **Calls** (`public/assets/js/mesh.js`): a full mesh with one `RTCPeerConnection` per pair of people. Each person uploads one stream per friend, and video bitrate goes down automatically as the room grows. This works best with up to about 6–8 people.
- **Movie sync** (`public/assets/js/sync.js`): everyone shares a small playback state: playing or paused, position, timestamp on the shared server clock, audio track and subtitle track. Any change is broadcast over WebRTC data channels and the newest change wins. Each browser works out where the movie should be right now and corrects drift. It speeds up or slows down by a few percent for small offsets and seeks for large ones. In testing, browsers stayed within about 10 ms of each other.
- **Movie files are never uploaded.** Each person picks their local file. The page compares file size and name to warn when someone has a different file.

### Audio tracks and subtitles in every browser

Browsers don't let a page switch the audio track of a video file, except Safari. To work around this, Three-Eight includes a small **in-browser remuxer** (`public/assets/js/player/`):

1. It reads the container directly from the local file, in pieces. It supports **MKV/WebM** and **MP4/MOV/M4V**.
2. It repackages the video track plus the *selected* audio track into fragmented MP4 on the fly. It then feeds that to the `<video>` element through Media Source Extensions. No re-encoding happens, so CPU use is low.
3. It extracts embedded text subtitles (SRT, ASS/SSA, WebVTT, MP4 timed text) and draws them over the video. It can also load external `.srt`, `.vtt` and `.ass` files. A loaded subtitle file is sent to everyone in the room automatically.

Simple files with a single audio track play natively.

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
threeeight.urzahil.rocks {
    reverse_proxy 127.0.0.1:4567
}
```

**nginx**:

```nginx
server {
    listen 443 ssl http2;
    server_name threeeight.urzahil.rocks;
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

With `TRUST_PROXY=true` (the compose default), the server takes the client IP from `X-Forwarded-For`, which is used for login rate limiting. It also marks the admin cookie `Secure`. If you publish port 4567 directly to the internet without a proxy, set `TRUST_PROXY=false`, or bind the port to localhost only (`"127.0.0.1:4567:4567"`).

### Without Docker

```bash
npm ci
ADMIN_PASSWORD=change-me npm start
```

For local testing, `http://localhost:4567` counts as a secure context, so camera and mic work.

## Using it

1. Open `https://threeeight.urzahil.rocks/admin`, log in with `ADMIN_PASSWORD`, and create a room, for example `movienight`, with a password. The admin page also shows who is online in each room. From there you can change passwords (and optionally kick everyone) or delete rooms.
2. Send friends `https://threeeight.urzahil.rocks/movienight` and the password.
3. Each person enters a display name, which is remembered in the browser's local storage, plus the room password. They can also choose to remember the password on that device.
4. To watch together, one person clicks **Movie** and picks a file. Everyone else is asked to pick their own copy. Use the player controls, the audio (🎧) and subtitle (CC) menus, or keyboard shortcuts: `space` play/pause, `←`/`→` ±10 s, `f` full screen, `p` picture-in-picture, `m` mic, `v` camera, `c` chat.

Tip: use headphones during the movie, so your microphone doesn't send the film's sound to your friends. Movie volume is per person.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4567` | HTTP port |
| `ADMIN_PASSWORD` | random, printed at start | Password for `/admin` |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where `rooms.json` is stored |
| `TRUST_PROXY` | `false` (`true` in compose) | Trust `X-Forwarded-For` / `X-Forwarded-Proto` |
| `MAX_ROOM_SIZE` | `12` | Max participants per room |
| `STUN_URLS` | Google + Cloudflare STUN | Comma-separated STUN URLs |
| `TURN_URLS` | — | Comma-separated TURN URLs (optional) |
| `TURN_SECRET` | — | coturn `static-auth-secret` (ephemeral credentials) |
| `TURN_USERNAME` / `TURN_PASSWORD` | — | Static TURN credentials (alternative to the secret) |
| `TLS_CERT` / `TLS_KEY` | — | Serve HTTPS directly instead of using a proxy |

### Do I need TURN?

Usually not. STUN is enough for most home connections. Some friends may be behind very strict NAT, like certain mobile carriers or corporate networks. Their tile then shows "connection failed", and only they are affected. A TURN server ([coturn](https://github.com/coturn/coturn)) fixes this by relaying *their* media. That uses bandwidth on whatever host runs coturn, so it's opt-in. Configure coturn with `use-auth-secret` and `static-auth-secret=...`, then set `TURN_URLS` and `TURN_SECRET`.

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

`player-check.js` tests the in-browser player on its own: native or remux mode, audio track switching, seeking and subtitles. `e2e.js` tests the whole flow: the admin creates a room, a wrong password is rejected, two people join with fake cameras, video flows peer to peer, mute and camera state and chat arrive on the other side, and the movie syncs. The movie part covers play, pause, seeking, audio and subtitle changes, a shared subtitle file, and a late joiner. Finally the admin deletes the room and everyone is disconnected. `pip-check.js` tests picture-in-picture: the Document PiP window (the movie box moves there, subtitles still render, controls inside it drive the other person, and closing it brings the player back), the native-PiP fallback (the subtitles are mirrored into a caption track, and a pause made directly on the `<video>` reaches the room), and the compact style (chosen in Settings: the canvas stream is in native PiP, the subtitles and video are drawn on the canvas, a pause on the PiP element reaches the room, and leaving PiP cleans up).

## License

GPL-3.0 — see [LICENSE](LICENSE).
