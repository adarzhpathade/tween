'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const pipeline = require('./lib/pipeline');

let win = null;
let job = null;

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

ipcMain.handle('caps', () => pipeline.capabilities());

ipcMain.handle('pick-video', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'ts', 'mts'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('probe', async (_e, file) => {
  try { return { ok: true, info: await pipeline.probe(file) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('pick-output', async (_e, suggested) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: suggested, filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('start', (_e, req) => {
  if (job) return { ok: false, error: 'A job is already running.' };
  job = pipeline.start(req, (evt) => send('progress', evt));
  job.promise.then((res) => { job = null; send('finished', res); });
  return { ok: true };
});

ipcMain.handle('cancel', () => { job?.cancel(); });
ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(file));
ipcMain.handle('open-file', (_e, file) => shell.openPath(file));

app.whenReady().then(createWindow);
app.on('before-quit', () => job?.cancel());
app.on('window-all-closed', () => app.quit());
