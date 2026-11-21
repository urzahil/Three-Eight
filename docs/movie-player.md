# Movie player and watch-together features

Playback controls are synchronized for the room: play/pause, seeking, audio track and subtitle selection. Each browser corrects playback drift using shared state and timestamps. The film always plays at normal speed.

The movie's volume is your own (the slider in the controls), and the movie plays through the speakers or headphones chosen in **Settings → Speakers or headphones**, like the call. That choice exists in Chrome, Edge and Firefox (Safari plays through the system's output); in Firefox, **Choose…** opens the browser's list of outputs. If the chosen output is not connected, the default one plays instead, until it is back.

A click on the picture plays or pauses for everyone, and a double-click shows it full screen (without pausing anyone). On a phone or tablet a tap only shows or hides the controls: use the play button to play or pause, so a tap meant to find the controls never pauses the film for the room.

## Choose a movie source

Participants in the same room can use different sources:

| Source | What it means | Notes |
|---|---|---|
| Own file | Each person opens their own copy | No movie data needs to be transferred; files are compared to help detect mismatches. |
| Friend's file | A viewer streams from another participant's local copy | Movie data travels peer-to-peer using WebRTC; the source's upload and viewer connections still matter. |
| Google Drive | The room's attached Drive folder is streamed by the server | Requires the administrator to configure Drive. See [Google Drive setup](google-drive.md). |

Open the **Movie** dialog to select a local file (**Choose movie file…**) or a Drive movie (**From Google Drive**). When a movie is already playing, others are offered **Stream from *name*'s copy** (or **Stream from a friend's copy** when several people share), **Stream from Google Drive**, or **Use my own copy…**. Viewers can switch sources during playback; **Stop using my file** goes back to streaming.

## Peer-to-peer movie sharing

Movie pieces can be exchanged between browsers using WebRTC data channels. Three-Eight compares file size, duration and a sampled SHA-256 content fingerprint (file size plus three 64 KiB samples) before using copies as sources. The fingerprint is a useful mismatch check, not a full-file integrity hash. There are no per-piece checksums, so use file sharing only among people you trust.

Movie data is not stored on the Three-Eight server. In peer sharing, the source and other peers upload pieces directly to browsers. A source still needs enough upload bandwidth to send the movie's bitrate to the peer network. Streaming from a friend's copy requires Media Source Extensions (MSE); browsers without MSE may need to open their own file. Drive movies still play in such browsers, straight from the server.

Sharing is automatic while you have the room's movie open from a file. To opt out, turn off **Settings → Share my movie file with the room**: friends are then not offered your copy, and your file is not read for them.

If the person sharing leaves, friends keep watching what they have already received; parts nobody has loaded cannot be played, and a message explains why.

## Container and track support

Three-Eight includes a browser-side remuxer for MKV/WebM and MP4/MOV/M4V. It repackages the video and selected audio into fragmented MP4 for playback through Media Source Extensions. It does not re-encode the movie. Simple local files with a single audio track can use native playback; streamed movies use the remuxer.

AVI, WMV, FLV, MPEG and MPEG-TS files can't be played in a browser: the player says so when one is opened, and the Google Drive list shows them as "format not supported". Convert such a film to MP4 or MKV (H.264 video, AAC audio), for example with HandBrake or ffmpeg.

Browser decoder support varies:
- Video: H.264, VP9 and AV1 wherever the browser and device can decode them; HEVC only in Safari and in Chrome/Edge with hardware support.
- Audio: AAC, Opus, FLAC and MP3 are commonly supported, but support depends on browser/device. AC-3/E-AC-3 support is limited (Safari is the supported case); DTS and TrueHD are not supported by the player.
- Unsupported tracks are indicated in the audio menu where detected.

If a file only has an unsupported AC-3/DTS audio track, consider making a compatible copy with an AAC track while copying video without re-encoding:

```bash
ffmpeg -i movie.mkv -map 0 -c copy -map 0:a:0 -c:a:1 aac -b:a:1 384k movie-aac.mkv
```

## Subtitles

- External `.srt`, `.vtt` and `.ass` subtitle files can be loaded from the CC menu. Loaded subtitle text is shared with room members, including later joiners.
- Embedded text subtitles supported by the remuxer include SRT, ASS/SSA, WebVTT and MP4 timed text. A participant with the file can load an embedded subtitle and share its text with the room.
- For Google Drive movies, matching subtitle files alongside the film may be detected and loaded automatically. Additional matching files can be selected from the subtitle menu.
- Image-based Blu-ray/DVD subtitles (PGS/VobSub) are not supported. Use a text subtitle such as SRT instead.
- Subtitle selection is synchronized: loading a subtitle file or choosing a track turns it on for everyone.
- Under **Just for me** in the CC menu, anyone can turn subtitles off, pick another track, or load a subtitle file only for themselves (it is not sent to anyone else). That choice lasts until someone picks a different subtitle for the room or starts another movie; **Same as everyone** goes back to the room's choice. A file loaded just for you stays in the menu until the movie changes.
- Subtitle delay and size can be adjusted locally in Settings. The delay is remembered for each movie (on that device) and starts at zero for another one.
- Subtitle files may be Unicode (UTF-8 or UTF-16) or in an older code page. Common ones (Western, Central European, Cyrillic, Greek, Turkish, Hebrew, Arabic) are recognised automatically; the browser's language decides between look-alikes. If a file still shows the wrong letters, choose its encoding under **Settings → Encoding of subtitle files that aren't Unicode** and load it again. The text is shared with the room as it was read.

## Picture-in-picture

Picture-in-picture varies by browser:
- **Chrome and Edge:** Settings offers a floating player (Document PiP) and compact video PiP. Floating mode keeps controls, subtitle and track menus in the PiP window. Compact mode shows the video and subtitles but has fewer controls; use the main page for track selection.
- **Safari (desktop/iOS):** system PiP. Three-Eight mirrors subtitles into a caption track (also in the iPhone's full-screen player), and play/pause and seeking in the system's own controls are synchronized.
- **Firefox:** use Firefox's own video PiP control. Subtitle display there is best effort.

Media keys and supported system PiP controls use the Media Session API and control the room.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` or `k` | Play / pause \* |
| `←` / `→` | Seek backward / forward \* (default 10 seconds; configurable in Settings to 5, 10, 15, 30 or 60 seconds) |
| `p` | Toggle picture-in-picture \* |
| `f` | Toggle fullscreen |
| `m` | Toggle microphone |
| `v` | Toggle camera |
| `s` | Toggle screen share where supported |
| `c` | Toggle chat |

\* Movie shortcuts (`Space`, `k`, the arrows and `p`) are active only when you have joined the movie that is playing; `p` also needs a picture-in-picture style your browser supports. All shortcuts are ignored while typing in text fields, while dialogs are open, or when Ctrl/Alt/Command is held. They also work in supported PiP windows.

## Screen sharing

Screen sharing is available in desktop browsers. The browser picker selects a screen, window or tab; audio is not shared. Only one person can share at a time. Screen sharing and movie playback are mutually exclusive: stop the share or close the movie before switching. Mobile browsers can view a share but cannot initiate it. Double-click a shared screen, or the movie, to show it full screen.

On macOS, the browser may need Screen Recording permission in System Settings → Privacy & Security. Screen share is sent peer-to-peer to each participant, so upload bandwidth increases with room size.
