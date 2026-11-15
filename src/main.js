'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const pipeline = require('./lib/pipeline');
const setup = require('./lib/setup');

let win = null;
let job = null;
let cfg = null;

const BASE = () => app.getPath('userData');
const DEV_ENGINE = path.join(__dirname, '..', 'engine', 'rife'); // optional local copy for development

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1040, minHeight: 700,
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d12', symbolColor: '#9aa3b5', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

// Onboarding: run every check; with install=true, download what is missing.
ipcMain.handle('setup-run', async (_e, opts = {}) => {
  const r = await setup.runChecks({ baseDir: BASE(), devEngineDir: DEV_ENGINE, install: !!opts.install, models: opts.models, emit: (item) => send('setup-progress', item) });
  if (r.ok) cfg = r.cfg;
  return { ok: r.ok, cfg: r.cfg };
});
ipcMain.handle('setup-config', () => cfg);

// Kept for the current renderer; the v7 UI will read setup-config instead.
ipcMain.handle('caps', () => ({
  engine: !!cfg?.rifeDir, ffmpeg: !!cfg?.ffmpeg, gpu: cfg?.gpu?.name || (cfg?.mode === 'cpu' ? 'CPU' : null),
  encoders: (cfg?.encoders || []).map((id) => ({ id, name: pipeline.ENCODERS[id]?.name || id })),
  models: setup.MODELS.filter((m) => (cfg?.models || []).includes(m.id)).map((m) => ({ ...m, multiOK: true })),
}));

ipcMain.handle('pick-video', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'ts', 'mts', 'm2ts', 'gif'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('probe', async (_e, file) => {
  if (!cfg) return { ok: false, error: 'Setup has not finished.' };
  try { return { ok: true, info: await pipeline.probe(cfg, file) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('pick-output', async (_e, suggested) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: suggested, filters: [{ name: 'MP4 video', extensions: ['mp4'] }, { name: 'MKV video', extensions: ['mkv'] }, { name: 'MOV video', extensions: ['mov'] }] });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('start', (_e, req) => {
  if (!cfg) return { ok: false, error: 'Setup has not finished.' };
  if (job) return { ok: false, error: 'A job is already running.' };
  job = pipeline.start(cfg, req, (evt) => send('progress', evt));
  job.promise.then((res) => { job = null; send('finished', res); });
  return { ok: true };
});

ipcMain.handle('cancel', () => { job?.cancel(); });
ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(file));
ipcMain.handle('open-file', (_e, file) => shell.openPath(file));
ipcMain.handle('open-link', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

app.whenReady().then(async () => {
  pipeline.cleanTemp();
  cfg = setup.loadConfig(BASE());
  createWindow();
});
app.on('before-quit', () => job?.cancel());
app.on('window-all-closed', () => app.quit());
