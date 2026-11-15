## Goal

Remove the disk round trip and the per-chunk model reload completely. Build a **streaming mode for the RIFE engine**: one process loads the model once, reads raw frames from stdin, and writes interpolated raw frames to stdout. FFmpeg decodes straight into it and encodes straight out of it, with no PNG files.

## Approach

- Start from the MIT-licensed TNTwise `rife-ncnn-vulkan` source (the same project and release we download today, tag `20250112`). Vendor it under `engine/rife-stream/` with its LICENSE, and record the upstream commit in `engine/rife-stream/UPSTREAM.md`. Do **not** use any VideoProc code or weights.
- Add a `--stream` mode to `main.cpp`. Keep the file mode unchanged.
  - Arguments: `-w W -h H` and the frame-time list (the same `rifeMap` the app computes today, passed as a file of float32 times), plus the existing `-m`, `-g` and `-j` options.
  - Input: raw RGB24 frames on stdin, in order.
  - Output: raw RGB24 frames on stdout, in output order, with source frames passed through bit-exact.
  - Use the same ncnn/Vulkan code path as file mode, so quality is identical.
  - Keep the GPU busy: read ahead and use a small queue between reader, GPU and writer threads.
- **Build in CI** for Windows x64, macOS arm64 and x64, and Linux x64 in a new workflow job. Use the prebuilt ncnn release and the Vulkan headers, as upstream's CI does. Upload the binaries as an artifact named `rife-stream-<os>`.
- **Rust pipeline:** add an engine mode `stream`. Use it only when the stream binary is installed and passes a 10-frame self-test whose output matches file mode (identical pass-through frames; SSIM above 0.995 on generated frames). Otherwise fall back to today's file mode automatically. Scene-cut handling, trim and the exact frame count must behave the same as in file mode.
- **Delivery to users:** setup does not download it yet. For now, the app looks for it next to the normal engine at `engine/rife/rife-ncnn-vulkan-stream(.exe)`. Add a `--engine-mode file|stream|auto` override in settings, which is a dev-only setting for now.

## Evidence

- The CI run is green and builds all binaries. Give the run URL. The orchestrator pushes your branch to run CI.
- A unit test of the frame-time list format.
- The end-to-end test with a fake stream engine (`test/fake-rife-stream.js`, which you write and which blends frames the same way as `fake-rife.js`). It must produce output identical to file mode with the fake engine.
- You cannot run the real GPU here. The user or orchestrator runs `npm run bench` with `--engine-mode stream` versus `file` on a real GPU before stream becomes the default.

## Must not change

UI files. File mode stays the default until the benchmark proves stream mode is faster and identical.

## README and benchmark rules (added by orchestrator)

- README.md on main has a Benchmarks section. If you touch the README, rebase onto the current version and keep that section.
- Do not invent benchmark numbers. Rows marked "pending" are filled in only from real `npm run bench` and `npm run test:gpu` output, which Claude runs on the user's GPU after the merge.
- File mode stays the default engine mode. Vendored source must carry its LICENSE and an UPSTREAM.md; nothing from VideoProc/Digiarty.
