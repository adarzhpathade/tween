'use strict';
// Frame-interpolation pipeline:
//   1. analyse   ffmpeg decodes once at low resolution to count frames and find scene cuts
//   2. stream    ffmpeg decodes to lossless PNG through a pipe, in chunks (bounded disk use)
//   3. rife      RIFE (ncnn/Vulkan) makes the in-between frames for each chunk
//   4. fix cuts  frames that would blend two different shots are replaced with real frames
//   5. encode    one ffmpeg encoder receives every frame through a pipe, plus the source audio
// Works with NVIDIA, AMD, Intel and Apple GPUs (Vulkan), and falls back to CPU if a GPU fails.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MODELS, rifeExe } = require('./setup');

// ---------- small helpers ----------

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; };

function parseRate(s) {
  const [n, d] = String(s || '0/1').split('/').map(Number);
  return { num: n || 0, den: d || 1, value: (n || 0) / (d || 1) };
}

// ---------- colour ----------

const MATRIX = { bt709: 'bt709', smpte170m: 'bt601', bt470bg: 'bt601', bt2020nc: 'bt2020', bt2020c: 'bt2020', smpte240m: 'smpte240m', fcc: 'fcc' };
const TAG = { bt709: 'bt709', bt601: 'smpte170m', bt2020: 'bt2020nc', smpte240m: 'smpte240m', fcc: 'fcc' };

// Pick the YUV<->RGB matrix. Wrong matrices are the usual cause of a colour shift after interpolation.
function colourOf(v) {
  const matrix = MATRIX[v.color_space] || (v.height >= 720 ? 'bt709' : 'bt601');
  const def = matrix === 'bt709' ? 'bt709' : matrix === 'bt2020' ? 'bt2020' : 'smpte170m';
  return {
    matrix,
    range: v.color_range === 'pc' ? 'pc' : 'tv',
    space: TAG[matrix],
    primaries: v.color_primaries && v.color_primaries !== 'unknown' ? v.color_primaries : def,
    trc: v.color_transfer && v.color_transfer !== 'unknown' ? v.color_transfer : (def === 'bt2020' ? 'bt709' : def),
    hdr: /smpte2084|arib-std-b67/.test(v.color_transfer || ''),
  };
}

// ---------- encoders ----------
// q is a CRF-like number: lower is better. 16 is near-lossless, 18 is the default, 24 is small files.
const ENCODERS = {
  hevc_nvenc: { name: 'H.265 · NVIDIA', fmt: 'yuv420p', args: (q) => ['-c:v', 'hevc_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0', '-spatial-aq', '1', '-temporal-aq', '1', '-tag:v', 'hvc1'] },
  h264_nvenc: { name: 'H.264 · NVIDIA', fmt: 'yuv420p', args: (q) => ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0', '-spatial-aq', '1', '-temporal-aq', '1'] },
  hevc_amf: { name: 'H.265 · AMD', fmt: 'yuv420p', args: (q) => ['-c:v', 'hevc_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q + 2), '-tag:v', 'hvc1'] },
  h264_amf: { name: 'H.264 · AMD', fmt: 'yuv420p', args: (q) => ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q + 2), '-qp_b', String(q + 4)] },
  hevc_qsv: { name: 'H.265 · Intel', fmt: 'nv12', args: (q) => ['-c:v', 'hevc_qsv', '-preset', 'slower', '-global_quality', String(q), '-tag:v', 'hvc1'] },
  h264_qsv: { name: 'H.264 · Intel', fmt: 'nv12', args: (q) => ['-c:v', 'h264_qsv', '-preset', 'slower', '-global_quality', String(q)] },
  hevc_videotoolbox: { name: 'H.265 · Apple', fmt: 'nv12', args: (q) => ['-c:v', 'hevc_videotoolbox', '-q:v', String(Math.max(1, Math.min(100, 100 - (q - 10) * 3))), '-tag:v', 'hvc1'] },
  h264_videotoolbox: { name: 'H.264 · Apple', fmt: 'nv12', args: (q) => ['-c:v', 'h264_videotoolbox', '-q:v', String(Math.max(1, Math.min(100, 100 - (q - 10) * 3)))] },
  libx265: { name: 'H.265 · CPU', fmt: 'yuv420p', args: (q) => ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(q + 2), '-tag:v', 'hvc1'] },
  libx264: { name: 'H.264 · CPU', fmt: 'yuv420p', args: (q) => ['-c:v', 'libx264', '-preset', 'slow', '-crf', String(q)] },
};

// ---------- probe ----------

async function probe(cfg, file) {
  const { stdout } = await run(cfg.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!v) throw new Error('No video stream found in this file.');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const rate = parseRate(v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate);
  const duration = parseFloat(v.duration || j.format?.duration || 0);
  const rot = Math.abs(Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation || 0)) % 180 === 90;
  return {
    file, name: path.basename(file),
    width: rot ? v.height : v.width, height: rot ? v.width : v.height, codec: v.codec_name, pixFmt: v.pix_fmt,
    fpsNum: rate.num, fpsDen: rate.den, fps: rate.value,
    vfr: v.avg_frame_rate !== v.r_frame_rate,
    duration, frames: parseInt(v.nb_frames, 10) || Math.round(duration * rate.value),
    hasAudio: !!a, audioCodec: a?.codec_name || null,
    colour: colourOf(v),
    size: parseInt(j.format?.size, 10) || 0,
  };
}

// ---------- planning (pure, unit-tested) ----------

/** Output/input frame ratio as a reduced fraction p/q, and the output frame rate. */
function ratio(info, target) {
  if (target.mode === 'multiplier') {
    const m = Math.round(target.value);
    return { p: m, q: 1, outFpsExpr: `${info.fpsNum * m}/${info.fpsDen}`, outFps: info.fps * m };
  }
  // target fps F (integer or x/1001 style). r = F / (num/den) = F*den/num
  const fr = parseRate(String(target.value).includes('/') ? target.value : `${Math.round(target.value * 1000)}/1000`);
  let p = fr.num * info.fpsDen, q = fr.den * info.fpsNum;
  const g = gcd(p, q); p /= g; q /= g;
  return { p, q, outFpsExpr: `${fr.num}/${fr.den}`, outFps: fr.value };
}

/**
 * Split `count` input frames into chunks RIFE can run one at a time without drifting the timeline.
 * Each non-final chunk uses files [a, a+qk+q-1] with n=(k+1)p and keeps the first k*p outputs;
 * the next chunk starts at a+qk. Because a is always a multiple of q, the output offset a*p/q is exact.
 */
function planChunks(count, p, q, chunkInFrames) {
  const total = Math.round(count * p / q);
  if (q > 1000 || count <= chunkInFrames + q) return { total, chunks: [{ a: 0, files: count, n: total, keep: total, outOffset: 0 }] };
  const k = Math.max(1, Math.floor(chunkInFrames / q));
  const chunks = [];
  let a = 0;
  while (count - a > q * k + q) {
    chunks.push({ a, files: q * k + q, n: (k + 1) * p, keep: k * p, outOffset: (a / q) * p });
    a += q * k;
  }
  const outOffset = (a / q) * p;
  chunks.push({ a, files: count - a, n: total - outOffset, keep: total - outOffset, outOffset });
  return { total, chunks };
}

/** Same arithmetic as rife-ncnn-vulkan's directory mode: which pair, and how far between them. */
function rifeMap(i, files, n) {
  const scale = files / n;          // double in C++
  let fx = Math.fround(i * scale);  // stored as float
  let sx = Math.floor(fx);
  fx = Math.fround(fx - sx);
  if (sx < 0) { sx = 0; fx = 0; }
  if (sx >= files - 1) { sx = files - 2; fx = 1; }
  return { sx, t: fx };
}

/** Outputs that would blend across a scene cut. Returns [{ i, src }] with local indices. */
function cutFixes(chunk, cuts) {
  const fixes = [];
  if (!cuts.size) return fixes;
  for (let i = 0; i < chunk.keep; i++) {
    const { sx, t } = rifeMap(i, chunk.files, chunk.n);
    if (t > 0 && t < 1 && cuts.has(chunk.a + sx + 1)) fixes.push({ i, src: t < 0.5 ? sx : sx + 1 });
  }
  return fixes;
}

/** Input frames per chunk: aim for about 1.2 GB of temporary PNGs. */
function chunkSize(info, p, q) {
  const perFrame = info.width * info.height * 1.6; // typical PNG size in bytes
  return Math.max(24, Math.min(600, Math.round(1.2e9 / (perFrame * (1 + p / q)))));
}

// ---------- PNG stream splitter ----------

class PngSplitter {
  constructor(onImage) { this.buf = Buffer.alloc(0); this.onImage = onImage; }
  push(data) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    for (;;) {
      if (this.buf.length < 8) return;
      let p = 8, end = -1;
      while (p + 8 <= this.buf.length) {
        const len = this.buf.readUInt32BE(p);
        const type = this.buf.toString('latin1', p + 4, p + 8);
        p += 12 + len;
        if (type === 'IEND') { end = p; break; }
      }
      if (end < 0 || end > this.buf.length) return;
      this.onImage(this.buf.subarray(0, end));
      this.buf = this.buf.subarray(end);
    }
  }
}

// ---------- process helpers ----------

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGKILL');
}

const name8 = (i) => String(i + 1).padStart(8, '0') + '.png';

function linkOrCopy(src, dst) {
  try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
}

// ---------- the job ----------

/**
 * cfg: saved setup config ({ ffmpeg, ffprobe, rifeDir, mode, gpu, encoders })
 * job: { info, target:{mode,value}, model, encoder, quality, keepAudio, output, tempRoot,
 *        trim?:{start,end}, sceneDetect?:true, sceneThreshold?:10, tta?:false }
 * emit(evt): { stage:'analyse'|'interpolate'|'encode'|'done', pct, done, total, speed, eta, preview, note }
 */
function start(cfg, job, emit) {
  const state = { cancelled: false, children: new Set() };
  const tmp = fs.mkdtempSync(path.join(job.tempRoot || os.tmpdir(), 'tween-'));
  const { info } = job;
  const r = ratio(info, job.target);
  const model = MODELS.find((m) => m.id === job.model && (cfg.models || []).includes(m.id))
    || MODELS.find((m) => (cfg.models || []).includes(m.id)) || MODELS[0];
  const encId = (cfg.encoders || []).includes(job.encoder) ? job.encoder : (cfg.encoders || ['libx264'])[0];
  const enc = ENCODERS[encId] || ENCODERS.libx264;
  const col = info.colour || colourOf({ height: info.height });
  const trimArgs = job.trim ? ['-ss', String(job.trim.start), '-to', String(job.trim.end)] : [];
  const scaleIn = `scale=in_color_matrix=${col.matrix}:in_range=${col.range}:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24`;

  const track = (c) => { state.children.add(c); c.on('close', () => state.children.delete(c)); return c; };
  const wait = (c, label) => new Promise((resolve, reject) => {
    let err = '';
    c.stderr?.on('data', (d) => { err = (err + d.toString()).slice(-6000); });
    c.on('error', reject);
    c.on('close', (code) => {
      if (state.cancelled) return reject(new Error('cancelled'));
      code === 0 ? resolve(err) : reject(new Error(`${label} failed (exit ${code}).\n${err.trim().split('\n').slice(-6).join('\n')}`));
    });
  });

  const promise = (async () => {
    const t0 = Date.now();
    let extractor = null, encoder = null;
    try {
      // ---- 1. analyse: exact frame count + scene cuts, from a fast low-res decode
      emit({ stage: 'analyse', pct: 0 });
      const cuts = new Set();
      const scenesFile = 'scenes.txt';
      const thr = job.sceneThreshold ?? 10;
      const vf = job.sceneDetect === false ? 'scale=-2:144' : `scale=-2:270,scdet=threshold=${thr},metadata=mode=print:key=lavfi.scd.time:file=${scenesFile}`;
      let count = 0;
      const an = track(spawn(cfg.ffmpeg, ['-v', 'error', ...trimArgs, '-i', info.file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-an', '-sn',
        '-vf', vf, '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'], { cwd: tmp, windowsHide: true }));
      an.stdout.on('data', (d) => {
        const all = [...d.toString().matchAll(/^frame=(\d+)/gm)];
        const m = all[all.length - 1];
        if (m) { count = +m[1]; emit({ stage: 'analyse', pct: Math.min(1, count / Math.max(1, info.frames)) }); }
      });
      await wait(an, 'Analysis');
      try {
        for (const m of fs.readFileSync(path.join(tmp, scenesFile), 'utf8').matchAll(/^frame:(\d+)/gm)) cuts.add(+m[1]);
      } catch { /* no cuts */ }
      if (count < 2) throw new Error('The video has fewer than two frames.');

      const plan = planChunks(count, r.p, r.q, job.chunkFrames || chunkSize(info, r.p, r.q));
      const total = plan.total;

      // ---- 2. streaming extractor with back-pressure
      const pool = path.join(tmp, 'pool');
      fs.mkdirSync(pool);
      extractor = (() => {
        let written = 0, ended = false, failed = null, released = 0;
        const waiters = [];
        const maxAhead = Math.max(...plan.chunks.map((c) => c.files)) * 2 + 4;
        const proc = track(spawn(cfg.ffmpeg, ['-v', 'error', ...trimArgs, '-i', info.file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-an', '-sn',
          '-vf', scaleIn, '-f', 'image2pipe', '-c:v', 'png', '-compression_level', '2', '-'], { windowsHide: true }));
        const split = new PngSplitter((img) => {
          fs.writeFileSync(path.join(pool, name8(written)), img);
          written++;
          if (written - released > maxAhead) proc.stdout.pause();
          for (let w = waiters.length - 1; w >= 0; w--) if (written > waiters[w].idx) { waiters[w].res(); waiters.splice(w, 1); }
        });
        proc.stdout.on('data', (d) => split.push(d));
        const closed = wait(proc, 'Frame extraction').then(() => { ended = true; }, (e) => { failed = e; ended = true; })
          .finally(() => { for (const w of waiters.splice(0)) w.res(); });
        return {
          proc,
          closed,
          until: (idx) => new Promise((res, rej) => {
            const check = () => (written > idx ? res() : failed ? rej(failed) : ended ? res() : null);
            if (check() === null) waiters.push({ idx, res: () => (failed ? rej(failed) : res()) });
          }),
          get written() { return written; },
          release: (upTo) => {
            for (let i = released; i < upTo; i++) { try { fs.unlinkSync(path.join(pool, name8(i))); } catch { /* ignore */ } }
            released = Math.max(released, upTo);
            if (written - released <= maxAhead) proc.stdout.resume();
          },
        };
      })();

      // ---- 5. encoder (started now, fed as chunks finish)
      const ffArgs = ['-y', '-v', 'error', '-f', 'image2pipe', '-c:v', 'png', '-framerate', r.outFpsExpr, '-i', '-'];
      const audio = job.keepAudio !== false && info.hasAudio;
      ffArgs.push(...trimArgs, '-i', info.file, '-map', '0:v:0');
      if (audio) {
        const copyable = !job.trim && /\.(mp4|mov|m4v)$/i.test(job.output) && ['aac', 'mp3', 'ac3', 'eac3', 'alac', 'opus', 'flac'].includes(info.audioCodec);
        ffArgs.push('-map', '1:a:0?', ...(copyable ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k']));
      }
      ffArgs.push('-map_metadata', '1', '-map_chapters', '-1',
        '-vf', `scale=out_color_matrix=${col.matrix}:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=${enc.fmt}`,
        ...enc.args(job.quality ?? 18),
        '-colorspace', col.space, '-color_primaries', col.primaries, '-color_trc', col.trc, '-color_range', 'tv',
        // Length comes from the video; audio is cut to match, never the other way round.
        '-fps_mode', 'cfr', '-t', (total / r.outFps).toFixed(6));
      if (/\.(mp4|mov|m4v)$/i.test(job.output)) ffArgs.push('-movflags', '+faststart');
      ffArgs.push(job.output);
      encoder = track(spawn(cfg.ffmpeg, ffArgs, { windowsHide: true }));
      const encDone = wait(encoder, 'Encoding');
      encDone.catch(() => {});
      let encoded = 0;
      const feed = async (file) => {
        const data = fs.readFileSync(file);
        if (!encoder.stdin.write(data)) {
          await new Promise((res, rej) => {
            const onErr = (e) => rej(e);
            encoder.stdin.once('drain', () => { encoder.stdin.off('error', onErr); res(); });
            encoder.stdin.once('error', onErr);
          });
        }
        encoded++;
      };

      // ---- 3/4. chunks through RIFE
      const gpuArg = cfg.mode === 'gpu' && cfg.gpu ? String(cfg.gpu.id) : '-1';
      const light = cfg.mode !== 'gpu' || cfg.gpu?.integrated;
      const tI = Date.now();
      let feeding = Promise.resolve();
      let gpu = gpuArg;

      for (let ci = 0; ci < plan.chunks.length; ci++) {
        const ch = plan.chunks[ci];
        if (state.cancelled) throw new Error('cancelled');
        await extractor.until(ch.a + ch.files - 1);
        const cin = path.join(tmp, `c${ci}-in`), cout = path.join(tmp, `c${ci}-out`);
        fs.mkdirSync(cin); fs.mkdirSync(cout);
        const have = Math.min(ch.files, extractor.written - ch.a);
        for (let i = 0; i < have; i++) linkOrCopy(path.join(pool, name8(ch.a + i)), path.join(cin, name8(i)));
        // If the real frame count came out lower than the analysis said, shrink this chunk.
        const files = have, n = files === ch.files ? ch.n : Math.max(files, Math.round(files * r.p / r.q));
        const keep = files === ch.files ? ch.keep : n;

        const runRife = async (g, jobs) => {
          const args = ['-i', cin, '-o', cout, '-m', path.join(cfg.rifeDir, model.id), '-n', String(n), '-f', '%08d.png', '-g', g, '-j', jobs];
          if (info.width * info.height > 2560 * 1440) args.push('-u');
          if (job.tta) args.push('-x');
          // cfg.rifeCmd is for tests only: a stand-in engine with the same command line.
          const [cmd, ...pre] = cfg.rifeCmd || [rifeExe(cfg.rifeDir)];
          const c = track(spawn(cmd, [...pre, ...args], { cwd: cfg.rifeDir, windowsHide: true }));
          const timer = setInterval(() => {
            let d = 0; try { d = fs.readdirSync(cout).length; } catch { /* ignore */ }
            const done = Math.min(total, ch.outOffset + Math.min(d, keep));
            const el = (Date.now() - tI) / 1000, speed = done / Math.max(el, 0.001);
            emit({ stage: 'interpolate', pct: done / total, done, total, speed, eta: speed > 0 ? (total - done) / speed : null,
              preview: d > 2 ? path.join(cout, name8(Math.min(d, keep) - 3)) : null });
          }, 700);
          try { await wait(c, 'Interpolation'); } finally { clearInterval(timer); }
        };
        try { await runRife(gpu, light ? '1:1:1' : '2:2:2'); }
        catch (e) {
          if (state.cancelled) throw e;
          fs.rmSync(cout, { recursive: true, force: true }); fs.mkdirSync(cout);
          try { await runRife(gpu, '1:1:1'); }
          catch (e2) {
            if (state.cancelled || gpu === '-1') throw e2;
            gpu = '-1';
            emit({ stage: 'interpolate', note: 'The GPU failed on this video, so Tween switched to the CPU. This will be slower.' });
            fs.rmSync(cout, { recursive: true, force: true }); fs.mkdirSync(cout);
            await runRife(gpu, '1:1:1');
          }
        }

        // replace frames that would blend across a scene cut
        for (const f of cutFixes({ ...ch, files, n, keep }, cuts)) fs.copyFileSync(path.join(cin, name8(f.src)), path.join(cout, name8(f.i)));

        // hand this chunk to the encoder while the next one interpolates
        const prev = feeding;
        feeding = (async () => {
          await prev;
          for (let i = 0; i < keep; i++) {
            const f = path.join(cout, name8(i));
            if (!fs.existsSync(f)) throw new Error(`Interpolation skipped frame ${ch.outOffset + i + 1}.`);
            await feed(f);
          }
          fs.rmSync(cin, { recursive: true, force: true });
          fs.rmSync(cout, { recursive: true, force: true });
        })();
        feeding.catch(() => {});
        const next = plan.chunks[ci + 1];
        extractor.release(next ? next.a : count);
      }

      await feeding;
      emit({ stage: 'encode', pct: 0.99, done: encoded, total });
      encoder.stdin.end();
      await encDone;
      await extractor.closed;

      const outSize = fs.existsSync(job.output) ? fs.statSync(job.output).size : 0;
      emit({ stage: 'done', output: job.output, seconds: (Date.now() - t0) / 1000, outSize, frames: encoded, cuts: cuts.size });
      return { ok: true };
    } catch (e) {
      for (const c of state.children) killTree(c);
      if (state.cancelled) { try { fs.rmSync(job.output, { force: true }); } catch { /* ignore */ } return { ok: false, cancelled: true }; }
      return { ok: false, error: e.message };
    } finally {
      for (const c of state.children) killTree(c);
      setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* retry next launch */ } }, 500);
    }
  })();

  return { promise, cancel: () => { state.cancelled = true; for (const c of state.children) killTree(c); }, ratio: r };
}

/** Delete temp folders left by a crash. */
function cleanTemp(root = os.tmpdir()) {
  try {
    for (const n of fs.readdirSync(root)) if (/^tween-(?!selftest)/.test(n)) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  } catch { /* ignore */ }
}

module.exports = { probe, start, ratio, planChunks, rifeMap, cutFixes, chunkSize, colourOf, PngSplitter, ENCODERS, MODELS, cleanTemp };
