#!/usr/bin/env bash
# Full orchestrator cycle in a throwaway clone, with the stand-in agy.
# Usage: bash orchestra/test/run-fake.sh <empty scratch dir>
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
W="$1"; rm -rf "$W"; mkdir -p "$W"; cd "$W"
git init -q -b main repo && cd repo
git config user.email t@t; git config user.name t
mkdir -p orchestra/briefs
cp "$SRC/orchestra/orchestrator.mjs" "$SRC/orchestra/watcher.mjs" "$SRC/orchestra/WORKER_RULES.md" orchestra/
cat > orchestra/tasks.json <<'JSON'
{ "baseBranch": "main", "maxParallel": 2, "timeout": "2m", "stallAfter": "1m", "tasks": [
  { "id": "A", "title": "first", "brief": "briefs/a.md", "deps": [], "checks": [["node", "-e", "require('fs').accessSync('work-A.txt')"]] },
  { "id": "B", "title": "second", "brief": "briefs/a.md", "deps": [], "checks": [["node", "-e", "process.exit(require('fs').readFileSync('work-B.txt','utf8').includes('fixed')?0:1)"]] },
  { "id": "C", "title": "after A and B", "brief": "briefs/a.md", "deps": ["A", "B"], "checks": [] } ] }
JSON
echo "do the thing" > orchestra/briefs/a.md
printf '.worktrees/\norchestra/runs/\norchestra/STATUS.md\n.tween-task/\n' > .gitignore
git add -A && git commit -qm init
win() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
export AGY_CMD="[\"$(win "$(command -v node)")\", \"$(win "$SRC/orchestra/test/fake-agy.mjs")\"]"
O="node orchestra/orchestrator.mjs"
step() { echo; echo "### $*"; }
step dispatch; $O dispatch --auto-approve
step watcher; node orchestra/watcher.mjs --interval 1s --max-wait 60s || true
$O status
step "review A"; $O review A | head -12
step "accept A"; $O accept A
step "reject B (its check requires feedback)"; $O reject B --feedback "1. say fixed"
$O dispatch --auto-approve
node orchestra/watcher.mjs --interval 1s --max-wait 60s || true
$O status
step "accept B"; $O accept B
step "C now ready"; $O status
step "read-only worker (no write)"; FAKE_AGY_MODE=nowrite $O dispatch
node orchestra/watcher.mjs --interval 1s --max-wait 60s || true
$O status
step "main log"; git log --oneline --graph | head -12; ls
