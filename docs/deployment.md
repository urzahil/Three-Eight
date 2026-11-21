# Deployment

Three-Eight is a Node.js web app. Docker Compose is the recommended deployment method. It stores room configuration in a persistent volume and listens on port `4567`.

## Docker Compose

1. Clone the repository and enter its directory.
2. Create your environment file and set a strong admin password:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set `ADMIN_PASSWORD` to a unique, strong password of at least 9 characters. The server refuses to start with a shorter one or with the example value from `.env.example`.
3. Start the app:

   ```bash
   docker compose up -d --build
   ```
4. Check status and logs:

   ```bash
   docker compose ps
   docker compose logs -f three-eight
   ```

The image has a health check (`node server/healthcheck.js`), which requests `/healthz` every 30 seconds using the same `PORT`, `HOST` and TLS settings as the server. `docker compose ps` shows `healthy`, or `unhealthy` after three failed checks in a row.

The Compose configuration publishes port `4567` on `127.0.0.1` only. This is intended for a reverse proxy on the same host. The `three-eight-data` volume stores room settings; keep it when upgrading or recreating the container.

If your reverse proxy is in another container, attach both containers to the same Docker network and use the app's container port `4567`. In that arrangement, remove the host `ports` mapping rather than exposing the app unnecessarily.

### Docker without Compose

```bash
docker build -t three-eight .
```

```bash
docker run -d --name three-eight -p 127.0.0.1:4567:4567 -e ADMIN_PASSWORD='replace-with-a-long-random-password' -e TRUST_PROXY=true -v three-eight-data:/data three-eight
```

## HTTPS and reverse proxy

HTTPS is required for browser camera and microphone access except on `localhost`. Your reverse proxy must support WebSocket upgrades for `/ws`.

### Caddy

```caddy
three-eight.example.com {
    reverse_proxy 127.0.0.1:4567
}
```

Caddy obtains and renews certificates automatically when DNS and ports are configured correctly.

### Nginx

Replace the hostname and certificate paths with your own:

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name three-eight.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4567;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
    }
}
```

Use `$http_host` to preserve a non-default port. The forwarded `Host`, scheme, and browser `Origin` must agree; if your public address differs, use `ALLOWED_ORIGINS` as described in Configuration.

If the domain has an IPv6 (`AAAA`) record, make sure the proxy listens on IPv6 as well. Mobile networks commonly use IPv6. If the page loads but the room cannot connect, test the WebSocket endpoint:

```bash
curl -6 -i -N \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://three-eight.example.com/ws
```

A successful WebSocket handshake returns `101 Switching Protocols`.

### Without a reverse proxy (`TLS_CERT` / `TLS_KEY`)

Three-Eight can serve HTTPS itself: set `TLS_CERT` to the certificate chain (Let's Encrypt's `fullchain.pem`) and `TLS_KEY` to its private key (`privkey.pem`). Without a proxy, `TRUST_PROXY` must be `false` (see [Proxy trust notes](#proxy-trust-notes)); with Docker Compose, also publish the port on the interface you want (the end of [Rate limits](#rate-limits) says how).

A renewed certificate is picked up without a restart. The server reads both files again when it receives `SIGHUP`, and every 12 hours. If they changed, the key matches the certificate and the certificate is valid today, new connections get the new certificate (connections already open keep theirs). Otherwise the current certificate stays in use and the log says why. That covers a renewal still being written, files that do not parse, and an expired copy put back. The log shows the certificate's expiry date at startup and after each reload.

To switch over right after a renewal, let certbot send the signal:

```bash
# Node.js started directly
certbot renew --deploy-hook "pkill -HUP -f server/server.js"
# Docker (the Compose service's container is called three-eight)
certbot renew --deploy-hook "docker kill -s HUP three-eight"
```

The same command in an executable script in `/etc/letsencrypt/renewal-hooks/deploy/` also runs after certbot's scheduled renewals. Without a hook, the new certificate is in use within 12 hours; certbot renews 30 days before expiry.

The files must stay readable by the user the server runs as (`node` in the Docker image). With Docker, mount the certificate directory read-only and add `TLS_CERT` and `TLS_KEY` to the `environment:` section of `docker-compose.yml`. The files in Let's Encrypt's `live/` directory are links into `archive/`, so mount the whole `/etc/letsencrypt` directory (for example at the same path) for the links to resolve.

`SIGHUP` reloads the certificate only when `TLS_CERT` and `TLS_KEY` are set. Without them, it stops the server, as before.

## Running without Docker

Install Node.js 22 or newer, then from the repository:

```bash
npm ci
ADMIN_PASSWORD='replace-with-a-strong-password' npm start
```

The default port is `4567`. For local testing, `http://localhost:4567` is a secure context for browser media permissions.

## Configuration

For a direct Node deployment, supply settings as environment variables.

With Docker Compose, `.env` is only used to fill in the values `docker-compose.yml` refers to: `ADMIN_PASSWORD`, `MAX_ROOM_SIZE`, `TURN_URLS`, `TURN_SECRET`, `TURN_USERNAME`, `TURN_PASSWORD`, `GOOGLE_SERVICE_ACCOUNT`, `DRIVE_CACHE_MB` (and `TURN_REALM` for the optional coturn service). Any other setting, such as `ALLOWED_ORIGINS`, `STUN_URLS` or `TRUST_PROXY`, must be added to (or changed in) the `environment:` section of `docker-compose.yml`.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4567` | HTTP port (`1`–`65535`) |
| `HOST` | `0.0.0.0` | Address the server listens on |
| `ADMIN_PASSWORD` | Random value printed at startup if unset | Password for `/admin`, at least 9 characters (example values from the documentation are refused) |
| `DATA_DIR` | `./data` locally; `/data` in Docker | Directory containing room data |
| `TRUST_PROXY` | `false` locally; `true` in Compose | Trust proxy headers. `true`, `1`, or `yes` means one proxy; a number specifies the proxy count. |
| `ALLOWED_ORIGINS` | — | Comma-separated additional WebSocket origins |
| `MAX_ROOM_SIZE` | `12` | Maximum participants per room (1–50). Mesh calls become demanding above roughly 6–8 participants. |
| `STUN_URLS` | Google and Cloudflare STUN | Comma-separated STUN URLs |
| `TURN_URLS` | — | Optional comma-separated TURN URLs |
| `TURN_SECRET` | — | coturn shared secret for temporary credentials |
| `TURN_USERNAME` / `TURN_PASSWORD` | — | Static TURN credentials (alternative to `TURN_SECRET`) |
| `GOOGLE_SERVICE_ACCOUNT` | — | Path to service-account JSON for Drive integration |
| `DRIVE_CACHE_MB` | `256` | Drive stream cache in memory; minimum 32 MB |
| `TLS_CERT` / `TLS_KEY` | — | Certificate and key for serving TLS directly instead of using a proxy; read again on `SIGHUP` and every 12 hours (see [Without a reverse proxy](#without-a-reverse-proxy-tls_cert--tls_key)) |

Invalid values for supported settings cause startup to fail with an error rather than silently changing the setting. That includes `STUN_URLS` and `TURN_URLS` (each entry must look like `stun:host[:port]` or `turn:host[:port][?transport=udp|tcp]`, `stuns:`/`turns:` for TLS) and TURN without credentials: browsers refuse every connection when one ICE server is malformed, so a typo there would otherwise break every call. `TURN_URLS` needs `TURN_SECRET`, or both `TURN_USERNAME` and `TURN_PASSWORD`.

### Proxy trust notes

The Compose configuration assumes the app is only reachable through the local reverse proxy and sets `TRUST_PROXY=true`. With one proxy, the server uses the proxy-appended client address from `X-Forwarded-For` for rate limiting and uses forwarded HTTPS information for secure-cookie and security-header handling. If there are multiple proxies, set `TRUST_PROXY` to the actual number of trusted hops. Do not set it higher than the real proxy count, or client IPs can be spoofed.

Behind a proxy without `TRUST_PROXY`, every visitor appears to come from the proxy's address, so per-address limits apply to all of them together: the password attempt limits, the limit on looking up rooms that don't exist (30 in 10 minutes, so room names can't be found by trying many), and the limit of 64 open connections per address (twice `MAX_ROOM_SIZE` if that is higher). The server logs a warning when it refuses a connection for that reason.

### Rate limits

Per-address limits count an IPv4 address on its own. An IPv6 address is counted under its /64, its /56 and its /48. A whole /56 gets twice one address's allowance, and a whole /48 four times. One subscriber usually controls a /56 or a /48, so switching between the /64s inside it does not give fresh attempts. The limits are:

- **Admin password:** 10 wrong attempts per address in 15 minutes. After 100 failed logins from all addresses together within 15 minutes, an address that fails once gets no further attempts until its window ends, and the server logs a warning. An attacker with many addresses then gets one guess per address instead of ten, but cannot lock you out: logging in with the right password from an address that has not failed still works.
- **Room passwords:** 20 wrong attempts per address in 10 minutes. The server checks at most 2 room passwords at a time, with up to 32 more waiting. Beyond that, a join is asked to retry, so a crowd of guesses cannot slow down the rest of the server.
- **Rooms that don't exist:** 30 lookups per address in 10 minutes.
- **Connections:** 64 open WebSocket connections per address, or twice `MAX_ROOM_SIZE` if that is higher.

Use a long random password for the admin page and for rooms. These limits slow down guessing, but they cannot make a short password safe.

If exposing port `4567` directly without a reverse proxy, edit `docker-compose.yml`: set `TRUST_PROXY: "false"` and change the `ports` mapping to publish on the interface you intend (for example `"4567:4567"`). Setting `TRUST_PROXY` in `.env` has no effect with Compose. HTTPS is still recommended and required for camera/microphone on non-localhost origins.

## Do I need TURN?

Usually, no. STUN is enough for many home connections. TURN can help a participant whose network or carrier NAT prevents peer-to-peer media connections. That participant may see a connection failure while others work. TURN relays that participant's traffic and consumes bandwidth on the TURN host.

Three-Eight's Compose file includes a commented coturn service with step-by-step instructions. To use it, uncomment it and set `TURN_SECRET`, `TURN_REALM` (the TURN host name) and `TURN_URLS` in `.env` (see `.env.example`). For a separate coturn server, configure it with `use-auth-secret` and `static-auth-secret`, then set `TURN_URLS` and `TURN_SECRET` in Three-Eight. TURN credentials are handed out only to room members, after the password check, and are renewed while they stay connected; the public `/api/config` lists STUN servers only. With `TURN_SECRET`, every member gets a login of its own (`<expiry>:<member id>`), so coturn's per-login quota (`--user-quota`) counts one person's relays: a browser asks for a relay on each TURN URL for each friend it is linked to (33 with the three URLs of `.env.example` in a full room of 12). The commented coturn service also caps relay bandwidth per link (`--max-bps`) and in total (`--bps-capacity`, in bytes per second): set the total to a little below what your server's connection carries. See the coturn documentation for firewall and relay-port requirements. Avoid enabling TURN unless needed, because relay traffic can be substantial.

## Updating

Pull the new version and rebuild/recreate the app container:

```bash
git pull
docker compose up -d --build
```

Room data is stored in the persistent volume, so the container can be rebuilt without deleting rooms. Back up the volume or its contents before maintenance.

The rooms are in `rooms.json` in the data directory. Each change is written to a new file that is flushed to disk before it replaces the old one, and the previous version is kept as `rooms.json.bak`. If `rooms.json` is ever unreadable, the server moves it aside (`rooms.json.corrupt-<time>`) and starts from the backup, which lacks only the last change.
