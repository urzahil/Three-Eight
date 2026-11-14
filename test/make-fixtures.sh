#!/usr/bin/env bash
# Generate small test movies with multiple audio and subtitle tracks (needs ffmpeg).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fixtures
cd fixtures
cat > subs_en.srt <<'SRT'
1
00:00:01,000 --> 00:00:04,000
Hello <i>world</i>

2
00:00:05,000 --> 00:00:08,000
Second line
two rows

3
00:00:20,000 --> 00:00:25,000
Twenty seconds
SRT
cat > subs_it.ass <<'ASS'
[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:02.00,0:00:06.00,Default,,0,0,0,,Ciao {\i1}mondo{\i0}\Nseconda riga
Dialogue: 0,0:00:10.00,0:00:14.00,Default,,0,0,0,,{\an8}In alto
ASS
FF="ffmpeg -hide_banner -loglevel error -y"
SRC=(-f lavfi -i "testsrc2=size=640x360:rate=24:duration=40" -f lavfi -i "sine=frequency=440:duration=40" -f lavfi -i "sine=frequency=880:duration=40")
# MKV: H.264 (B-frames) + AAC + Opus + SRT + ASS
$FF "${SRC[@]}" -i subs_en.srt -i subs_it.ass -map 0 -map 1 -map 2 -map 3 -map 4 \
  -c:v libx264 -preset veryfast -bf 3 -g 48 -c:a:0 aac -c:a:1 libopus -c:s:0 srt -c:s:1 ass \
  -metadata:s:a:0 language=eng -metadata:s:a:0 title=English -metadata:s:a:1 language=ita -metadata:s:a:1 title=Italiano \
  -metadata:s:s:0 language=eng -metadata:s:s:1 language=ita multi.mkv
# MP4: H.264 + 2x AAC + mov_text
$FF "${SRC[@]}" -i subs_en.srt -map 0 -map 1 -map 2 -map 3 -c:v libx264 -preset veryfast -bf 3 -g 48 -c:a aac -c:s mov_text \
  -metadata:s:a:0 language=eng -metadata:s:a:1 language=ita -metadata:s:s:0 language=eng multi.mp4
# MP4 with one audio track and the index up front: plays natively (no remuxer)
$FF -i multi.mp4 -map 0:v -map 0:a:0 -c copy -movflags +faststart single.mp4
# MKV: VP9 + Opus + AC-3 (AC-3 is unplayable outside Safari)
$FF "${SRC[@]}" -map 0 -map 1 -map 2 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 500k -c:a:0 libopus -c:a:1 ac3 multi.webm.mkv
echo "fixtures ready in $(pwd)"
