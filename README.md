# Three-Eight

Video calls and synchronized movie nights with friends, directly in your browser. No app installation is required.

- Video calls with camera, microphone, device selection, speaking indicators, and chat.
- Watch movies together with synchronized playback, seeking, audio tracks, and subtitles.
- Share a movie from your device, stream it from a friend's copy, or use a room's Google Drive folder.
- Screen sharing and picture-in-picture (browser support varies).
- Rooms created by an administrator, each with its own (optional) password.
- Installable as an app (PWA) on desktop and mobile.

## How it works

Three-Eight uses a small Node.js server to host the web app, create rooms, authenticate room members, and relay WebRTC connection setup. Once connected, audio, video, chat, movie synchronization, and movie data are exchanged directly between browsers whenever possible.

Movie files are not stored on the server. The optional Google Drive integration lets the server stream files from a room's shared Drive folder. Three-Eight uses peer-to-peer sharing to distribute movie data between participants, reducing server bandwidth.

A full-mesh video call uploads a stream to each participant, so rooms work best with around 6–8 people. Larger rooms can use considerably more upload bandwidth.

## Deploy with Docker Compose

### 1. Configure

Clone the repository and create your environment file:

```bash
cp .env.example .env
```

Edit `.env` and set a strong administrator password (at least 9 characters; the server refuses to start with the example value):

```dotenv
ADMIN_PASSWORD=replace-with-a-long-random-password
```

Keep `.env` private and never commit it.

### 2. Start Three-Eight

```bash
docker compose up -d --build
```

The app listens on port `4567`, bound to localhost (`127.0.0.1`) by default. This is intended for use behind a reverse proxy that provides HTTPS. Docker Compose stores room data in the persistent `three-eight-data` volume.

Check the container status:

```bash
docker compose ps
```

The service should report `healthy`.

### 3. Set up HTTPS

Camera and microphone access require HTTPS, except when accessing `localhost`. Put a reverse proxy in front of Three-Eight and ensure WebSocket connections to `/ws` are forwarded.

**Caddy** (simple option):

```caddy
three-eight.example.com {
    reverse_proxy 127.0.0.1:4567
}
```

Replace `three-eight.example.com` with your domain. Caddy obtains and renews TLS certificates automatically, provided DNS and network access are configured correctly.

If you use another reverse proxy, configure it to forward WebSocket upgrades and preserve the host header. The proxy must also be reachable over IPv6 if your domain has an IPv6 (`AAAA`) record. See [Deployment](docs/deployment.md) for an nginx example.

> Keep port 4567 private when using a reverse proxy. `docker-compose.yml` binds it to localhost and sets `TRUST_PROXY: "true"` for a trusted local proxy. If you expose the application directly without a proxy, edit `docker-compose.yml`: publish the port on the interface you want and set `TRUST_PROXY: "false"`. Setting `TRUST_PROXY` in `.env` has no effect, because the compose file sets it directly.

## Create a room and invite friends

1. Open `https://your-domain.example/admin`.
2. Sign in using the `ADMIN_PASSWORD` configured in `.env`.
3. Create a room and give it a password (leaving it empty creates a room anyone with the link can join).
4. Share the room link and password with your friends. A room named `movienight` is available at `https://your-domain.example/movienight`.
5. Participants enter a display name and the room password, choose their camera and microphone, and join. The name, and optionally the password, are remembered on that device. A camera or microphone switched off in the lobby is not requested from the browser until it is turned on.

The admin page shows who is online in each room and lets you create and delete rooms, change room passwords (optionally disconnecting everyone currently in the room), and attach a Google Drive folder to a room (optional).

## Watch a movie

Click **Movie** in the room. You can:

- **Use your own file:** choose the movie from your device. Friends can open their own copy or stream from yours.
- **Stream from a friend's copy:** join the movie without having the file. Your browser receives movie data from other participants over WebRTC.
- **Google Drive:** if an administrator has attached a Drive folder to the room, select a movie from it. The server streams it from Drive, and participants may share the movie data between browsers.

Playback is synchronized for the room, including play/pause, seeking, audio-track selection, and subtitles. Movie volume is per person. Headphones are recommended to prevent movie audio from feeding back through your microphone.

Your copy of a movie is offered to friends automatically; turn this off in **Settings → Share my movie file with the room**. See [Movie player](docs/movie-player.md) for sources, codecs, subtitles, and picture-in-picture.

For screen sharing, click **Share screen** and choose a screen, window, or browser tab. Screen sharing is available on desktop browsers and cannot be used at the same time as the movie player.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `k` | Play / pause \* |
| `←` / `→` | Back / forward 10 s \* (step adjustable in Settings: 5, 10, 15, 30 or 60 s) |
| `p` | Picture-in-picture on / off \* |
| `f` | Full screen on / off |
| `m` | Microphone on / off |
| `v` | Camera on / off |
| `s` | Share screen on / off (desktop browsers) |
| `c` | Open / close chat |

\* Only while you have joined the movie that is playing. Shortcuts are ignored while typing in a text field or a dialog, and when Ctrl, Alt or ⌘ is held. They also work in the picture-in-picture window.

## Google Drive (optional)

To enable Drive movies:

1. Create a Google Cloud project and enable the Google Drive API.
2. Create a service account and download a JSON key. The service account does not need project roles.
3. Keep the key file private on your server. Do not commit it to Git.
4. Configure `GOOGLE_SERVICE_ACCOUNT` to the key file's path. With Docker Compose, uncomment the read-only key mount in `docker-compose.yml` and set the variable in `.env` to the mounted path.
5. Share the Drive folder with the service account email as **Viewer**.
6. In `/admin`, attach that folder to the room. Give the room a password: in a room without one, anyone who knows its name can stream the whole folder (the admin page warns about this).

See [Google Drive integration](docs/google-drive.md) for the full Docker mount example and security notes.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4567` | HTTP port |
| `HOST` | `0.0.0.0` | Address the server listens on |
| `ADMIN_PASSWORD` | Random if unset | Admin login password, at least 9 characters; set this explicitly |
| `DATA_DIR` | `./data` (Docker: `/data`) | Room storage location |
| `TRUST_PROXY` | `false` (Compose: `true`) | Trust proxy headers; use only behind a trusted proxy |
| `ALLOWED_ORIGINS` | — | Additional allowed WebSocket origins |
| `MAX_ROOM_SIZE` | `12` | Room capacity (1–100); large rooms use more bandwidth |
| `STUN_URLS` | Built-in STUN servers | STUN server list |
| `TURN_URLS` | — | Optional TURN server URLs for difficult network connections |
| `TURN_SECRET` | — | TURN shared secret for coturn's secret-based authentication |
| `TURN_USERNAME` / `TURN_PASSWORD` | — | Alternative static TURN credentials |
| `GOOGLE_SERVICE_ACCOUNT` | — | Service-account JSON key path for Drive integration |
| `DRIVE_CACHE_MB` | `256` | Drive streaming cache size in memory |
| `TLS_CERT` / `TLS_KEY` | — | Optional direct TLS certificate/key if not using a proxy |

With Docker Compose, only `ADMIN_PASSWORD`, `MAX_ROOM_SIZE`, the `TURN_*` variables, `GOOGLE_SERVICE_ACCOUNT` and `DRIVE_CACHE_MB` are read from `.env`. To change any other setting, add it to the `environment:` section of `docker-compose.yml`.

## More documentation

- [Deployment](docs/deployment.md): Docker and Node setup, nginx, proxy trust, TURN, updating.
- [Movie player](docs/movie-player.md): movie sources, peer sharing, codecs, subtitles, picture-in-picture, screen sharing.
- [Google Drive integration](docs/google-drive.md): service account setup, access model, limits.
- [Customization](docs/customization.md): interface styles, colors, installing as an app.
- [Development](docs/development.md): running locally and the test suites.

## Troubleshooting

- **Camera or microphone unavailable:** use HTTPS (or `localhost`) and check browser permissions.
- **Can't connect to the room/server:** check that your reverse proxy forwards WebSockets on `/ws`, and that the proxy's host/origin settings match the address you use.
- **Works on Wi-Fi but not mobile data:** check IPv6 and ensure your proxy has an IPv6 listener if your domain has an `AAAA` record.
- **A participant can't connect to another participant:** some networks have restrictive NAT/firewalls. Configure an optional TURN server (coturn) and set `TURN_URLS` and `TURN_SECRET` or the static credential pair. See [Do I need TURN?](docs/deployment.md#do-i-need-turn).
- **Container status:** run `docker compose ps` and `docker compose logs -f three-eight` to inspect service health and logs.

## Update

From the repository directory, pull the latest changes and rebuild:

```bash
git pull
docker compose up -d --build
```

Room data persists in the Docker volume across container rebuilds. Back up your volume regularly.

## License

GPL-3.0 — see [LICENSE](LICENSE).
