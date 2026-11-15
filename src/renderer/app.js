'use strict';
const $ = (id) => document.getElementById(id);
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/').map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
const fmtTime = (s) => { if (s == null || !isFinite(s)) return '—'; s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtNum = (n) => Math.round(n).toLocaleString();

const S = { info: null, caps: null, target: { mode: 'multiplier', value: 2 }, model: 'rife-v4.6', output: null, startedAt: 0, timer: null, last: null };

function show(view) {
  for (const v of ['drop', 'loaded', 'working', 'result']) $(v).classList.toggle('hidden', v !== view);
  $('error').classList.add('hidden');
  $('panel').classList.toggle('locked', view === 'working');
}
function showError(msg) { const e = $('error'); e.textContent = msg; e.classList.remove('hidden'); }

/* ---------- capabilities ---------- */
async function init() {
  const b = $('gpuBadge');
  // Temporary first-run path until the v7 onboarding is ported: run setup and install what is missing.
  if (!(await window.flow.setupConfig())) {
    window.flow.onSetupProgress((it) => {
      const pct = it.progress != null ? ` ${Math.round(it.progress * 100)}%` : '';
      b.textContent = `Setup · ${it.label}: ${it.state}${pct}`; b.className = 'badge';
    });
    await window.flow.setupRun({ install: true });
  }
  S.caps = await window.flow.caps();
  if (S.caps.models.length && !S.caps.models.some((m) => m.id === S.model)) S.model = S.caps.models[0].id;
  if (!S.caps.engine) { b.textContent = 'Engine missing'; b.className = 'badge warn'; }
  else if (!S.caps.ffmpeg) { b.textContent = 'FFmpeg not found'; b.className = 'badge warn'; }
  else { b.textContent = S.caps.gpu ? `GPU · ${S.caps.gpu}` : 'Vulkan GPU'; b.className = 'badge ok'; }

  $('models').innerHTML = '';
  for (const m of S.caps.models) {
    const d = document.createElement('div');
    d.className = 'mcard' + (m.id === S.model ? ' on' : '');
    d.dataset.id = m.id;
    d.innerHTML = `<b>${m.name}</b><span>${m.desc}</span>`;
    d.onclick = () => { S.model = m.id; applyModelLimits(); refresh(); };
    $('models').appendChild(d);
  }
  const enc = $('encoder');
  for (const e of S.caps.encoders) enc.add(new Option(e.name, e.id));
  refresh();
}

function applyModelLimits() {
  const m = S.caps.models.find((x) => x.id === S.model);
  document.querySelectorAll('#models .mcard').forEach((c) => c.classList.toggle('on', c.dataset.id === S.model));
  document.querySelectorAll('#targetSeg button').forEach((b) => {
    const is2x = b.dataset.mode === 'multiplier' && b.dataset.v === '2';
    b.disabled = !m.multiOK && !is2x;
  });
  $('customFps').disabled = !m.multiOK;
  if (!m.multiOK) { S.target = { mode: 'multiplier', value: 2 }; syncSeg(); }
}

function syncSeg() {
  document.querySelectorAll('#targetSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.target.mode && +b.dataset.v === S.target.value));
}

document.querySelectorAll('#targetSeg button').forEach((b) => {
  b.onclick = () => { S.target = { mode: b.dataset.mode, value: +b.dataset.v }; $('customFps').value = ''; syncSeg(); refresh(); };
});
$('customFps').oninput = (e) => {
  const v = parseFloat(e.target.value);
  if (v > 0) { S.target = { mode: 'fps', value: v }; syncSeg(); }
  refresh();
};
$('quality').oninput = (e) => { $('qualityOut').textContent = e.target.value; };

/* ---------- summary + timeline ---------- */
function outFpsFor(info) { return S.target.mode === 'multiplier' ? info.fps * S.target.value : S.target.value; }

function refresh() {
  const info = S.info;
  $('start').disabled = !info || !S.caps?.engine || !S.caps?.ffmpeg;
  if (!info) { $('summary').textContent = 'Load a video to begin.'; return; }
  const outFps = outFpsFor(info);
  const outFrames = S.target.mode === 'multiplier' ? info.frames * S.target.value : Math.round(info.frames * outFps / info.fps);
  const warn = outFps <= info.fps ? '<br><span class="warn-text">Target must be higher than the source frame rate.</span>' : '';
  if (outFps <= info.fps) $('start').disabled = true;
  $('summary').innerHTML = `<b>${+info.fps.toFixed(3)} → ${+outFps.toFixed(3)} fps</b><br>${fmtNum(info.frames)} → ${fmtNum(outFrames)} frames${warn}`;
  drawTimeline(info.fps, outFps);
}

function drawTimeline(srcFps, outFps) {
  const el = $('timeline');
  const span = 12;                                  // visualise 12 output frames
  const ratio = outFps / srcFps;
  el.innerHTML = '';
  let nextSrc = 0;
  for (let i = 0; i < span; i++) {
    const t = i / ratio;                            // source-time of this output frame
    const isSrc = Math.abs(t - Math.round(t)) < 1e-6 && t >= nextSrc - 1e-6;
    const b = document.createElement('i');
    if (isSrc) { b.className = 'src'; nextSrc = Math.round(t) + 1; }
    el.appendChild(b);
  }
  $('framesNote').textContent = `${+ratio.toFixed(2)}× more frames per second`;
}

/* ---------- loading a video ---------- */
async function loadFile(path) {
  if (!path) return;
  const r = await window.flow.probe(path);
  if (!r.ok) { show(S.info ? 'loaded' : 'drop'); return showError('Could not read this file.\n' + r.error); }
  S.info = r.info;
  const i = r.info;
  $('meta').innerHTML = [
    ['', i.name], ['', `${i.width}×${i.height}`], ['', `${+i.fps.toFixed(2)} fps`],
    ['', fmtTime(i.duration)], ['', `${fmtNum(i.frames)} frames`], ['', i.codec.toUpperCase()],
  ].map(([, t]) => `<span class="chip"><b>${t}</b></span>`).join('');
  $('player').src = fileUrl(path);
  document.querySelector('.crumbs b').textContent = i.name;
  show('loaded');
  applyModelLimits();
  refresh();
}

$('browse').onclick = async () => loadFile(await window.flow.pickVideo());
const drop = $('drop');
['dragover', 'dragenter'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f && $('working').classList.contains('hidden')) loadFile(window.flow.pathForFile(f));
});

/* ---------- run ---------- */
$('start').onclick = async () => {
  const i = S.info;
  const base = i.file.replace(/\.[^.\\/]+$/, '');
  const suffix = S.target.mode === 'multiplier' ? `${S.target.value}x` : `${S.target.value}fps`;
  const output = await window.flow.pickOutput(`${base}_${suffix}.mp4`);
  if (!output) return;
  S.output = output;
  const res = await window.flow.start({
    info: i, target: S.target, model: S.model, encoder: $('encoder').value,
    quality: +$('quality').value, keepAudio: $('keepAudio').checked, lossless: $('lossless').checked, output,
  });
  if (!res.ok) return showError(res.error);
  S.startedAt = Date.now();
  $('livePreview').removeAttribute('src');
  $('liveHint').classList.remove('hidden');
  setStep('extract');
  setProgress(0);
  show('working');
  clearInterval(S.timer);
  S.timer = setInterval(() => { $('stElapsed').textContent = fmtTime((Date.now() - S.startedAt) / 1000); }, 500);
};

function setStep(stage) {
  const order = ['extract', 'interpolate', 'encode'];
  const idx = order.indexOf(stage);
  document.querySelectorAll('#steps .step').forEach((el) => {
    const k = order.indexOf(el.dataset.s);
    el.classList.toggle('active', k === idx);
    el.classList.toggle('done', k < idx);
  });
}
function setProgress(p, overall) {
  $('bigPct').textContent = Math.floor(p * 100) + '%';
  $('barFill').style.width = (p * 100) + '%';
  // sidebar shows overall job progress: extract 10% · interpolate 75% · encode 15%
  const o = overall ?? p;
  document.querySelector('.side-pct').textContent = Math.floor(o * 100) + '%';
  document.querySelector('.side-fill').style.width = (o * 100) + '%';
}
const STAGE_WEIGHT = { extract: [0, 0.1], interpolate: [0.1, 0.75], encode: [0.85, 0.15] };
const overallOf = (stage, p) => { const [a, w] = STAGE_WEIGHT[stage]; return a + w * (p || 0); };

/* ---------- sidebar: scroll-spy + smooth jump ---------- */
const content = document.querySelector('.content');
const tocLinks = [...document.querySelectorAll('.toc a')];
tocLinks.forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  document.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}));
function spy() {
  const top = content.getBoundingClientRect().top + 160;
  let cur = tocLinks[0];
  for (const a of tocLinks) { const s = document.querySelector(a.getAttribute('href')); if (s && s.getBoundingClientRect().top <= top) cur = a; }
  if (content.scrollTop + content.clientHeight >= content.scrollHeight - 4) cur = tocLinks[tocLinks.length - 1];
  tocLinks.forEach((a) => a.classList.toggle('on', a === cur));
}
content.addEventListener('scroll', spy, { passive: true });

window.flow.onProgress((d) => {
  if (d.stage === 'done') return;
  setStep(d.stage);
  setProgress(d.pct || 0, overallOf(d.stage, d.pct));
  if (d.stage === 'interpolate') {
    $('stFrames').textContent = `${fmtNum(d.done)} / ${fmtNum(d.total)}`;
    $('stSpeed').textContent = d.speed ? `${d.speed.toFixed(1)} fps` : '—';
    $('stEta').textContent = fmtTime(d.eta);
    if (d.preview && d.preview !== S.last) {
      S.last = d.preview;
      $('livePreview').src = fileUrl(d.preview) + '?t=' + Date.now();
      $('liveHint').classList.add('hidden');
    }
  } else { $('stEta').textContent = '—'; $('stSpeed').textContent = '—'; }
});

window.flow.onFinished((r) => {
  clearInterval(S.timer);
  if (r.cancelled) { setProgress(0, 0); return show('loaded'); }
  if (r.ok) setProgress(1, 1);
  if (!r.ok) { show('loaded'); return showError(r.error); }
  $('resultPlayer').src = fileUrl(S.output);
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  $('resultInfo').textContent = `${S.output}`;
  show('result');
});
window.flow.onProgress((d) => { if (d.stage === 'done') $('resultInfo').textContent = `${S.output} · ${fmtNum(d.frames)} frames · ${(d.outSize / 1048576).toFixed(1)} MB · ${fmtTime(d.seconds)}`; });

$('cancel').onclick = () => window.flow.cancel();
$('reveal').onclick = () => window.flow.reveal(S.output);
$('again').onclick = () => {
  $('resultPlayer').removeAttribute('src'); S.info = null; setProgress(0, 0);
  document.querySelector('.crumbs b').textContent = 'New video';
  show('drop'); refresh();
};

init();
