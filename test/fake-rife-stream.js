'use strict';
// Stand-in for rife-ncnn-vulkan's stream mode, for tests without a GPU.
// Reads raw RGB24 frames from stdin and writes interpolated raw RGB24 frames to stdout.
// Blends frames the exact same way as fake-rife.js (nearest neighbor based on t < 0.5).

const fs = require('fs');

const a = process.argv.slice(2);
const opt = (k) => {
  const i = a.indexOf(k);
  return i >= 0 && i + 1 < a.length ? a[i + 1] : null;
};

const width = Number(opt('-w') || opt('--width'));
const height = Number(opt('-h') || opt('--height'));
const frameBytes = width * height * 3;

const streamIdx = a.indexOf('--stream');
let timesPath = opt('-l') || opt('-t') || opt('--times') || opt('--list');
if (!timesPath && streamIdx >= 0 && streamIdx + 1 < a.length && !a[streamIdx + 1].startsWith('-')) {
  timesPath = a[streamIdx + 1];
}

if (!timesPath || !width || !height) {
  console.error('fake-rife-stream: missing -w, -h, or frame-time list file');
  process.exit(1);
}

// Failure is requested by argument only, never by a process-global env var,
// because cargo runs tests in parallel threads of one process.
if (process.argv.includes('--fake-fail')) {
  console.error('vkQueueSubmit failed');
  process.exit(255);
}

process.stderr.write('[0 Fake GPU]  queueC=0[1]\n');

const timesBuf = fs.readFileSync(timesPath);
const count = Math.floor(timesBuf.length / 4);
const times = [];
for (let i = 0; i < count; i++) {
  times.push(timesBuf.readFloatLE(i * 4));
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const allData = Buffer.concat(chunks);
  const sourceFrames = [];
  for (let offset = 0; offset + frameBytes <= allData.length; offset += frameBytes) {
    sourceFrames.push(allData.subarray(offset, offset + frameBytes));
  }

  if (sourceFrames.length === 0) {
    process.exit(0);
  }

  for (let i = 0; i < times.length; i++) {
    const time = times[i];
    let sx = Math.floor(time);
    let t = time - sx;
    if (sx < 0) {
      sx = 0;
      t = 0;
    }
    if (sx >= sourceFrames.length - 1) {
      sx = Math.max(0, sourceFrames.length - 2);
      t = 1.0;
    }
    const chosenIdx = t < 0.5 ? sx : sx + 1;
    const safeIdx = Math.min(chosenIdx, sourceFrames.length - 1);
    process.stdout.write(sourceFrames[safeIdx]);
  }
});
