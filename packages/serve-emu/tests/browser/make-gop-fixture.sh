#!/bin/sh
# Regenerates tests/browser/gop-red-green.h264: one 64x64 baseline GOP of 300
# frames at 10 fps, red for frames 0-14 and green for 15-299, with a single IDR
# (no scene-cut keyframe) so the green frames can only be reached by decoding
# P frames. Requires GStreamer with x264enc.
set -eu
cd "$(dirname "$0")"
raw=$(mktemp)
trap 'rm -f "$raw"' EXIT
python3 - "$raw" <<'PY'
import sys
red, green = b"\xff\x00\x00" * 64 * 64, b"\x00\xff\x00" * 64 * 64
with open(sys.argv[1], "wb") as out:
    for frame in range(300):
        out.write(red if frame < 15 else green)
PY
gst-launch-1.0 -q filesrc location="$raw" \
  ! rawvideoparse format=rgb width=64 height=64 framerate=10/1 \
  ! videoconvert ! video/x-raw,format=I420 \
  ! x264enc key-int-max=1000 bframes=0 threads=1 speed-preset=ultrafast \
      byte-stream=true option-string="scenecut=0:aud=0" \
  ! video/x-h264,profile=constrained-baseline,stream-format=byte-stream \
  ! filesink location=gop-red-green.h264
