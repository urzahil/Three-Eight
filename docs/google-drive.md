# Google Drive integration

A room can have one Google Drive folder attached to it. Three-Eight's server accesses Drive using a Google service account; room members do not connect to Google directly. Movies are streamed and cached in memory, not saved to the server's disk.

## Set up a Google service account

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a dedicated project. Do not attach a billing account for this integration.
2. Enable the **Google Drive API**.
3. Create a service account under **IAM & Admin → Service Accounts**. It does not need project roles for this use.
4. Open the service account, choose **Keys → Add key → Create new key → JSON**, and download the key. Treat this JSON as a secret.
5. Configure the Three-Eight server to use the key.

## Docker Compose setup

Save the downloaded file beside `docker-compose.yml` as `google-service-account.json`. In `docker-compose.yml`, uncomment the read-only mount already present under the app service's `volumes`:

```yaml
volumes:
  - ./google-service-account.json:/run/secrets/google-service-account.json:ro
```

Set the following in `.env`:

```dotenv
GOOGLE_SERVICE_ACCOUNT=/run/secrets/google-service-account.json
```

Restart or recreate the app after changing its configuration. The container runs as the `node` user; make sure the mounted file is readable by that user. On a single-user Linux host, `chmod 644 google-service-account.json` is a simple option, but protect the host and file from unauthorized access.

Do not commit the key. Keep it outside public folders and backups that are shared without appropriate protection.

## Share folders and attach them to rooms

1. In Google Drive, share each room's folder with the service account email address (ending in `iam.gserviceaccount.com`) as **Viewer**. The folder does not need to be public.
2. Open Three-Eight's `/admin` page and sign in.
3. Give the room a password (recommended). In a room without one, anyone who knows or guesses the room's name can join and stream the whole folder through your server. The admin page warns when a room with a folder has no password.
4. Click **Drive…** beside the room and paste the folder URL. The dialog displays the service account email for sharing.
5. Save. Three-Eight checks that the account can access the folder and reports the result.

Each room is associated with its own Drive folder. The service account may have access to other folders, but Three-Eight serves only the folder attached to the room and its subfolders.

## How access works

- The server reads the folder and streams requested movie ranges to participants.
- Browser clients request Drive data from Three-Eight; they do not call Google Drive themselves.
- Each member gets its own token for the room's folder, sent in authorization headers. For native video playback, the browser exchanges the token for a restricted cookie because a video element cannot add authorization headers.
- A token is valid for one hour and renewed while the member stays in the room, so someone who leaves loses access within the hour. Removing someone in `/admin` ends their access at once, including downloads in progress; changing the room password ends everyone's (members still in the room get a new token).
- Movies are not persisted on the server's disk. Stream data may be cached in memory for performance.
- The integration uses a short-lived in-memory cache controlled by `DRIVE_CACHE_MB` (default 256 MB; values below 32 MB are raised to the minimum).

## Limits and troubleshooting

- Folder listings support up to 5,000 items; large folders display a notice.
- A room can have at most 3 × `MAX_ROOM_SIZE` Drive streams open at once, and one member at most 8. At most 64 requests wait for a free connection to Google before the server answers "busy, try again shortly".
- The server makes at most 10 metadata calls to Google per second (listings, file details, folder checks) for all rooms together, with bursts of up to 100. This keeps one member from using up the service account's API quota, which every room shares.
- Requests for files that are not in the room's folder are limited to 60 per address in 10 minutes. Past that, the address gets "too many requests" for every Drive request until the window ends. The app only asks for files a listing showed, so people using it normally don't reach the limit.
- Folder listings are cached for 45 seconds in the browser and 60 seconds on the server, and folder membership checks for 60 seconds. Use the reload button (↻) next to **From Google Drive** to refresh a listing.
- Browsers without Media Source Extensions (such as old iOS versions) play Drive movies straight from the server and do not take part in peer sharing, which costs the server a full copy for that viewer.
- Google may enforce download quotas on some files. If a quota error appears, use a local copy until it clears.
- If `GOOGLE_SERVICE_ACCOUNT` is set but the key cannot be read, the server logs the issue and disables Drive integration; the admin dialog then reports that Drive is not configured.
- The key must use Google's own token endpoint, as keys downloaded from Google Cloud do. Pointing Drive at other endpoints (`token_uri`, `GOOGLE_API_BASE`) is for the test suite only and requires `DRIVE_DEBUG=1`.

## Revoking access and security

The JSON key permits the service account to access resources shared with it. Share only the folders intended for Three-Eight. To revoke access, remove the folder's share from the service account or delete/revoke the service-account key in Google Cloud. If a key may have been exposed, revoke it immediately and generate a replacement.
