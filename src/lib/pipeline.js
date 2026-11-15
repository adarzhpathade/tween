'use strict';
// Frame-interpolation pipeline: ffmpeg (decode) -> RIFE (ncnn/Vulkan) -> ffmpeg (encode).
// Same overall architecture VideoProc uses (flow-based "flownet"/RIFE-class model between
// an FFmpeg decode and encode), but built on the open-source MIT-licensed RIFE weights.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENGINE_DIR = path.join(__dirname, '..', '..', 'engine', 'rife');
const RIFE_EXE = path.join(ENGINE_DIR, 'rife-ncnn-vulkan.exe');
const FFMPEG = process.env.FLOW_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FLOW_FFPROBE || 'ffprobe';

// multiOK: model supports arbitrary target frame counts (needed for 3x/4x/custom fps).
const MODELS = [
  { id: 'rife-v4.6', name: 'Balanced', desc: 'Best all-round quality. Live action, games, screen capture.', multiOK: true },
  { id: 'rife-v4', name: 'Fast', desc: 'Older v4 model. Slightly softer, a bit quicker.', multiOK: true },
  { id: 'rife-anime', name: 'Animation', desc: 'Tuned for cartoons and anime. 2× only.', multiOK: false },
];

const ENCODERS = [
  { id: 'h264_nvenc', name: 'H.264 · NVIDIA', args: (q) => ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(q), '-b:v', '0'] },
  { id: 'hevc_nvenc', name: 'H.265 · NVIDIA', args: (q) => ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(q), '-b:v', '0', '-tag:v', 'hvc1'] },
  { id: 'libx264', name: 'H.264 · CPU', args: (q) => ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(q)] },
  { id: 'libx265', name: 'H.265 · CPU', args: (q) => ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(q), '-tag:v', 'hvc1'] },
];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

function parseRate(s) {
  const [n, d] = String(s || '0/1').split('/').map(Number);
  return { num: n || 0, den: d || 1, value: (n || 0) / (d || 1) };
}

async function capabilities() {
  const caps = { engine: fs.existsSync(RIFE_EXE), ffmpeg: false, encoders: [], gpu: null, models: MODELS };
  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-encoders']);
    caps.ffmpeg = true;
    caps.encoders = ENCODERS.filter((e) => stdout.includes(e.id)).map((e) => ({ id: e.id, name: e.name }));
  } catch { /* ffmpeg missing */ }
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
    caps.gpu = stdout.split('\n')[0].trim() || null;
  } catch { /* no NVIDIA GPU / driver */ }
  return caps;
}

async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!v) throw new Error('No video stream found in this file.');
  const rate = parseRate(v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate);
  const duration = parseFloat(v.duration || j.format?.duration || 0);
  const frames = parseInt(v.nb_frames, 10) || Math.round(duration * rate.value);
  return {
    file, name: path.basename(file),
    width: v.width, height: v.height, codec: v.codec_name,
    fpsNum: rate.num, fpsDen: rate.den, fps: rate.value,
    duration, frames,
    hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
    size: parseInt(j.format?.size, 10) || 0,
  };
}

// Work out output frame count + fps for a request.
function plan(info, target) {
  if (target.mode === 'multiplier') {
    return { outFrames: info.frames * target.value, outFpsExpr: `${info.fpsNum * target.value}/${info.fpsDen}`, outFps: info.fps * target.value };
  }
  const outFps = target.value;
  return { outFrames: Math.round(info.frames * outFps / info.fps), outFpsExpr: String(outFps), outFps };
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGKILL');
}

function countFiles(dir) {
  try { return fs.readdirSync(dir).length; } catch { return 0; }
}

function newestFile(dir) {
  try {
    const names = fs.readdirSync(dir);
    if (!names.length) return null;
    names.sort();
    return path.join(dir, names[names.length - 1 - Math.min(2, names.length - 1)]); // a few back: guaranteed fully written
  } catch { return null; }
}

/**
 * job: { info, target:{mode,value}, model, encoder, quality, keepAudio, output, tempRoot, lossless }
 * emit(evt): { stage:'extract'|'interpolate'|'encode'|'done', pct, ... }
 */
function start(job, emit) {
  const state = { cancelled: false, child: null };
  const ext = job.lossless ? 'png' : 'jpg';
  const tmp = fs.mkdtempSync(path.join(job.tempRoot || os.tmpdir(), 'flowmotion-'));
  const inDir = path.join(tmp, 'in');
  const outDir = path.join(tmp, 'out');
  fs.mkdirSync(inDir); fs.mkdirSync(outDir);

  const { info } = job;
  const p = plan(info, job.target);
  const model = MODELS.find((m) => m.id === job.model) || MODELS[0];
  const enc = ENCODERS.find((e) => e.id === job.encoder) || ENCODERS[2];

  const spawnTracked = (cmd, args, opts) => {
    const c = spawn(cmd, args, { windowsHide: true, ...opts });
    state.child = c;
    return c;
  };
  const wait = (c, label) => new Promise((resolve, reject) => {
    let err = '';
    c.stderr?.on('data', (d) => { err = (err + d.toString()).slice(-4000); });
    c.on('error', reject);
    c.on('close', (code) => {
      if (state.cancelled) return reject(new Error('cancelled'));
      code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code}).\n${err.trim().split('\n').slice(-6).join('\n')}`));
    });
  });

  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* retry on next launch */ } };

  const promise = (async () => {
    const t0 = Date.now();
    try {
      // 1 — extract
      emit({ stage: 'extract', pct: 0 });
      let c = spawnTracked(FFMPEG, ['-y', '-v', 'error', '-i', info.file, '-map', '0:v:0', '-fps_mode', 'passthrough',
        ...(job.lossless ? [] : ['-qscale:v', '2']), '-progress', 'pipe:1', '-nostats', path.join(inDir, `%08d.${ext}`)]);
      c.stdout.on('data', (d) => {
        const m = /frame=(\d+)/.exec(d.toString());
        if (m) emit({ stage: 'extract', pct: Math.min(1, +m[1] / Math.max(1, info.frames)) });
      });
      await wait(c, 'Frame extraction');
      const inCount = countFiles(inDir);
      if (!inCount) throw new Error('No frames were extracted from the video.');
      const outFrames = job.target.mode === 'multiplier' ? inCount * job.target.value : Math.round(inCount * p.outFps / info.fps);

      // 2 — interpolate
      emit({ stage: 'interpolate', pct: 0, done: 0, total: outFrames });
      const args = ['-i', inDir, '-o', outDir, '-m', path.join(ENGINE_DIR, model.id), '-f', `%08d.${ext}`, '-j', '2:3:3'];
      if (model.multiOK) args.push('-n', String(outFrames));
      if (info.height > 1440 || info.width > 2560) args.push('-u');
      c = spawnTracked(RIFE_EXE, args, { cwd: ENGINE_DIR });
      const startI = Date.now();
      const timer = setInterval(() => {
        const done = countFiles(outDir);
        const el = (Date.now() - startI) / 1000;
        const speed = done / Math.max(el, 0.001);
        emit({ stage: 'interpolate', pct: Math.min(1, done / outFrames), done, total: outFrames, speed, eta: speed > 0 ? (outFrames - done) / speed : null, preview: newestFile(outDir) });
      }, 700);
      try { await wait(c, 'Interpolation'); } finally { clearInterval(timer); }
      const made = countFiles(outDir);
      if (!made) throw new Error('The interpolation engine produced no frames. Check that your GPU supports Vulkan.');

      // 3 — encode (+ original audio)
      emit({ stage: 'encode', pct: 0 });
      const ffArgs = ['-y', '-v', 'error', '-framerate', p.outFpsExpr, '-i', path.join(outDir, `%08d.${ext}`)];
      const audio = job.keepAudio && info.hasAudio;
      if (audio) ffArgs.push('-i', info.file);
      ffArgs.push('-map', '0:v:0');
      if (audio) ffArgs.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-shortest');
      ffArgs.push(...enc.args(job.quality), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', job.output);
      c = spawnTracked(FFMPEG, ffArgs);
      c.stdout.on('data', (d) => {
        const m = /frame=(\d+)/.exec(d.toString());
        if (m) emit({ stage: 'encode', pct: Math.min(1, +m[1] / made) });
      });
      await wait(c, 'Encoding');

      const outSize = fs.existsSync(job.output) ? fs.statSync(job.output).size : 0;
      emit({ stage: 'done', output: job.output, seconds: (Date.now() - t0) / 1000, outSize, frames: made });
      return { ok: true };
    } catch (e) {
      if (state.cancelled) { try { fs.rmSync(job.output, { force: true }); } catch { /* ignore */ } return { ok: false, cancelled: true }; }
      return { ok: false, error: e.message };
    } finally { cleanup(); }
  })();

  return { promise, cancel: () => { state.cancelled = true; killTree(state.child); }, plan: p };
}

module.exports = { capabilities, probe, plan, start, MODELS, ENCODERS };
