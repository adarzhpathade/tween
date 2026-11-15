'use strict';
// Unit tests for the pure parts of the pipeline. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { ratio, planChunks, rifeMap, cutFixes, PngSplitter, colourOf } = require('../src/lib/pipeline');
const { parseVulkanDevices, vendorOf } = require('../src/lib/setup');

const info24 = { fpsNum: 24, fpsDen: 1, fps: 24 };
const info2398 = { fpsNum: 24000, fpsDen: 1001, fps: 24000 / 1001 };

test('ratio: multipliers and target fps', () => {
  assert.deepStrictEqual(ratio(info24, { mode: 'multiplier', value: 2 }), { p: 2, q: 1, outFpsExpr: '48/1', outFps: 48 });
  const r = ratio(info24, { mode: 'fps', value: 60 });
  assert.strictEqual(r.p / r.q, 2.5); assert.strictEqual(r.q, 2);
  const r2 = ratio(info2398, { mode: 'fps', value: 60 });
  assert.strictEqual(r2.p, 1001); assert.strictEqual(r2.q, 400);
});

// The global timeline: output k sits at input position k*q/p. Every chunked plan must reproduce it.
function globalPositions(count, p, q, chunkIn) {
  const { total, chunks } = planChunks(count, p, q, chunkIn);
  const pos = [];
  for (const c of chunks) {
    assert.strictEqual(c.outOffset, pos.length, 'chunks must be contiguous');
    for (let i = 0; i < c.keep; i++) { const m = rifeMap(i, c.files, c.n); pos.push(c.a + m.sx + m.t); }
  }
  assert.strictEqual(pos.length, total);
  return pos;
}

for (const [count, p, q, chunk] of [[1000, 2, 1, 100], [1007, 3, 1, 64], [999, 5, 2, 120], [2400, 1001, 400, 450], [50, 2, 1, 600], [301, 4, 1, 100]]) {
  test(`planChunks keeps the timeline exact: ${count} frames, x${p}/${q}, chunk ${chunk}`, () => {
    const pos = globalPositions(count, p, q, chunk);
    const { chunks } = planChunks(count, p, q, chunk);
    const lastStart = chunks[chunks.length - 1].outOffset;
    for (let k = 0; k < pos.length; k++) {
      const exact = k * q / p;
      if (k < lastStart) assert.ok(Math.abs(pos[k] - exact) < 1e-3, `frame ${k}: ${pos[k]} vs exact ${exact}`);
      else if (pos[k] < count - 1) assert.ok(Math.abs(pos[k] - exact) < 0.5, `tail frame ${k}: ${pos[k]} vs exact ${exact}`);
      else assert.ok(exact > count - 2, `only the very end may be held on the last frame (${k})`);
    }
    for (let k = 1; k < pos.length; k++) assert.ok(pos[k] >= pos[k - 1], 'monotonic');
  });
}

test('planChunks: non-final chunks never interpolate past their own files', () => {
  const { chunks } = planChunks(5000, 5, 2, 200);
  for (const c of chunks.slice(0, -1)) for (let i = 0; i < c.keep; i++) assert.ok(rifeMap(i, c.files, c.n).sx < c.files - 1);
});

test('cutFixes replaces only frames between the two sides of a cut', () => {
  const ch = { a: 0, files: 10, n: 20, keep: 20 };
  const fixes = cutFixes(ch, new Set([5])); // cut between input 4 and 5
  assert.deepStrictEqual(fixes, [{ i: 9, src: 5 }]); // output 9 is t=0.5 between 4 and 5
  const ch3 = { a: 0, files: 10, n: 30, keep: 30 };
  assert.deepStrictEqual(cutFixes(ch3, new Set([5])).map((f) => f.i), [13, 14]);
  assert.deepStrictEqual(cutFixes(ch3, new Set([5])).map((f) => f.src), [4, 5]);
});

function png(w) {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(w + 1))), chunk('IEND', Buffer.alloc(0))]);
}

test('PngSplitter splits a stream into whole images however it is chunked', () => {
  const imgs = [png(3), png(50), png(7)];
  const all = Buffer.concat(imgs);
  for (const step of [1, 5, 33, all.length]) {
    const got = [];
    const s = new PngSplitter((b) => got.push(Buffer.from(b)));
    for (let i = 0; i < all.length; i += step) s.push(all.subarray(i, i + step));
    assert.deepStrictEqual(got.map((b) => b.length), imgs.map((b) => b.length));
    assert.ok(got.every((b, i) => b.equals(imgs[i])));
  }
});

test('colourOf picks the right matrix', () => {
  assert.strictEqual(colourOf({ height: 1080 }).matrix, 'bt709');
  assert.strictEqual(colourOf({ height: 480 }).matrix, 'bt601');
  assert.strictEqual(colourOf({ height: 2160, color_space: 'bt2020nc', color_transfer: 'smpte2084' }).hdr, true);
});

test('parseVulkanDevices reads ncnn device lines', () => {
  const err = '[0 NVIDIA GeForce RTX 4050 Laptop GPU]  queueC=2[8]  queueG=0[16]  queueT=1[2]\n[0 NVIDIA GeForce RTX 4050 Laptop GPU]  bugsbn1=0\n[1 Intel(R) UHD Graphics]  queueC=1[1]\n';
  const d = parseVulkanDevices(err);
  assert.strictEqual(d.length, 2);
  assert.strictEqual(d[0].vendor, 'nvidia'); assert.strictEqual(d[0].integrated, false);
  assert.strictEqual(d[1].vendor, 'intel'); assert.strictEqual(d[1].integrated, true);
  assert.strictEqual(vendorOf('AMD Radeon RX 7800 XT'), 'amd');
});
