# Orchestra: Sonnet orchestrator + Antigravity workers

This folder runs the Tween (Tauri) build with **Antigravity CLI (`agy`) workers**, supervised by a **Claude Sonnet orchestrator**.

```
 Claude Sonnet (tween-orchestrator agent)
   │  dispatch / review / accept / reject
   ▼
 orchestrator.mjs ──spawns──► worker process per task ──runs──► agy -p … (headless, in its own git worktree)
   ▲                                    │ writes runs/<id>/state.json, events, checks log
   └──────── watcher.mjs ◄──────────────┘ wakes the orchestrator on review / failure / stall
```

## Files

| File | What it is |
|---|---|
| `tasks.json` | The task graph (T01 to T08), dependencies, and acceptance checks for each task. |
| `briefs/*.md` | What each worker must build. |
| `WORKER_RULES.md` | Rules every worker gets first (scope, design, licences, reply format). |
| `orchestrator.mjs` | Dispatch, review, accept (merge), reject (send back), kill, reset, log. |
| `watcher.mjs` | Follows workers, detects stalls and dead workers, writes `STATUS.md`, exits when you are needed. |
| `../.claude/agents/tween-orchestrator.md` | The Sonnet orchestrator agent for Claude Code. |
| `runs/`, `STATUS.md`, `../.worktrees/` | Runtime state (git-ignored). |

## One-time setup

1. Install and sign in to Antigravity CLI once, interactively: `agy` (headless runs reuse the cached sign-in).
2. Commit your work on `main`. Workers branch from the last commit; uncommitted files are invisible to them.
3. `node orchestra/orchestrator.mjs doctor --live` (makes one tiny request to prove sign-in works).

## Run it

In Claude Code: *"use the tween-orchestrator agent to run the workers"* (it uses Sonnet), or by hand:

```
node orchestra/orchestrator.mjs dispatch --auto-approve      # start ready tasks (max 2 at once)
node orchestra/watcher.mjs                                   # wait until something needs you
node orchestra/orchestrator.mjs review T01                   # diff stat, checks, worker summary
node orchestra/orchestrator.mjs accept T01                   # merge into main
node orchestra/orchestrator.mjs reject T01 --feedback "1. …" # send back; continues the same agy conversation
```

## Permissions: read this

In headless mode `agy` cannot ask you to approve a file edit or command. Without approval it **soft-denies** them, so a worker without `--auto-approve` can only read. `--auto-approve` passes `--dangerously-skip-permissions` to agy: the worker can then run any command as you, not only inside its worktree. Safer options:

- Add `--sandbox` (agy's terminal sandbox) together with `--auto-approve`.
- Or, instead of `--auto-approve`, allow only what workers need in `~/.gemini/antigravity-cli/settings.json` (`permissions.allow`, for example `"write_file(app/)"`, `"command(npm)"`, `"command(cargo)"`, `"command(git)"`).

## How a task flows

`blocked` → (dependencies merged) → `ready` → `dispatch` → `running` → worker finishes, checks run →
`review` (checks passed) or `failed` → orchestrator `accept` → `done`, or `reject --feedback` → `ready` again.

A merge conflict on `accept` sends the task back automatically with instructions to rebase.

**Three attempts per worker** (`maxAttempts` in `tasks.json`). Every dispatch counts. When the third attempt fails or is rejected, the task becomes `sonnet`: no fourth worker is started, and the Sonnet orchestrator does that task itself (`takeover <id>`, work in the worktree, `submit <id>`, then the normal review and `accept`).
