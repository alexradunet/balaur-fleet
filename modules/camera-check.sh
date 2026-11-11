# Verify that the V4L2 webcam delivers live, non-black frames: five frames in
# a row, at least two of them different, the last one not black. The frame size
# is the device's own. Usage: duet-camera-check [DEVICE]
set -euo pipefail

device="${1:-/dev/video64}"
frames=5
capture=$(mktemp --tmpdir --suffix=.yuyv duet-camera-check.XXXXXX)
trap 'rm -f "$capture"' EXIT

if ! timeout 8s v4l2-ctl \
  --device="$device" \
  --stream-mmap=3 \
  --stream-count="$frames" \
  --stream-to="$capture" >/dev/null 2>&1; then
  echo "FAIL: $device did not deliver $frames frames within 8 seconds" >&2
  exit 1
fi

node --input-type=module - "$device" "$capture" "$frames" <<'JS'
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [device, path, frameCount] = [process.argv[2], process.argv[3], Number(process.argv[4])];

// The size and format are whatever the relay set on the device.
const format = execFileSync("v4l2-ctl", ["--device", device, "--get-fmt-video"], { encoding: "utf8" });
const size = /Width\/Height\s*:\s*(\d+)\/(\d+)/.exec(format);
const pixelFormat = /Pixel Format\s*:\s*'(\w+)/.exec(format);
if (!size || !pixelFormat) {
  console.error(`FAIL: could not read the frame size and format of ${device}`);
  process.exit(1);
}
if (pixelFormat[1] !== "YUYV") {
  console.error(`FAIL: ${device} delivers ${pixelFormat[1]}, expected YUYV`);
  process.exit(1);
}
const width = Number(size[1]);
const height = Number(size[2]);
const frameSize = width * height * 2;
const data = readFileSync(path);
if (data.length < frameSize * frameCount) {
  console.error(`FAIL: expected ${frameCount} ${frameSize}-byte YUYV frames (${width}x${height}), received ${data.length} bytes`);
  process.exit(1);
}

const frame = (i) => data.subarray(i * frameSize, (i + 1) * frameSize);

// A live sensor never repeats a frame exactly (noise), a frozen picture does.
let changing = false;
for (let i = 1; i < frameCount; i++) {
  if (Buffer.compare(frame(i - 1), frame(i)) !== 0) {
    changing = true;
    break;
  }
}

const last = frame(frameCount - 1);
let min = 255;
let max = 0;
let sum = 0;
let sumSquares = 0;
for (let offset = 0; offset < last.length; offset += 2) {
  const luminance = last[offset];
  min = Math.min(min, luminance);
  max = Math.max(max, luminance);
  sum += luminance;
  sumSquares += luminance * luminance;
}

const count = last.length / 2;
const mean = sum / count;
const standardDeviation = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
const black = max <= 20 || (mean <= 22 && standardDeviation < 3);
console.log(`${width}x${height} Y=${min}..${max} mean=${mean.toFixed(2)} stddev=${standardDeviation.toFixed(2)}`);
if (black) {
  console.error("FAIL: camera frame is uniformly black");
  process.exit(1);
}
if (!changing) {
  console.error(`FAIL: all ${frameCount} frames are identical: the picture is frozen`);
  process.exit(1);
}
console.log("PASS: webcam is delivering a changing, non-black image");
JS
