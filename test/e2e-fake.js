'use strict';
// End-to-end run of the pipeline with the stand-in engine. Needs ffmpeg/ffprobe on PATH.
// Usage: node test/e2e-fake.js <workdir>
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const pipeline = require('../src/lib/pipeline');

const work = path.resolve(process.argv[2] || 'out/e2e');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const clip = path.join(work, 'clip.mp4');
// 10 s at 24 fps with a hard cut at 5 s and a tone, so chunking, cuts and audio are all exercised.
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=5', '-f', 'lavfi', '-i', 'mandelbrot=size=640x360:rate=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-filter_complex',
  '[1:v]trim=duration=5,setpts=PTS-STARTPTS,format=yuv420p[b];[0:v]format=yuv420p[a];[a][b]concat=n=2:v=1[v]',
  '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', clip]);

const cfg = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', rifeDir: work, models: ['rife-v4.26'], mode: 'gpu', gpu: { id: 0, integrated: false }, encoders: ['libx264'],
  rifeCmd: [process.execPath, path.join(__dirname, 'fake-rife.js')] };

const cases = [
  { name: '2x', target: { mode: 'multiplier', value: 2 }, expectFps: 48 },
  { name: '60fps', target: { mode: 'fps', value: 60 }, expectFps: 60 },
  { name: 'trim-3x', target: { mode: 'multiplier', value: 3 }, expectFps: 72, trim: { start: 2, end: 7 } },
  { name: 'chunked-2x', target: { mode: 'multiplier', value: 2 }, expectFps: 48, chunkFrames: 37 },
  { name: 'chunked-60fps', target: { mode: 'fps', value: 60 }, expectFps: 60, chunkFrames: 40 },
  { name: 'gpu-fails-cpu-fallback', target: { mode: 'multiplier', value: 2 }, expectFps: 48, chunkFrames: 100, failGpu: true, expectNote: true },
];

(async () => {
  let failed = 0;
  for (const c of cases) {
    const info = await pipeline.probe(cfg, clip);
    const output = path.join(work, `out-${c.name}.mp4`);
    const t = Date.now();
    const stages = new Set();
    let note = null, cuts = null;
    if (c.failGpu) process.env.FAKE_RIFE_FAIL = '1'; else delete process.env.FAKE_RIFE_FAIL;
    const job = pipeline.start(cfg, { info, target: c.target, model: 'rife-v4.26', encoder: 'libx264', quality: 18, keepAudio: true, output, trim: c.trim, tempRoot: work, chunkFrames: c.chunkFrames },
      (e) => { stages.add(e.stage); if (e.note) note = e.note; if (e.stage === 'done') cuts = e.cuts; });
    const res = await job.promise;
    if (c.expectNote && !note) { console.log('FAIL', c.name, 'no CPU fallback note'); failed++; continue; }
    if (!c.trim && cuts !== 1) { console.log('FAIL', c.name, `expected 1 scene cut, got ${cuts}`); failed++; continue; }
    if (!res.ok) { console.log('FAIL', c.name, res.error); failed++; continue; }
    const o = await pipeline.probe(cfg, output);
    const dur = c.trim ? c.trim.end - c.trim.start : 10;
    const ok = Math.abs(o.fps - c.expectFps) < 0.01 && Math.abs(o.frames - dur * c.expectFps) <= 2 && o.hasAudio && Math.abs(o.duration - dur) < 0.15;
    if (!ok) failed++;
    console.log(ok ? 'PASS' : 'FAIL', c.name, `${o.fps} fps, ${o.frames} frames, ${o.duration.toFixed(2)} s, audio=${o.hasAudio}, stages=${[...stages].join('>')}, ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
  const left = fs.readdirSync(work).filter((n) => n.startsWith('tween-'));
  await new Promise((r) => setTimeout(r, 800));
  console.log('temp folders left:', fs.readdirSync(work).filter((n) => n.startsWith('tween-')).length, '(before cleanup:', left.length + ')');
  process.exit(failed ? 1 : 0);
})();
