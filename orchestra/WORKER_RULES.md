# Worker rules (read first)

You are one worker on **Tween**, a desktop app that raises a video's frame rate with RIFE on the user's own GPU. You work alone in a git worktree on your own branch. A reviewer (the orchestrator) reads your diff and either merges it or sends it back with feedback.

## Hard rules

1. **Stay in scope.** Do only your task. Do not refactor, rename or "improve" files your task does not mention. If you think something outside your scope is broken, say so in your summary instead of fixing it.
2. **The design is fixed.** `design/app-design-v7-onboarding-v3.html` is the approved design. Match its layout, spacing, type, colours and copy. Do not invent new screens, icons, or decorative dots. Never edit anything in `design/`.
3. **Reference implementation.** `src/lib/setup.js`, `src/lib/pipeline.js` and `src/lib/remotezip.js` (Electron prototype) are tested and correct. When porting, keep their behaviour, numbers and edge cases. `test/pipeline.test.js` and `test/e2e-fake.js` show what "correct" means.
4. **Only open-source models and code.** RIFE (MIT) via `rife-ncnn-vulkan`. Never use, download or reference VideoProc / Digiarty files, weights or code.
5. **No secrets, no telemetry, no network calls** except the download URLs already used in `src/lib/setup.js`.
6. **Do not touch** `src/` (the Electron prototype stays as reference until the Tauri app reaches parity), `engine/`, `design/`, `orchestra/`, `HANDOFF.md`, `.github/` (unless your task is CI).
7. **Commit your work** on your branch with clear messages. Do not push, do not merge, do not change branches, do not rewrite history.
8. **Run the acceptance checks** listed at the end of TASK.md before you finish, and fix failures. If a check cannot pass for a reason outside your task, explain exactly why.
9. **Windows first, cross-platform always.** The main dev machine is Windows 11 (paths with spaces: `D:\Frame Interpolater`). Code must also build on macOS and Linux: no hard-coded `C:\`, quote paths, use `std::path`, gate platform code with `cfg`.
10. **Ask instead of guessing** on product decisions: put the question under "Questions" in your summary and pick the most conservative option meanwhile.

## Stack

- Tauri 2, Rust stable (edition 2021), React 18 + TypeScript + Vite, in `app/`.
- Fonts: Geist and Geist Mono (npm package `geist`, bundled locally, no CDN).
- Motion: the `motion` npm package (v12) plus the spring helpers described in your brief.

## Final reply format

Reply with exactly these sections:

```
## Done
- what you built, file by file
## Checks
- each acceptance check and its result
## Not done / risks
- anything left, known bugs, anything untested (say plainly what you could not run)
## Questions
- product questions for the user, or "none"
```
