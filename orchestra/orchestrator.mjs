#!/usr/bin/env node
// Tween orchestrator: runs Antigravity CLI (`agy`) workers on the tasks in tasks.json.
// Each task gets its own git worktree and branch; nothing reaches `main` until `accept`.
//
//   node orchestra/orchestrator.mjs doctor                 check git, agy, auth, toolchain
//   node orchestra/orchestrator.mjs status [--json]        task table
//   node orchestra/orchestrator.mjs dispatch [--max 2] [--only T03] [--auto-approve] [--sandbox]
//                                            [--model <slug>] [--effort high] [--timeout 60m]
//   node orchestra/orchestrator.mjs review T03             diff stat, checks, worker summary
//   node orchestra/orchestrator.mjs accept T03             merge task/T03 into main, remove worktree
//   node orchestra/orchestrator.mjs reject T03 --feedback "what to fix"   send it back (same conversation)
//   node orchestra/orchestrator.mjs kill T03 | reset T03 | log T03 [--n 40]
//
// Per-task state lives in orchestra/runs/<id>/state.json (one writer per file, so no races).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RUNS = path.join(HERE, 'runs');
const WT = path.join(ROOT, '.worktrees');
const TASKS = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks.json'), 'utf8'));
const BASE = TASKS.baseBranch || 'main';
const WIN = process.platform === 'win32';
// AGY_CMD (JSON array) replaces the agy binary, for testing the orchestrator without real workers.
const AGY_CMD = process.env.AGY_CMD ? JSON.parse(process.env.AGY_CMD) : [process.env.AGY_BIN || 'agy'];
const AGY = AGY_CMD[0];

// ---------- utils ----------
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const now = () => new Date().toISOString();
const sh = (cmd, a, cwd = ROOT, extra = {}) => {
  // On Windows, npm/npx are .cmd shims and need a shell; pass one quoted command line.
  if (extra.shell) {
    const q = (s) => (/[\s"&|<>^]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s);
    return spawnSync([cmd, ...a].map(q).join(' '), { cwd, encoding: 'utf8', windowsHide: true, ...extra, shell: true });
  }
  return spawnSync(cmd, a, { cwd, encoding: 'utf8', windowsHide: true, shell: false, ...extra });
};
const git = (a, cwd = ROOT) => { const r = sh('git', a, cwd); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${(r.stderr || r.stdout).trim()}`); return r.stdout.trim(); };
const tryGit = (a, cwd = ROOT) => { try { return git(a, cwd); } catch { return null; } };
const taskById = (id) => { const t = TASKS.tasks.find((x) => x.id === id); if (!t) die(`No task ${id}`); return t; };
const runDir = (id) => path.join(RUNS, id);
const wtDir = (id) => path.join(WT, id);
const die = (m) => { console.error(m); process.exit(1); };

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

function readState(id) {
  const f = path.join(runDir(id), 'state.json');
  if (!fs.existsSync(f)) return { id, status: 'pending', attempts: 0 };
  // On Windows a read can collide with a write in progress; retry instead of guessing "pending".
  for (let i = 0; i < 20; i++) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (i === 19) throw e; pause(25); }
  }
}
function writeState(id, patch) {
  fs.mkdirSync(runDir(id), { recursive: true });
  const s = { ...readState(id), ...patch, updatedAt: now() };
  const f = path.join(runDir(id), 'state.json');
  const body = JSON.stringify(s, null, 2);
  fs.writeFileSync(f + '.tmp', body);
  // Windows refuses to rename over a file another process (the watcher) has open: retry, then write in place.
  for (let i = 0; ; i++) {
    try { fs.renameSync(f + '.tmp', f); return s; }
    catch (e) {
      if (!TRANSIENT.has(e.code)) throw e;
      if (i < 20) { pause(25 + i * 10); continue; }
      fs.writeFileSync(f, body);
      try { fs.rmSync(f + '.tmp', { force: true }); } catch { /* ignore */ }
      return s;
    }
  }
}
// Progress heartbeats must never kill a worker.
function writeStateSoft(id, patch) { try { writeState(id, patch); } catch (e) { console.error(`state write skipped: ${e.code || e.message}`); } }
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function killTree(pid) {
  if (!pid) return;
  if (WIN) sh('taskkill', ['/pid', String(pid), '/T', '/F']);
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
}

function effectiveStatus(t) {
  const s = readState(t.id);
  if (s.status === 'running' && !alive(s.workerPid)) return { ...s, status: 'failed', reason: 'worker process died' };
  if (s.status === 'pending' || s.status === 'ready' || !s.status) {
    const depsDone = (t.deps || []).every((d) => readState(d).status === 'done');
    return { ...s, status: s.feedback ? 'ready' : depsDone ? 'ready' : 'blocked' };
  }
  return s;
}

// ---------- commands ----------
function status() {
  const rows = TASKS.tasks.map((t) => ({ t, s: effectiveStatus(t) }));
  if (flag('--json')) { console.log(JSON.stringify(rows.map(({ t, s }) => ({ id: t.id, title: t.title, deps: t.deps, ...s })), null, 2)); return; }
  for (const { t, s } of rows) {
    const extra = s.status === 'running' ? `  step ${s.steps || 0}${s.lastTool ? ' · ' + s.lastTool : ''} · ${ago(s.lastEventAt)}`
      : s.status === 'failed' ? `  ${s.reason || ''}` : s.status === 'review' ? `  checks ${s.checks?.passed ? 'passed' : 'FAILED'}` : '';
    console.log(`${t.id}  ${s.status.padEnd(8)} ${t.title}${t.deps?.length ? `  [after ${t.deps.join(',')}]` : ''}${extra}`);
  }
}
const ago = (iso) => { if (!iso) return 'no events yet'; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 90 ? `${Math.round(s)}s ago` : `${Math.round(s / 60)}m ago`; };

function doctor() {
  const out = [];
  const ok = (name, cond, hint = '') => { out.push(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  -> ' + hint}`); return cond; };
  ok('git repository', !!tryGit(['rev-parse', '--git-dir']), 'run inside the Tween repo');
  ok(`base branch ${BASE}`, !!tryGit(['rev-parse', '--verify', BASE]), `create ${BASE}`);
  const dirty = tryGit(['status', '--porcelain']) || '';
  ok('main tree has no uncommitted changes', !dirty, 'commit first: workers branch from the last commit, so uncommitted files are invisible to them\n' + dirty.split('\n').slice(0, 8).map((l) => '       ' + l).join('\n'));
  const v = sh(AGY, ['--version'], ROOT, { shell: WIN });
  ok('agy installed', v.status === 0, 'install: irm https://antigravity.google/cli/install.ps1 | iex');
  for (const [n, c] of [['node', ['node', '--version']], ['cargo', ['cargo', '--version']], ['npm', ['npm', '--version']]]) ok(n, sh(c[0], c.slice(1), ROOT, { shell: WIN }).status === 0, `install ${n}`);
  if (flag('--live')) {
    // One tiny prompt, to prove auth and the stream-json format.
    const r = sh(AGY, ['-p', 'Reply with the single word READY.', '--output-format', 'json', '--print-timeout', '2m'], ROOT, { shell: WIN, timeout: 150000 });
    let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* ignore */ }
    ok('agy headless call', j?.status === 'SUCCESS', (r.stderr || r.stdout || '').trim().slice(0, 300) || 'sign in once by running `agy` interactively');
  } else out.push('skip agy headless call (add --live to make one small request)');
  console.log(out.join('\n'));
}

function readyTasks() {
  return TASKS.tasks.filter((t) => effectiveStatus(t).status === 'ready');
}

function dispatch() {
  const max = Number(opt('--max', TASKS.maxParallel || 2));
  const running = TASKS.tasks.filter((t) => effectiveStatus(t).status === 'running').length;
  let pick = readyTasks();
  const only = opt('--only'); if (only) pick = pick.filter((t) => only.split(',').includes(t.id));
  pick = pick.slice(0, Math.max(0, max - running));
  if (!pick.length) { console.log(running ? `${running} task(s) already running; nothing new to start.` : 'No ready tasks.'); return; }
  if (!flag('--auto-approve')) console.log('Note: without --auto-approve, agy soft-denies file edits and commands in headless mode, so workers can only read. See orchestra/README.md.');
  const pass = ['--auto-approve', '--sandbox'].filter(flag);
  for (const k of ['--model', '--effort', '--timeout']) if (opt(k)) pass.push(k, opt(k));
  for (const t of pick) {
    fs.mkdirSync(runDir(t.id), { recursive: true });
    const log = fs.openSync(path.join(runDir(t.id), 'worker.log'), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_worker', t.id, ...pass], { cwd: ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.unref();
    writeState(t.id, { status: 'running', workerPid: child.pid, startedAt: now(), lastEventAt: null, steps: 0, lastTool: null, reason: null });
    console.log(`started ${t.id} (${t.title}) pid ${child.pid}`);
  }
}

function buildPrompt(t, s) {
  const dir = path.join(wtDir(t.id), '.tween-task');
  fs.mkdirSync(dir, { recursive: true });
  const rules = fs.readFileSync(path.join(HERE, 'WORKER_RULES.md'), 'utf8');
  const brief = fs.readFileSync(path.join(HERE, t.brief), 'utf8');
  const deps = (t.deps || []).map((d) => { const ds = readState(d); return `- ${d} ${taskById(d).title}: ${(ds.summary || 'merged').slice(0, 600)}`; }).join('\n');
  const checks = (t.checks || []).map((c) => '    ' + c.join(' ')).join('\n') || '    (none)';
  const body = `${rules}\n\n---\n\n# Your task: ${t.id} ${t.title}\n\n${brief}\n\n## Already merged before you\n${deps || '- nothing'}\n\n## Acceptance checks the orchestrator will run in this worktree\n${checks}\n` +
    (s.feedback ? `\n## Review feedback on your previous attempt (fix these first)\n${s.feedback}\n` : '');
  fs.writeFileSync(path.join(dir, 'TASK.md'), body);
  return s.feedback && s.conversationId
    ? `The reviewer sent your task back. Read .tween-task/TASK.md again, especially "Review feedback", fix everything listed, run the checks, commit, then reply with your summary.`
    : `You are a worker on the Tween project. Read .tween-task/TASK.md in the current directory and complete that task exactly as written. When finished, reply with the summary format it asks for.`;
}

async function worker(id) {
  const t = taskById(id);
  let s = readState(id);
  const attempt = (s.attempts || 0) + 1;
  const rd = runDir(id);
  const ev = fs.createWriteStream(path.join(rd, `events-${attempt}.ndjson`));
  try {
    // worktree
    const wt = wtDir(id), branch = `task/${id}`;
    if (!fs.existsSync(wt)) {
      fs.mkdirSync(WT, { recursive: true });
      if (tryGit(['rev-parse', '--verify', branch])) git(['worktree', 'add', wt, branch]);
      else git(['worktree', 'add', '-b', branch, wt, BASE]);
    }
    const prompt = buildPrompt(t, s);
    const a = ['-p', prompt, '--output-format', 'stream-json', '--print-timeout', opt('--timeout', t.timeout || TASKS.timeout || '60m')];
    if (opt('--model') || t.model || TASKS.model) a.push('--model', opt('--model') || t.model || TASKS.model);
    if (opt('--effort') || t.effort) a.push('--effort', opt('--effort') || t.effort);
    if (flag('--auto-approve')) a.push('--dangerously-skip-permissions');
    if (flag('--sandbox')) a.push('--sandbox');
    if (s.feedback && s.conversationId) a.push('--conversation', s.conversationId);
    s = writeState(id, { status: 'running', attempts: attempt, workerPid: process.pid, branch, worktree: wt, startedAt: now() });

    const child = spawn(AGY, [...AGY_CMD.slice(1), ...a], { cwd: wt, windowsHide: true, shell: false });
    writeStateSoft(id, { agyPid: child.pid });
    let buf = '', result = null, conv = null, steps = 0, lastTool = null, denials = 0, lastWrite = 0;
    child.stdout.on('data', (d) => {
      ev.write(d);
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.event === 'init') conv = e.conversation_id;
        if (e.event === 'step_update') { steps = Math.max(steps, (e.step_update.step_index || 0) + 1); if (e.step_update.tool_name) lastTool = e.step_update.tool_name; }
        if (e.event === 'result') result = e.result;
        if (Date.now() - lastWrite > 2000) { lastWrite = Date.now(); writeStateSoft(id, { lastEventAt: now(), steps, lastTool, conversationId: conv }); }
      }
    });
    let errTail = '';
    child.stderr.on('data', (d) => { const x = d.toString(); errTail = (errTail + x).slice(-4000); if (/denied|permission/i.test(x)) denials++; fs.appendFileSync(path.join(rd, `stderr-${attempt}.log`), x); });
    const code = await new Promise((res) => { child.on('error', (e) => { errTail += String(e); res(-1); }); child.on('close', res); });
    ev.end();
    conv = conv || result?.conversation_id;
    fs.writeFileSync(path.join(rd, `response-${attempt}.md`), result?.response || '(no response)');

    // make sure work is committed on the branch
    if (tryGit(['status', '--porcelain'], wt)) {
      git(['add', '-A'], wt);
      git(['commit', '-m', `${id}: ${t.title} (uncommitted worker changes, attempt ${attempt})`], wt);
    }
    const commits = Number(tryGit(['rev-list', '--count', `${BASE}..${branch}`]) || 0);

    // acceptance checks
    const checks = { passed: true, results: [] };
    let clog = '';
    for (const c of t.checks || []) {
      const r = sh(c[0], c.slice(1), wt, { shell: WIN, timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
      const ok = r.status === 0;
      checks.passed &&= ok;
      checks.results.push({ cmd: c.join(' '), ok, code: r.status });
      clog += `$ ${c.join(' ')}\n${(r.stdout || '').slice(-6000)}${(r.stderr || '').slice(-6000)}\n=> exit ${r.status}\n\n`;
    }
    fs.writeFileSync(path.join(rd, `checks-${attempt}.log`), clog);

    const agyErr = (result?.error?.message || result?.error || errTail.trim().split('\n').pop() || '').toString().slice(0, 200);
    // agy can return ERROR after the worker already gave its full reply (a trailing API call failed).
    // That work is real: if the reply has the required sections, let the reviewer judge it.
    const completeReply = /^## Done\b/m.test(result?.response || '') && /^## Questions\b/m.test(result?.response || '');
    const lateError = result?.status === 'ERROR' && completeReply;
    const agyOk = (code === 0 && result?.status === 'SUCCESS') || lateError;
    const reason = !agyOk ? `agy ${result?.status || 'exit ' + code}: ${agyErr}`
      : !commits ? (denials ? 'no changes: edits were permission-denied (dispatch with --auto-approve)' : 'worker made no changes')
        : !checks.passed ? 'acceptance checks failed' : null;
    writeState(id, {
      status: reason ? 'failed' : 'review', reason, finishedAt: now(), exitCode: code, agyStatus: result?.status || null,
      agyWarning: lateError ? `agy reported ERROR after the complete reply: ${agyErr}` : null,
      conversationId: conv, checks, commits, summary: (result?.response || '').slice(0, 4000), usage: result?.usage || null,
      feedback: reason ? s.feedback : null, workerPid: null, agyPid: null,
    });
  } catch (e) {
    ev.end();
    writeState(id, { status: 'failed', reason: e.message.slice(0, 300), finishedAt: now(), workerPid: null });
  }
}

function review(id) {
  const t = taskById(id), s = readState(id);
  const n = s.attempts || 0;
  console.log(`# ${id} ${t.title} — ${s.status}${s.reason ? ' (' + s.reason + ')' : ''}, attempt ${n}, ${s.commits || 0} commit(s)\n`);
  if (s.agyWarning) console.log(`Note: ${s.agyWarning}\n`);
  console.log(tryGit(['diff', '--stat', `${BASE}...task/${id}`]) || '(no diff)');
  console.log('\n## Checks'); for (const r of s.checks?.results || []) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.cmd}`);
  console.log(`  full log: ${path.relative(ROOT, path.join(runDir(id), `checks-${n}.log`))}`);
  console.log('\n## Worker summary\n' + (s.summary || '(none)'));
  console.log(`\nFull diff: git diff ${BASE}...task/${id}`);
}

function accept(id) {
  const s = effectiveStatus(taskById(id));
  if (s.status !== 'review' && !flag('--force')) die(`${id} is ${s.status}, not review. Use --force to merge anyway.`);
  if (tryGit(['status', '--porcelain', '--untracked-files=no'])) die('Main tree has uncommitted changes to tracked files; commit or stash them first.');
  const cur = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (cur !== BASE) die(`Check out ${BASE} first (on ${cur}).`);
  const r = sh('git', ['merge', '--no-ff', `task/${id}`, '-m', `Merge ${id}: ${taskById(id).title}`]);
  if (r.status !== 0) {
    sh('git', ['merge', '--abort']);
    writeState(id, { status: 'ready', feedback: `Your branch no longer merges cleanly into ${BASE}. Rebase onto ${BASE} (git rebase ${BASE}), resolve conflicts keeping both sides' intent, re-run the checks, and commit.\n${(r.stdout + r.stderr).slice(-1500)}` });
    die(`Merge conflict; ${id} sent back to the worker to rebase.`);
  }
  sh('git', ['worktree', 'remove', '--force', wtDir(id)]);
  sh('git', ['branch', '-d', `task/${id}`]);
  writeState(id, { status: 'done', acceptedAt: now(), feedback: null });
  console.log(`merged ${id} into ${BASE}`);
}

function reject(id) {
  const fb = opt('--feedback'); if (!fb) die('reject needs --feedback "..."');
  const s = readState(id);
  if (s.status === 'running') die(`${id} is running; kill it first.`);
  writeState(id, { status: 'ready', feedback: fb, reason: null });
  console.log(`${id} sent back. Next dispatch continues conversation ${s.conversationId || '(new)'}.`);
}

function kill(id) {
  const s = readState(id);
  killTree(s.agyPid); killTree(s.workerPid);
  writeState(id, { status: 'failed', reason: 'killed by orchestrator', workerPid: null, agyPid: null });
  console.log(`killed ${id}`);
}

function reset(id) {
  kill(id);
  sh('git', ['worktree', 'remove', '--force', wtDir(id)]);
  sh('git', ['branch', '-D', `task/${id}`]);
  fs.rmSync(runDir(id), { recursive: true, force: true });
  console.log(`reset ${id}`);
}

function log(id) {
  const s = readState(id), n = Number(opt('--n', 40));
  const f = path.join(runDir(id), `events-${s.attempts || 1}.ndjson`);
  if (!fs.existsSync(f)) die('no events yet');
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').slice(-n);
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (e.event === 'step_update') { const u = e.step_update; console.log(`#${u.step_index} ${u.state} ${u.step_type}${u.tool_name ? ' ' + u.tool_name : ''}${u.text_delta ? ' ' + u.text_delta.slice(0, 120).replace(/\n/g, ' ') : ''}`); }
      else console.log(e.event, e.event === 'result' ? e.result.status : '');
    } catch { /* partial line */ }
  }
}

// ---------- main ----------
const [cmd, id] = args;
const cmds = { doctor, status, dispatch, review: () => review(id), accept: () => accept(id), reject: () => reject(id), kill: () => kill(id), reset: () => reset(id), log: () => log(id), _worker: () => worker(id) };
if (!cmds[cmd]) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(cmd ? 1 : 0); }
await cmds[cmd]();
