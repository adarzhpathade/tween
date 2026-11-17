# Tween handoff

Repo: https://github.com/adarzhpathade/tween (public, branch `main`). Version 0.1.0, unsigned installers, release workflow runs on `v*` tags.

## What it is

A desktop app that raises a video's frame rate (for example 24 to 48 or 60 fps) with RIFE (`rife-ncnn-vulkan`, MIT) and FFmpeg on the user's own GPU. Everything runs locally. No telemetry. Stack: **Tauri 2, Rust, React/TS**, in `app/`. Nothing from VideoProc or Digiarty (code, weights, assets) is used.

## Repo layout

- `app/`: the product. `app/src/` is the React UI (`shell/` screens: onboarding, ready, processing, done). `app/src-tauri/src/` is the Rust side: `setup/` (first-run checks, installs), `pipeline/` (probe, plan, runner, encoders, scene cuts, cleanup, SSIM, stats, e2e tests), `remotezip/` (HTTP-Range partial zip extraction), `bin/tween-bench.rs` (benchmark).
- `engine/`: `rife-stream/` is the source of our streaming engine (CMake, built in CI). `engine/rife/` and `rife.zip` are local engine downloads, not source.
- `design/`: `app-design-v7-onboarding-v3.html`, the only design mock. The real UI must match it. URL params `?state=open|ready|proc|done|empty`, `?step=0|1|2`.
- `orchestra/`: the Antigravity worker system (see below).
- `test/`: Node tests and stand-in engines (`fake-rife.js`, `fake-rife-stream.js`, `--fake-fail` makes them fail on purpose).
- `src/` (repo root): the older Electron reference pipeline, kept for the GPU smoke test and reference tests.
- `bench-results/`, `out/`: generated output.

## Build, test, run

- Dev: `npm --prefix app install`, then `npm --prefix app run tauri -- dev`. Mock and switcher code is only behind `import.meta.env.DEV` (with `?mock=1`); it must never show in a production build.
- Frontend: `npm --prefix app run build`, `npm --prefix app run typecheck`.
- Rust: `cargo test --manifest-path app/src-tauri/Cargo.toml -- --test-threads=16` and `cargo clippy --all-targets -- -D warnings` (both run in `app/src-tauri`).
- Full app binary: `npm --prefix app run tauri -- build --no-bundle`. Installers: `npx tauri build` with `--bundles` (see `.github/workflows/release.yml`).
- Root `npm test`: reference unit tests plus end-to-end runs with the stand-in engine. `node --test test/fps-strip.test.mjs`: frontend helper test.
- Real GPU: `npm run test:gpu` (reference pipeline), `npm run bench` in `app/` (Rust pipeline, `tween-bench`; options `--engine-mode file|stream|auto`, `--seconds N`, default 8). `npm run test:long` runs the `#[ignore]` tests, including real downloads.
- CI: `.github/workflows/build.yml` builds and tests on Windows, macOS (Apple Silicon) and Linux, and builds the stream engine (`build-rife-stream`). `release.yml` on a `v*` tag checks that all versions match the tag, builds unsigned installers, builds the stream binaries, and creates a **draft** release with the installers, three stream assets and `SHA256SUMS`.

## Pipeline overview

- Analyse (frame count, `scdet` scene cuts), extract, interpolate, encode with audio, clean up. Target fps maps to a rational ratio; the timeline stays exact. Scene cuts are handled so frames are not blended across a cut. Colour matrix is preserved. Encoder is the first one that passes a test encode (NVENC, AMF, QSV, VideoToolbox, then x265/x264).
- **File mode:** frames go to PNG on disk, processed in chunks (`plan_chunks`) with `rife-ncnn-vulkan`, then encoded. Uses a lot of temp disk.
- **Stream mode:** `rife-ncnn-vulkan-stream` loads the model once and frames flow FFmpeg to GPU to FFmpeg in memory, no temp images.
- **Default is now `auto`** (decision after the quiet GPU benchmark, below): stream when the stream binary is installed and passes a self-test (once per session, about 2 s), otherwise file mode. If a stream run fails midway, the job falls back to file mode and records the reason (`engine_fallback_reason`). A developer can force `file` or `stream` through `engine_mode` in the setup config; there is no UI for it. The bench refuses to report a stream result if the pipeline fell back.
- **Setup** (`setup/mod.rs`): checks system, GPU (any vendor, picks the fastest via a short self-test, CPU fallback), Vulkan loader, FFmpeg, installs RIFE and models, then best-effort downloads the stream engine from the GitHub release matching the app version (`v<version>`, asset names `rife-ncnn-vulkan-stream-windows-x64.exe`, `-linux-x64`, `-macos-arm64`), verifying SHA-256 against the release's `SHA256SUMS`. A failed download never fails setup; the app stays in file mode.
- FFmpeg 9.x needs `-fps_mode passthrough`. Do not use `-shortest` in the encoder; use `-t`. rife-ncnn-vulkan's frame mapping is `fx = i * count / n` in float32 with the last frames clamped.
- Windows streaming needs the Microsoft Visual C++ 2015-2022 x64 Redistributable (noted in the release notes).

## Measured results

Real numbers are in the README **Benchmarks** section; do not copy or invent numbers elsewhere. Summary of the decision: on an RTX 4050 laptop, quiet machine, version `1d51c55`, stream beat file mode on both the 8 s and the 60 s clip (8 s: 21.2 fps stream vs 19.9 and 20.1 fps file; 60 s: 23.8 vs 23.0), and used 0 MB of temp disk versus 2.66 GB and 4496 MB. The stream self-test is about 2 s once per session. Because stream is not slower, it became the default.

## Rules

- No telemetry. Nothing from VideoProc/Digiarty. Only MIT RIFE.
- No fake numbers: GPU/CPU figures shown in the UI must be real or hidden. README numbers must be measured.
- Tests use unique temp folders and never set process-global env vars (a shared env var and shared temp dir caused a flaky parallel test, fixed in `fd28d6a`).
- UI must match `design/app-design-v7-onboarding-v3.html`. Motion follows nook's spring/physics (`E:\Projects\Products\nook`), ported into the real app, never the HTML mock.
- Workers must not edit `src/`, `design/`, `engine/`, `orchestra/` (see `orchestra/WORKER_RULES.md`).
- Claude cannot run the RIFE exe; the owner runs GPU benchmarks.

## Orchestra workflow

`orchestra/orchestrator.mjs` (`doctor`, `status`, `dispatch`, `review`, `accept`, `reject`, `takeover`, `submit`) and `watcher.mjs` run `agy` (Antigravity CLI) workers, each in its own git worktree `.worktrees/<id>` on branch `task/<id>`. Tasks are in `orchestra/tasks.json` with briefs in `orchestra/briefs/`; state is in the git-ignored `orchestra/runs/`. A worker gets 3 attempts; after that the orchestrator does the task itself. Accept only when checks pass, scope is respected and `WORKER_RULES.md` is followed. The orchestrator agent is `.claude/agents/tween-orchestrator.md`.

## Status (2026-11-17)

- **v0.1.0 is published** (not a draft) and marked latest: https://github.com/adarzhpathade/tween/releases/tag/v0.1.0. Release run 44043737164 was green.
- **Assets:**
  - `Tween_0.1.0_x64-setup.exe`
  - `Tween_0.1.0_aarch64.dmg` (Apple Silicon only; Intel Mac support was dropped by the user)
  - `Tween_0.1.0_amd64.AppImage`
  - `Tween_0.1.0_amd64.deb`
  - `rife-ncnn-vulkan-stream-{windows-x64.exe,linux-x64,macos-arm64}`
  - `SHA256SUMS`
- All public downloads return 200.
- **main = `bd407e1`**, with CI green on all 3 OSes. Tasks T01-T24 are all merged.
- **Default engine is `auto`:** stream when the stream binary is installed and passes its ~2 s self-test, otherwise file mode. Setup downloads the stream engine from the release matching the app version and checks it against `SHA256SUMS`. If that fails, file mode is used and setup still succeeds.
- **Fresh-user test pending:** the dev machine's Tween data (`%APPDATA%pp.tween.desktop`, `%LOCALAPPDATA%pp.tween.desktop`, and the `tween-*` temp folders) was deleted so the user can test the published installer like a new user. Next session: ask for their findings and fix them in v0.1.1.

## Verified and not verified

- Verified:
  - Rust and frontend tests on all three OSes in CI.
  - Real GPU runs of file and stream modes on one Windows machine (RTX 4050 Laptop).
  - The release workflow on a real tag, which produced the published v0.1.0.
- Not verified:
  - The published installer and a fresh-install setup on a real PC (in progress with the user).
  - macOS and Linux real GPU runs.
  - Other GPU vendors.
  - Signed or notarized installers (there are none; installers are unsigned, and Windows shows SmartScreen).
  - The `#[ignore]` test `test_real_stream_download`, which can now run since the release is public.

## Next steps

1. Collect the user's fresh-install test results, fix the issues, and ship v0.1.1. To release: bump the version in `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`, `app/package.json` and `package.json` (the `check-version` job enforces they match), push `main`, wait for green CI, then tag `v0.1.1`. The release is created as a draft; publish it when the user approves.
2. Run `cargo test -- --ignored test_real_stream_download` now that v0.1.0 is public.
3. Run the benchmark on macOS and Linux, and on an AMD/Intel GPU (`npm --prefix app run bench -- -- --engine-mode stream --seconds 60`), and add measured rows to the README.
4. Code signing and notarization (needs paid certificates; the user decides).
5. Landing/download page, built from the README (features, benchmarks, supported systems).

## Working with this user

- Cheap subagents write the code (Sonnet `tween-orchestrator`, `agy` workers with `--auto-approve --sandbox`, 3 attempts each, then Sonnet takes over).
- Claude runs pushes, CI checks, accepts and benchmarks directly. The user wants speed and does not want commands handed to them.
- Commits use the noreply email `208534789+adarzhpathade@users.noreply.github.com` and end with the `Co-Authored-By` / `Claude-Session` trailers.
- Never use VideoProc/Digiarty code or weights.
- Never invent benchmark numbers.
- Confirm UI design changes in the HTML mock (`design/app-design-v7-onboarding-v3.html`) before building them.
