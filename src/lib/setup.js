'use strict';
// First-run setup: find or install FFmpeg and the RIFE engine, check the GPU, pick
// the best encoder, and save the result so the pipeline knows what to use.
// Works on Windows, macOS and Linux, with NVIDIA, AMD, Intel or Apple GPUs (all through
// Vulkan / MoltenVK). With no usable GPU it falls back to CPU mode, which is slow but works.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const remotezip = require('./remotezip');

const PLAT = process.platform; // win32 | darwin | linux
const ARCH = process.arch;     // x64 | arm64
const EXE = PLAT === 'win32' ? '.exe' : '';

// Engine build that can load the newer RIFE 4.x models (MIT, github.com/TNTwise/rife-ncnn-vulkan).
const RIFE_TAG = '20250112';
const RIFE_ZIP = { win32: 'windows', linux: 'ubuntu', darwin: 'macos' }[PLAT];
const RIFE_URL = `https://github.com/TNTwise/rife-ncnn-vulkan/releases/download/${RIFE_TAG}/${RIFE_ZIP}.zip`;

// Models the app offers. All are RIFE 4.x, so all support any target frame rate.
const MODELS = [
  { id: 'rife-v4.26', name: 'Smooth', desc: 'Newest RIFE model. The best choice for most videos.', size: 11.4, default: true },
  { id: 'rife-v4.25-heavy', name: 'Detail', desc: 'Bigger model. Cleaner edges in fast motion, about 2 to 3 times slower.', size: 43.4 },
  { id: 'rife-v4.22-lite', name: 'Fast', desc: 'Light model for older or integrated GPUs.', size: 9.8 },
];

// FFmpeg builds that include NVENC, AMF and QSV encoders.
function ffmpegSource() {
  const B = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/';
  if (PLAT === 'win32') return { kind: 'zip', url: B + (ARCH === 'arm64' ? 'ffmpeg-master-latest-winarm64-gpl.zip' : 'ffmpeg-master-latest-win64-gpl.zip'), files: ['bin/ffmpeg.exe', 'bin/ffprobe.exe'] };
  if (PLAT === 'linux') return { kind: 'tarxz', url: B + (ARCH === 'arm64' ? 'ffmpeg-master-latest-linuxarm64-gpl.tar.xz' : 'ffmpeg-master-latest-linux64-gpl.tar.xz'), files: ['bin/ffmpeg', 'bin/ffprobe'] };
  const a = ARCH === 'arm64' ? 'arm64' : 'amd64';
  return { kind: 'zips', urls: ['ffmpeg', 'ffprobe'].map((n) => `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${a}/release/${n}.zip`), files: ['ffmpeg', 'ffprobe'] };
}

const DRIVER_LINKS = {
  nvidia: 'https://www.nvidia.com/Download/index.aspx',
  amd: 'https://www.amd.com/en/support/download/drivers.html',
  intel: 'https://www.intel.com/content/www/us/en/support/detect.html',
};

// Hardware encoders first, best first. CPU encoders always work as a fallback.
const ENCODER_ORDER = ['hevc_nvenc', 'h264_nvenc', 'hevc_amf', 'h264_amf', 'hevc_qsv', 'h264_qsv', 'hevc_videotoolbox', 'h264_videotoolbox', 'libx265', 'libx264'];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: opts.timeout || 60000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function paths(baseDir) {
  const engine = path.join(baseDir, 'engine');
  return {
    base: baseDir,
    config: path.join(baseDir, 'setup.json'),
    ffDir: path.join(engine, 'ffmpeg'),
    rifeDir: path.join(engine, 'rife'),
  };
}

function loadConfig(baseDir) {
  try { return JSON.parse(fs.readFileSync(paths(baseDir).config, 'utf8')); } catch { return null; }
}

function saveConfig(baseDir, cfg) {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(paths(baseDir).config, JSON.stringify(cfg, null, 2));
}

// ---------- detection ----------

async function osGpus() {
  // What the OS reports, before the engine is installed. Names only; Vulkan is checked later.
  try {
    if (PLAT === 'win32') {
      const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM | ConvertTo-Json -Compress']);
      let j = JSON.parse(r.stdout || '[]'); if (!Array.isArray(j)) j = [j];
      return j.filter((g) => g && g.Name && !/basic display|remote|virtual|parsec|meta/i.test(g.Name))
        .map((g) => ({ name: g.Name.trim(), driver: g.DriverVersion || null, vendor: vendorOf(g.Name) }));
    }
    if (PLAT === 'darwin') {
      const r = await run('system_profiler', ['SPDisplaysDataType', '-json']);
      const j = JSON.parse(r.stdout || '{}');
      return (j.SPDisplaysDataType || []).map((g) => ({ name: g.sppci_model || g._name, driver: null, vendor: vendorOf(g.sppci_model || g._name) }));
    }
    const r = await run('sh', ['-c', 'lspci 2>/dev/null | grep -Ei "vga|3d|display"']);
    return r.stdout.split('\n').filter(Boolean).map((l) => { const n = l.replace(/^.*?: /, ''); return { name: n, driver: null, vendor: vendorOf(n) }; });
  } catch { return []; }
}

function vendorOf(name = '') {
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(name)) return 'nvidia';
  if (/amd|radeon|ati /i.test(name)) return 'amd';
  if (/intel|arc|iris|uhd graphics/i.test(name)) return 'intel';
  if (/apple|m\d/i.test(name)) return 'apple';
  return 'other';
}

function vulkanLoaderPresent() {
  if (PLAT === 'win32') return fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'vulkan-1.dll'));
  if (PLAT === 'darwin') return true; // the macOS engine build carries MoltenVK
  return ['/usr/lib/x86_64-linux-gnu/libvulkan.so.1', '/usr/lib64/libvulkan.so.1', '/usr/lib/libvulkan.so.1', '/usr/lib/aarch64-linux-gnu/libvulkan.so.1'].some((p) => fs.existsSync(p));
}

async function findFfmpeg(p) {
  // Prefer our own copy, then whatever is on PATH.
  const own = { ffmpeg: path.join(p.ffDir, 'ffmpeg' + EXE), ffprobe: path.join(p.ffDir, 'ffprobe' + EXE) };
  for (const c of [own, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }]) {
    if (c === own && !(fs.existsSync(own.ffmpeg) && fs.existsSync(own.ffprobe))) continue;
    const a = await run(c.ffmpeg, ['-hide_banner', '-version']);
    const b = await run(c.ffprobe, ['-hide_banner', '-version']);
    if (a.ok && b.ok) {
      const m = /ffmpeg version (\S+)/.exec(a.stdout);
      // scdet (scene detection) is required for clean scene cuts.
      const f = await run(c.ffmpeg, ['-hide_banner', '-filters']);
      if (!/\bscdet\b/.test(f.stdout)) continue;
      return { ...c, version: m ? m[1] : 'unknown', bundled: c === own };
    }
  }
  return null;
}

function rifeExe(dir) { return path.join(dir, 'rife-ncnn-vulkan' + EXE); }

function installedModels(dir) {
  return MODELS.filter((m) => fs.existsSync(path.join(dir, m.id, 'flownet.bin')) && fs.existsSync(path.join(dir, m.id, 'flownet.param')));
}

// ---------- GPU self-test through the engine ----------

// ncnn prints one line per Vulkan device, e.g. "[0 NVIDIA GeForce RTX 4050 Laptop GPU]  queueC=2[8] ..."
function parseVulkanDevices(stderr) {
  const seen = new Map();
  for (const m of String(stderr).matchAll(/^\[(\d+) (.+?)\]\s+queueC=/gm)) seen.set(+m[1], m[2].trim());
  return [...seen].map(([id, name]) => ({ id, name, vendor: vendorOf(name), integrated: /intel|uhd|iris|vega \d|radeon\(tm\) graphics|llvmpipe|swiftshader/i.test(name) }));
}

async function makeTestFrames(ff, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, 'a.png'), b = path.join(dir, 'b.png');
  await run(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=1', '-frames:v', '1', a]);
  await run(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=1', '-vf', 'scroll=h=0.05', '-frames:v', '1', b]);
  return { a, b };
}

async function selfTest(rifeDir, ff, modelId, tmp) {
  const exe = rifeExe(rifeDir);
  const { a, b } = await makeTestFrames(ff, tmp);
  const out = path.join(tmp, 'c.png');
  const tryDev = async (g) => {
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
    const t = Date.now();
    const r = await run(exe, ['-0', a, '-1', b, '-o', out, '-m', path.join(rifeDir, modelId), '-g', String(g)], { cwd: rifeDir, timeout: 120000 });
    return { ok: r.ok && fs.existsSync(out), ms: Date.now() - t, stderr: r.stderr };
  };
  const first = await tryDev(0);
  const devices = parseVulkanDevices(first.stderr);
  const results = [];
  if (devices.length) {
    results.push({ ...devices[0], ok: first.ok, ms: first.ms });
    for (const d of devices.slice(1)) { const r = await tryDev(d.id); results.push({ ...d, ok: r.ok, ms: r.ms }); }
  }
  const usable = results.filter((d) => d.ok);
  // Prefer a dedicated GPU, then the fastest one.
  usable.sort((x, y) => (x.integrated - y.integrated) || (x.ms - y.ms));
  if (usable.length) return { mode: 'gpu', gpu: usable[0], devices: results };
  const cpu = await tryDev(-1);
  return { mode: cpu.ok ? 'cpu' : 'none', gpu: null, devices: results, error: cpu.ok ? null : (first.stderr || cpu.stderr).trim().split('\n').slice(-4).join('\n') };
}

async function probeEncoders(ff) {
  const list = await run(ff, ['-hide_banner', '-encoders']);
  const working = [];
  for (const id of ENCODER_ORDER) {
    if (!new RegExp(`\\b${id}\\b`).test(list.stdout)) continue;
    // Listing is not enough: hardware encoders are built in even when the hardware is absent.
    const r = await run(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=256x256:d=0.2', '-pix_fmt', 'yuv420p', '-c:v', id, '-f', 'null', '-'], { timeout: 30000 });
    if (r.ok) working.push(id);
  }
  return working;
}

// ---------- downloading ----------

async function downloadFile(url, dest, onBytes) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Download failed (HTTP ${r.status}) for ${url}`);
  const total = Number(r.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const f = fs.createWriteStream(dest + '.part');
  let got = 0;
  for await (const chunk of r.body) {
    got += chunk.length;
    if (!f.write(chunk)) await new Promise((res) => f.once('drain', res));
    onBytes?.(got, total);
  }
  await new Promise((res, rej) => f.end((e) => (e ? rej(e) : res())));
  fs.renameSync(dest + '.part', dest);
}

// Pull only the named files (by suffix after the zip's top folder) out of a remote zip.
async function fetchFromZip(url, wantRel, destDir, onBytes) {
  const z = await remotezip.open(url);
  if (!z) throw new Error('Server does not support partial downloads');
  const top = z.entries[0].name.split('/')[0];
  // Windows build is nested one level deeper (rife-ncnn-vulkan-refs/heads/master-windows/...).
  const ROOT = /(rife-ncnn-vulkan(\.exe)?|bin\/ff(mpeg|probe)(\.exe)?|^ff(mpeg|probe))$/;
  const root = z.entries.find((e) => ROOT.test(e.name) && !e.name.endsWith('/'));
  const prefix = root ? root.name.replace(ROOT, '') : top + '/';
  const picks = z.entries.filter((e) => !e.name.endsWith('/') && wantRel.some((w) => {
    const rel = e.name.slice(prefix.length);
    return e.name.startsWith(prefix) && (w.endsWith('/') ? rel.startsWith(w) : rel === w);
  }));
  const total = picks.reduce((s, e) => s + e.csize, 0);
  let done = 0;
  for (const e of picks) {
    await z.extract(e, path.join(destDir, e.name.slice(prefix.length).replace(/^bin\//, '')));
    done += e.csize; onBytes?.(done, total);
  }
  if (!picks.length) throw new Error('Expected files were not found in the archive');
}

async function installFfmpeg(p, onBytes) {
  const s = ffmpegSource();
  fs.mkdirSync(p.ffDir, { recursive: true });
  if (s.kind === 'zip') {
    await fetchFromZip(s.url, s.files, p.ffDir, onBytes);
  } else if (s.kind === 'zips') {
    for (let i = 0; i < s.urls.length; i++) await fetchFromZip(s.urls[i], [s.files[i]], p.ffDir, (g, t) => onBytes?.(g + i * t, t * 2));
  } else {
    const tarball = path.join(p.ffDir, 'ffmpeg.tar.xz');
    await downloadFile(s.url, tarball, onBytes);
    const r = await run('tar', ['-xJf', tarball, '-C', p.ffDir, '--strip-components=2', '--wildcards', '*/bin/ffmpeg', '*/bin/ffprobe'], { timeout: 300000 });
    fs.rmSync(tarball, { force: true });
    if (!r.ok) throw new Error('Could not unpack FFmpeg: ' + r.stderr.trim());
  }
  if (PLAT !== 'win32') for (const f of ['ffmpeg', 'ffprobe']) fs.chmodSync(path.join(p.ffDir, f), 0o755);
}

async function installRife(p, modelIds, onBytes) {
  const want = ['rife-ncnn-vulkan' + EXE, ...(PLAT === 'win32' ? ['vcomp140.dll'] : []), 'LICENSE', ...modelIds.map((m) => m + '/')];
  await fetchFromZip(RIFE_URL, want, p.rifeDir, onBytes);
  if (PLAT !== 'win32') fs.chmodSync(rifeExe(p.rifeDir), 0o755);
  if (PLAT === 'darwin') await run('xattr', ['-dr', 'com.apple.quarantine', p.rifeDir]);
}

// ---------- the whole check, as onboarding runs it ----------

/**
 * Runs every check and installs what is missing.
 * opts: { baseDir, devEngineDir?, install: boolean, models?: string[], emit(item) }
 * Each emitted item: { id, label, state: 'checking'|'ok'|'missing'|'installing'|'warn'|'error', detail, progress? }
 */
async function runChecks(opts) {
  const p = paths(opts.baseDir);
  const emit = (id, label, state, detail, extra = {}) => opts.emit?.({ id, label, state, detail, ...extra });
  const cfg = { platform: PLAT, arch: ARCH, checkedAt: new Date().toISOString() };

  // 1. System and disk
  emit('system', 'System', 'checking', '');
  const free = (() => { try { const s = fs.statfsSync(os.tmpdir()); return s.bavail * s.bsize; } catch { return null; } })();
  cfg.freeBytes = free;
  emit('system', 'System', free !== null && free < 4e9 ? 'warn' : 'ok',
    `${{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[PLAT]} ${ARCH} · ${os.cpus().length} threads · ${(os.totalmem() / 2 ** 30).toFixed(0)} GB RAM` +
    (free !== null ? ` · ${(free / 1e9).toFixed(0)} GB free` : ''));

  // 2. Graphics hardware and drivers
  emit('gpu', 'Graphics', 'checking', '');
  const gpus = await osGpus();
  cfg.osGpus = gpus;
  const vk = vulkanLoaderPresent();
  if (!vk) {
    const v = gpus.find((g) => DRIVER_LINKS[g.vendor]);
    emit('gpu', 'Graphics', 'warn', `No Vulkan driver found. Update your graphics driver${v ? ` (${v.name})` : ''}. Tween will use the CPU until then.`, { link: v ? DRIVER_LINKS[v.vendor] : null });
  } else emit('gpu', 'Graphics', 'ok', gpus.map((g) => g.name).join(' + ') || 'Vulkan driver present');

  // 3. FFmpeg
  emit('ffmpeg', 'FFmpeg', 'checking', '');
  let ff = await findFfmpeg(p);
  if (!ff && opts.install) {
    emit('ffmpeg', 'FFmpeg', 'installing', 'Downloading', { progress: 0 });
    try {
      await installFfmpeg(p, (g, t) => emit('ffmpeg', 'FFmpeg', 'installing', 'Downloading', { progress: t ? g / t : null }));
      ff = await findFfmpeg(p);
    } catch (e) { emit('ffmpeg', 'FFmpeg', 'error', e.message); }
  }
  if (!ff) { emit('ffmpeg', 'FFmpeg', opts.install ? 'error' : 'missing', 'Needed to read and write video'); return { ok: false, cfg }; }
  cfg.ffmpeg = ff.ffmpeg; cfg.ffprobe = ff.ffprobe;
  emit('ffmpeg', 'FFmpeg', 'ok', `${ff.version}${ff.bundled ? '' : ' (system)'}`);

  // 4. Engine and models
  emit('engine', 'Interpolation engine', 'checking', '');
  const wanted = opts.models || MODELS.map((m) => m.id);
  let dir = p.rifeDir;
  const devOk = opts.devEngineDir && fs.existsSync(rifeExe(opts.devEngineDir)) && installedModels(opts.devEngineDir).length;
  if (devOk && !fs.existsSync(rifeExe(p.rifeDir))) dir = opts.devEngineDir;
  const missing = wanted.filter((id) => !installedModels(dir).some((m) => m.id === id));
  if ((!fs.existsSync(rifeExe(dir)) || missing.length) && opts.install) {
    dir = p.rifeDir;
    emit('engine', 'Interpolation engine', 'installing', 'Downloading RIFE and models', { progress: 0 });
    try {
      await installRife(p, wanted.filter((id) => !installedModels(dir).some((m) => m.id === id)),
        (g, t) => emit('engine', 'Interpolation engine', 'installing', 'Downloading RIFE and models', { progress: t ? g / t : null }));
    } catch (e) { emit('engine', 'Interpolation engine', 'error', e.message); return { ok: false, cfg }; }
  }
  const models = installedModels(dir);
  if (!fs.existsSync(rifeExe(dir)) || !models.length) { emit('engine', 'Interpolation engine', 'missing', 'RIFE engine not installed'); return { ok: false, cfg }; }
  cfg.rifeDir = dir; cfg.models = models.map((m) => m.id);
  emit('engine', 'Interpolation engine', 'ok', `RIFE · ${models.map((m) => m.name).join(', ')}`);

  // 5. GPU self-test through the engine
  emit('accel', 'GPU acceleration', 'checking', 'Running a test frame');
  const st = opts.selfTest === false ? { mode: 'untested', gpu: null, devices: [] } : await selfTest(dir, ff.ffmpeg, (models.find((m) => m.default) || models[0]).id, path.join(os.tmpdir(), 'tween-selftest'));
  cfg.mode = st.mode; cfg.gpu = st.gpu; cfg.devices = st.devices;
  if (st.mode === 'gpu') emit('accel', 'GPU acceleration', 'ok', `${st.gpu.name} (Vulkan)`);
  else if (st.mode === 'untested') emit('accel', 'GPU acceleration', 'warn', 'Skipped');
  else if (st.mode === 'cpu') emit('accel', 'GPU acceleration', 'warn', 'No working GPU found. Tween will run on the CPU, which is much slower.');
  else { emit('accel', 'GPU acceleration', 'error', st.error || 'The engine could not run'); return { ok: false, cfg }; }

  // 6. Encoders
  emit('encoder', 'Video encoder', 'checking', '');
  cfg.encoders = await probeEncoders(ff.ffmpeg);
  const hw = cfg.encoders.filter((e) => !e.startsWith('lib'));
  emit('encoder', 'Video encoder', 'ok', hw.length ? `Hardware: ${hw.join(', ')}` : 'CPU (x264 / x265)');

  saveConfig(opts.baseDir, cfg);
  return { ok: true, cfg };
}

module.exports = { runChecks, loadConfig, saveConfig, paths, MODELS, ENCODER_ORDER, parseVulkanDevices, vendorOf, fetchFromZip, RIFE_URL, rifeExe, installedModels };
