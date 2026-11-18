# Three-Eight

Video calls and synchronized movie nights with friends, directly in your browser. No app installation is required.

- Video calls with camera, microphone, and chat.
- Watch movies together with synchronized playback, seeking, audio tracks, and subtitles.
- Share a movie from your device, stream it from a friend's copy, or use a room's Google Drive folder.
- Screen sharing and picture-in-picture (browser support varies).
- Private, password-protected rooms.

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

Edit `.env` and set a strong administrator password:

```dotenv
ADMIN_PASSWORD=replace-with-a-long-random-password
TRUST_PROXY=true
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

If you use another reverse proxy, configure it to forward WebSocket upgrades and preserve the host header. The proxy must also be reachable over IPv6 if your domain has an IPv6 (`AAAA`) record.

> Keep port 4567 private when using a reverse proxy. The Compose configuration binds it to localhost and uses `TRUST_PROXY=true` for a trusted local proxy. If you expose the application directly without a proxy, change the proxy setting to `TRUST_PROXY=false` and configure HTTPS separately.

## Create a room and invite friends

1. Open `https://your-domain.example/admin`.
2. Sign in using the `ADMIN_PASSWORD` configured in `.env`.
3. Create a room and set its room password.
4. Share the room link and password with your friends. A room named `movienight` is available at `https://your-domain.example/movienight`.
5. Participants enter a display name and room password, then enable their camera or microphone as needed.

The admin page lets you manage rooms, change room passwords, remove participants, and delete rooms. You can also attach a Google Drive folder to a room (optional).

## Watch a movie

Click **Movie** in the room. You can:

- **Use your own file:** choose the movie from your device. Friends can open their own copy or stream from yours.
- **Stream from a friend's copy:** join the movie without having the file. Your browser receives movie data from other participants over WebRTC.
- **Google Drive:** if an administrator has attached a Drive folder to the room, select a movie from it. The server streams it from Drive, and participants may share the movie data between browsers.

Playback is synchronized for the room, including play/pause, seeking, audio-track selection, and subtitles. Headphones are recommended to prevent movie audio from feeding back through your microphone.

For screen sharing, click **Share screen** and choose a screen, window, or browser tab. Screen sharing is available on desktop browsers and cannot be used at the same time as the movie player.

## Google Drive (optional)

To enable Drive movies:

1. Create a Google Cloud project and enable the Google Drive API.
2. Create a service account and download a JSON key. The service account does not need project roles.
3. Keep the key file private on your server. Do not commit it to Git.
4. Configure `GOOGLE_SERVICE_ACCOUNT` to the key file's path. With Docker Compose, mount the file read-only into the container and set the variable in `.env` to the mounted path.
5. Share the Drive folder with the service account email as **Viewer**.
6. In `/admin`, attach that folder to the room.

See the repository's existing Google Drive documentation/details for the full Docker mount example and security notes.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4567` | HTTP port |
| `ADMIN_PASSWORD` | Random if unset | Admin login password; set this explicitly |
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

For advanced proxy, TURN, Drive, player, and development options, refer to the detailed documentation/source comments in the repository.

## Troubleshooting

- **Camera or microphone unavailable:** use HTTPS (or `localhost`) and check browser permissions.
- **Can't connect to the room/server:** check that your reverse proxy forwards WebSockets on `/ws`, and that the proxy's host/origin settings match the address you use.
- **Works on Wi-Fi but not mobile data:** check IPv6 and ensure your proxy has an IPv6 listener if your domain has an `AAAA` record.
- **A participant can't connect to another participant:** some networks have restrictive NAT/firewalls. Configure an optional TURN server (coturn) and set `TURN_URLS` and `TURN_SECRET` or the static credential pair.
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
