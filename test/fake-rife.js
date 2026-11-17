'use strict';
// Stand-in for rife-ncnn-vulkan's directory mode, for end-to-end tests without a GPU.
// Same arguments and same file naming; it copies the nearer input frame instead of interpolating.
const fs = require('fs');
const path = require('path');
const { rifeMap } = require('../src/lib/pipeline');
const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const inDir = opt('-i'), outDir = opt('-o');
const files = fs.readdirSync(inDir).sort();
const n = Number(opt('-n')) || files.length * 2;
if ((process.env.FAKE_RIFE_FAIL || process.argv.includes('--fake-fail')) && !process.argv.includes('-1')) { console.error('vkQueueSubmit failed'); process.exit(255); }
process.stderr.write('[0 Fake GPU]  queueC=0[1]\n');
for (let i = 0; i < n; i++) {
  const { sx, t } = rifeMap(i, files.length, n);
  fs.copyFileSync(path.join(inDir, files[t < 0.5 ? sx : sx + 1]), path.join(outDir, String(i + 1).padStart(8, '0') + '.png'));
}
