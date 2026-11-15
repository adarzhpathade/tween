// Stand-in for `agy -p ... --output-format stream-json`, for testing the orchestrator.
// Emits the documented NDJSON events, edits a file in the worktree and commits it.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const a = process.argv.slice(2);
const conv = a.includes('--conversation') ? a[a.indexOf('--conversation') + 1] : 'conv-' + Date.now();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const task = fs.readFileSync('.tween-task/TASK.md', 'utf8');
const id = /# Your task: (\S+)/.exec(task)[1];
out({ event: 'init', conversation_id: conv, init: { cwd: process.cwd(), tools: ['write_file'], permission_mode: a.includes('--dangerously-skip-permissions') ? 'always-proceed' : 'request-review' } });
out({ event: 'step_update', step_update: { conversation_id: conv, step_index: 0, state: 'DONE', step_type: 'tool', tool_name: 'write_file' } });
if (process.env.FAKE_AGY_MODE === 'nowrite') { process.stderr.write('Permission denied for write_file (soft-deny)\n'); }
else {
  const fb = task.includes('Review feedback') ? ' (fixed after feedback)' : '';
  fs.writeFileSync(`work-${id}.txt`, `work for ${id}${fb}\n`);
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['commit', '-qm', `${id}: fake work${fb}`]);
}
await new Promise((r) => setTimeout(r, 300));
out({ event: 'result', result: { conversation_id: conv, status: process.env.FAKE_AGY_MODE === 'lateerror' ? 'ERROR' : 'SUCCESS',
  ...(process.env.FAKE_AGY_MODE === 'lateerror' ? { error: { message: 'dial tcp: lookup example: no such host' } } : {}), response: `## Done\n- wrote work-${id}.txt\n## Checks\n- ok\n## Not done / risks\n- none\n## Questions\n- none`, duration_seconds: 0.3, num_turns: 1, usage: { total_tokens: 1 } } });
