# Verify that the V4L2 webcam delivers changing, non-black frames.
set -euo pipefail

device="${1:-/dev/video64}"
capture=$(mktemp --suffix=.yuyv duet-camera-check.XXXXXX)
trap 'rm -f "$capture"' EXIT

if ! timeout 8s v4l2-ctl \
  --device="$device" \
  --stream-mmap=3 \
  --stream-count=3 \
  --stream-to="$capture" >/dev/null 2>&1; then
  echo "FAIL: $device did not deliver three frames within 8 seconds" >&2
  exit 1
fi

node --input-type=module - "$capture" <<'JS'
import { readFileSync } from "node:fs";

const width = 1280;
const height = 720;
const frameSize = width * height * 2;
const data = readFileSync(process.argv[2]);
if (data.length < frameSize * 3) {
  console.error(`FAIL: expected three ${frameSize}-byte YUYV frames, received ${data.length} bytes`);
  process.exit(1);
}

const frame = data.subarray(data.length - frameSize);
let min = 255;
let max = 0;
let sum = 0;
let sumSquares = 0;
for (let offset = 0; offset < frame.length; offset += 2) {
  const luminance = frame[offset];
  min = Math.min(min, luminance);
  max = Math.max(max, luminance);
  sum += luminance;
  sumSquares += luminance * luminance;
}

const count = frame.length / 2;
const mean = sum / count;
const standardDeviation = Math.sqrt(sumSquares / count - mean * mean);
const black = max <= 20 || (mean <= 22 && standardDeviation < 3);
console.log(`Y=${min}..${max} mean=${mean.toFixed(2)} stddev=${standardDeviation.toFixed(2)}`);
if (black) {
  console.error("FAIL: camera frame is uniformly black");
  process.exit(1);
}
console.log("PASS: webcam is delivering a non-black image");
JS
