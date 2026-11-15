// Stress test for the Windows state-file race: one process rewrites runs/X/state.json as fast as it can
// (through the orchestrator's own writeState), while this process reads it nonstop like the watcher.
// Usage: node orchestra/test/stress-state.mjs <empty scratch dir>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = path.resolve(process.argv[2]);
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(path.join(W, 'orchestra'), { recursive: true });
for (const f of ['orchestrator.mjs', 'watcher.mjs']) fs.copyFileSync(path.join(SRC, f), path.join(W, 'orchestra', f));
fs.writeFileSync(path.join(W, 'orchestra', 'tasks.json'), JSON.stringify({ tasks: [{ id: 'X', title: 'x', brief: 'b', deps: [] }] }));
spawnSync('git', ['init', '-q'], { cwd: W });

// Writer: hammer writeState through the real orchestrator code path (reject = one writeState call).
const writer = spawn(process.execPath, ['-e', `
  const { spawnSync } = require('child_process');
  let n = 0; const t = Date.now();
  while (Date.now() - t < 15000) {
    const r = spawnSync(process.execPath, ['orchestra/orchestrator.mjs', 'reject', 'X', '--feedback', 'f' + n++], { encoding: 'utf8' });
    if (r.status !== 0) { console.log('WRITER FAILED', r.stderr.slice(0, 300)); process.exit(1); }
  }
  console.log('writes', n);
`], { cwd: W, stdio: ['ignore', 'pipe', 'inherit'] });
let wout = ''; writer.stdout.on('data', (d) => (wout += d));

// Readers: the watcher (real code) in follow mode, plus a tight read loop holding the file open.
const watcher = spawn(process.execPath, ['orchestra/watcher.mjs', '--follow', '--interval', '10ms'], { cwd: W, stdio: ['ignore', 'ignore', 'pipe'] });
let werr = ''; watcher.stderr.on('data', (d) => (werr += d));
const f = path.join(W, 'orchestra', 'runs', 'X', 'state.json');
let reads = 0, bad = 0;
const iv = setInterval(() => {
  for (let i = 0; i < 50; i++) {
    try { const fd = fs.openSync(f, 'r'); const s = fs.readFileSync(fd, 'utf8'); fs.closeSync(fd); JSON.parse(s); reads++; }
    catch (e) { if (e.code !== 'ENOENT') bad++; }
  }
}, 1);
const code = await new Promise((r) => writer.on('close', r));
clearInterval(iv); watcher.kill();
console.log(wout.trim(), `| reads ${reads}, torn/locked reads ${bad} | watcher errors: ${werr.trim() ? werr.trim().slice(0, 200) : 'none'}`);
console.log(code === 0 && !werr.trim() ? 'PASS' : 'FAIL');
process.exit(code === 0 && !werr.trim() ? 0 : 1);
