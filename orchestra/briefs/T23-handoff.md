## Goal

Refresh `HANDOFF.md` (create it if missing) so a new developer or agent can continue the project.

## Do

Describe the true current state, from reading the repo, not from memory:
- What Tween is and the stack (Tauri 2, Rust, React/TS, RIFE via rife-ncnn-vulkan, FFmpeg).
- Repo layout (`app/`, `engine/`, `design/`, `orchestra/`, `test/`, `src/` reference pipeline).
- How to build, test and run: `npm run build`, `cargo test`, `npm run test:gpu`, `npm run bench`, `npm run test:long`, the tauri build, CI.
- Pipeline overview: file mode and streaming mode, fallback rules, chunks, scene cuts, ffmpeg version handling.
- Rules: no telemetry, nothing from VideoProc/Digiarty, no fake numbers, unique temp folders in tests, the mock/DEV-only preview params.
- The orchestra workflow (briefs, tasks.json, worker rules).
- What is verified and what is not (real GPU runs, signed builds, macOS/Linux GPUs) and a list of next steps. Do not invent benchmark numbers; link to the README Benchmarks section.

## Must not change

Anything except `HANDOFF.md` (and a one-line link from README if useful).
