'use strict';
// Real-engine smoke test: setup (with GPU self-test) and real RIFE jobs on a generated clip.
// Usage: node test/gpu-smoke.js [workdir]   (default out/smoke; downloads ~72 MB on first run)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const setup = require('../src/lib/setup');
const pipeline = require('../src/lib/pipeline');

const work = path.resolve(process.argv[2] || path.join(__dirname, '..', 'out', 'smoke'));
fs.mkdirSync(work, { recursive: true });

(async () => {
  console.log('== setup');
  const r = await setup.runChecks({ baseDir: work, install: true, emit: (it) => { if (!['checking', 'installing'].includes(it.state)) console.log(`  ${it.id.padEnd(8)} ${it.state.padEnd(5)} ${it.detail}`); } });
  if (!r.ok) { console.log('setup failed'); process.exit(1); }
  const cfg = r.cfg;
  console.log('  devices:', (cfg.devices || []).map((d) => `[${d.id}] ${d.name} ${d.ok ? d.ms + ' ms' : 'FAILED'}`).join('; ') || 'none');

  const clip = path.join(work, 'clip.mp4');
  if (!fs.existsSync(clip)) {
    // 8 s of 1080p moving content at 24 fps with a hard cut at 4 s, plus audio.
    execFileSync(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:duration=4', '-f', 'lavfi', '-i', 'mandelbrot=size=1920x1080:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-filter_complex', '[1:v]trim=duration=4,setpts=PTS-STARTPTS,format=yuv420p[b];[0:v]format=yuv420p[a];[a][b]concat=n=2:v=1[v]',
      '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-crf', '16', '-c:a', 'aac', '-shortest', clip]);
  }
  const info = await pipeline.probe(cfg, clip);
  const runs = [
    { model: 'rife-v4.26', target: { mode: 'multiplier', value: 2 } },
    { model: 'rife-v4.26', target: { mode: 'fps', value: 60 } },
    { model: 'rife-v4.22-lite', target: { mode: 'multiplier', value: 2 } },
    { model: 'rife-v4.25-heavy', target: { mode: 'multiplier', value: 2 } },
  ];
  let failed = 0;
  for (const j of runs) {
    const tag = `${j.model}-${j.target.mode === 'fps' ? j.target.value + 'fps' : j.target.value + 'x'}`;
    const output = path.join(work, `out-${tag}.mp4`);
    const t = Date.now();
    let note = '';
    const res = await pipeline.start(cfg, { info, target: j.target, model: j.model, encoder: cfg.encoders[0], quality: 18, keepAudio: true, output, tempRoot: work },
      (e) => { if (e.note) note = e.note; }).promise;
    if (!res.ok) { failed++; console.log(`FAIL ${tag}: ${res.error}`); continue; }
    const o = await pipeline.probe(cfg, output);
    const s = (Date.now() - t) / 1000;
    console.log(`ok   ${tag}: ${o.fps.toFixed(2)} fps, ${o.frames} frames, ${s.toFixed(1)} s (${(o.frames / s).toFixed(1)} out-fps), ${cfg.encoders[0]}${note ? ' — ' + note : ''}`);
  }
  console.log(`\nOutputs in ${work}. Watch them; check the cut at 4 s has no ghosting.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
