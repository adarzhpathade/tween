# Tween handoff

Repo: https://github.com/adarzhpathade/tween (public, branch `main`). The UI and mocks still say "Flowmotion".

## What it is

A desktop app that raises a video's frame rate (24 to 48/60/120 fps) with RIFE (`rife-ncnn-vulkan`, MIT) and FFmpeg on the user's own GPU. Everything runs locally. Target build: **Tauri 2 + Rust + React/TS** in `app/` (built by Antigravity workers, see `orchestra/`). The Electron app in `src/` is the tested reference implementation.

## State (2026-11-15)

- **Design (done):** `design/app-design-v7-onboarding-v3.html`, the only mock. URL params `?state=open|ready|proc|done|empty`, `?step=0|1|2`, `&allow=1`, `?missing=1`. It was rebuilt after a file-damage incident; click through every state once before relying on it.
- **Reference pipeline (`src/lib/`), tested without a GPU:**
  - `setup.js`: first-run checks and installs. Finds GPUs (any vendor), the Vulkan loader, FFmpeg (PATH or downloaded), installs RIFE with v4.26 / v4.25-heavy / v4.22-lite models by **HTTP-Range partial extraction** (`remotezip.js`, ~72 MB instead of 827 MB), GPU self-test per Vulkan device with CPU fallback, and test-encodes each hardware encoder (NVENC, AMF, QSV, VideoToolbox, then x265/x264). Writes `setup.json`.
  - `pipeline.js`: analyse pass (exact frame count + `scdet` scene cuts), lossless PNG streaming through a pipe, chunked RIFE runs (disk use ~1.2 GB, timeline exact, see `planChunks`), scene-cut fix (no ghosting across cuts), correct colour matrix in and out, piped encode with audio and exact length, retry then CPU fallback on GPU failure.
  - Engine: TNTwise fork of rife-ncnn-vulkan, tag `20250112` (needed for RIFE 4.7+ models).
- **Tests:** `npm test` = 12 unit tests + 6 end-to-end runs with a stand-in engine (`test/fake-rife.js`). All pass. `npm run test:gpu` (`test/gpu-smoke.js`) runs the **real** engine; it has not been run yet, because the safety check blocks Claude from launching `rife-ncnn-vulkan.exe`. The user has to run it.
- **Electron UI:** old renderer, now runs setup automatically on first launch (temporary until the v7 UI is ported).
- **Orchestra:** `orchestra/orchestrator.mjs` + `watcher.mjs` run `agy` (Antigravity CLI 1.5.9, installed) workers on 8 tasks (`tasks.json`, `briefs/`), each in its own git worktree, with acceptance checks; the Sonnet orchestrator agent is `.claude/agents/tween-orchestrator.md`. Full cycle tested with a stand-in agy (`orchestra/test/run-fake.sh`). Not yet run with real agy.
- **Uncommitted:** all of the above is local; nothing committed or pushed since "Remove old design mock versions".

## Design decisions (v7)

- Palette: near-black, muted sage accent `#a9b79a` (`--acc`), clay warning `#c9907a`. Geist and Geist Mono.
- No decorative icons or dots. Kept: window controls, toggle, playhead, onboarding check tick/spinner.
- Onboarding: Welcome, system check (real setup items `system, gpu, ffmpeg, engine, accel, encoder`), permissions. Ready (empty / loaded with Original-Interpolated switch, vertical frame-rate strip, model cards, output, Save to, trim). Processing (progress column, Cancel/Esc). Done (result column).
- Mock numbers are demo data. In the real app GPU/CPU numbers must be real or hidden.

## Rules from the user

- Confirm the design in HTML before implementing it in the real app.
- Edit v7 in place; no replicas.
- nook's spring/physics motion (`E:\Projects\Products\nook`) goes in the final app, not the mocks.
- Never reuse VideoProc's proprietary weights or code. Only RIFE (MIT).

## Gotchas

- v7: a CSS comment and a JS comment share the text `v3: welcome motion`; never slice by first match. Back up before scripted edits.
- Screenshots: `msedge.exe --headless=new --disable-gpu --hide-scrollbars --window-size=1440,860 --virtual-time-budget=1500 --screenshot=out.png "file:///D:/Frame%20Interpolater/design/app-design-v7-onboarding-v3.html?state=ready"`.
- Bash heredocs with quotes failed here; write scripts with the file tool.
- ffmpeg 9.x needs `-fps_mode passthrough`. Do not use `-shortest` in the encoder (it cut 3 frames); use `-t`.
- rife-ncnn-vulkan's frame mapping is `fx = i * count / n` in float32 with the last frames clamped; `rifeMap` copies it exactly.
- agy headless soft-denies edits without `--dangerously-skip-permissions` (orchestrator `--auto-approve`) or `permissions.allow` rules.

## Next steps

1. User runs `npm run test:gpu` and watches `out/smoke/*.mp4` (cut at 4 s should be clean).
2. Commit the work (orchestrator `doctor` requires a clean tree), then `node orchestra/orchestrator.mjs doctor --live`.
3. Decide worker permissions (`--auto-approve`, `--sandbox`, or allow-rules), then run the tween-orchestrator agent.
4. Re-check the v7 mock by clicking through every state.
