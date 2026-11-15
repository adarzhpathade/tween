#!/usr/bin/env node
// Tween watcher: follows the workers the orchestrator started and reports what changes.
//
//   node orchestra/watcher.mjs                    wait until something needs the orchestrator, then exit
//   node orchestra/watcher.mjs --follow           never exit; print every change (good for a Monitor)
//   node orchestra/watcher.mjs --once             print the current picture and exit
// Options: --interval 5s  --stall 15m  --max-wait 9m  --no-kill
//
// "Needs the orchestrator" = a task reached review or failed, a worker stalled or died,
// or nothing is running while tasks are still ready. Exit code: 0 attention, 2 max-wait reached, 3 all done.
// Each run also rewrites orchestra/STATUS.md so anyone can see the board.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TASKS = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dur = (s) => { const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(s)); if (!m) return 0; return Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5 }[m[2] || 's']; };
const INTERVAL = dur(opt('--interval', '5s')), STALL = dur(opt('--stall', TASKS.stallAfter || '15m')), MAXWAIT = dur(opt('--max-wait', '9m'));

const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const cache = {};
// Read without holding the file open longer than needed; on a collision with a write, use the last good copy.
const read = (id) => {
  const f = path.join(HERE, 'runs', id, 'state.json');
  if (!fs.existsSync(f)) return { status: 'pending' };
  try { return (cache[id] = JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { return cache[id] || { status: 'pending' }; }
};
const orch = (...a) => spawnSync(process.execPath, [path.join(HERE, 'orchestrator.mjs'), ...a], { cwd: ROOT, encoding: 'utf8' });

function snapshot() {
  const out = {};
  for (const t of TASKS.tasks) {
    const s = read(t.id);
    let st = s.status || 'pending';
    if (st === 'running' && !alive(s.workerPid)) st = 'died';
    if (st === 'pending' || st === 'ready') st = (t.deps || []).every((d) => read(d).status === 'done') || s.feedback ? 'ready' : 'blocked';
    const idle = st === 'running' ? Date.now() - Date.parse(s.lastEventAt || s.startedAt || new Date().toISOString()) : 0;
    out[t.id] = { title: t.title, st, steps: s.steps || 0, tool: s.lastTool, idle, reason: s.reason, checks: s.checks?.passed };
  }
  return out;
}

function board(snap) {
  const lines = ['# Tween worker board', '', `Updated ${new Date().toLocaleString()}`, '', '| Task | Status | Detail |', '|---|---|---|'];
  for (const [id, v] of Object.entries(snap)) {
    const d = v.st === 'running' ? `step ${v.steps}${v.tool ? ' · ' + v.tool : ''} · idle ${Math.round(v.idle / 1000)}s`
      : v.st === 'review' ? `checks ${v.checks ? 'passed' : 'failed'}` : v.reason || '';
    lines.push(`| ${id} ${v.title} | ${v.st} | ${d.replace(/\|/g, '/')} |`);
  }
  fs.writeFileSync(path.join(HERE, 'STATUS.md'), lines.join('\n') + '\n');
}

const line = (id, v, why) => console.log(`[${new Date().toLocaleTimeString()}] ${id} ${v.st}${why ? ' — ' + why : ''}${v.st === 'running' ? ` (step ${v.steps}${v.tool ? ', ' + v.tool : ''})` : ''}${v.reason ? ' — ' + v.reason : ''}`);

let prev = {};
const t0 = Date.now();
for (;;) {
  const snap = snapshot();
  board(snap);
  const attention = [];
  for (const [id, v] of Object.entries(snap)) {
    const p = prev[id];
    if (v.st === 'running' && v.idle > STALL) {
      if (!flag('--no-kill')) { orch('kill', id); v.st = 'failed'; v.reason = `stalled: no events for ${Math.round(v.idle / 60000)} min`; }
      attention.push(id); line(id, v, 'stalled'); continue;
    }
    if (!p || p.st !== v.st || (v.st === 'running' && (p.steps !== v.steps) && flag('--follow'))) {
      if (p || flag('--once') || flag('--follow')) line(id, v);
    }
    if (['review', 'failed', 'died', 'sonnet'].includes(v.st) && (!p || p.st !== v.st || !Object.keys(prev).length)) attention.push(id);
  }
  const vals = Object.values(snap);
  const running = vals.filter((v) => v.st === 'running').length, ready = vals.filter((v) => v.st === 'ready').length;
  if (flag('--once')) process.exit(0);
  if (!flag('--follow')) {
    if (vals.every((v) => v.st === 'done')) { console.log('All tasks done.'); process.exit(3); }
    if (attention.length) { console.log(`Needs orchestrator: ${attention.join(', ')}. Run: node orchestra/orchestrator.mjs review <id>`); process.exit(0); }
    if (!running && ready) { console.log(`Nothing running and ${ready} task(s) ready. Run: node orchestra/orchestrator.mjs dispatch`); process.exit(0); }
    if (!running && !ready) { console.log('Nothing running and nothing ready (blocked or waiting on review).'); process.exit(0); }
    if (Date.now() - t0 > MAXWAIT) { console.log(`Still running (${running}); no change needs you yet.`); process.exit(2); }
  }
  prev = snap;
  await new Promise((r) => setTimeout(r, INTERVAL));
}
