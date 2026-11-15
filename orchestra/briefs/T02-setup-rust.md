## Goal

Port first-run setup to Rust: `src/lib/setup.js` and `src/lib/remotezip.js` become `app/src-tauri/src/setup/` and `app/src-tauri/src/remotezip/`. Behaviour must match the JS exactly; read both files fully first.

## What it does (same as the JS)

1. **System**: OS, arch, CPU threads, RAM, free disk on the temp volume (warn below 4 GB).
2. **Graphics**: list GPUs from the OS (Windows `Get-CimInstance Win32_VideoController`, macOS `system_profiler SPDisplaysDataType -json`, Linux `lspci`), vendor detection, Vulkan loader present (Windows `System32\vulkan-1.dll`, Linux `libvulkan.so.1`, macOS always true). If missing, return the vendor driver link (same URLs as the JS).
3. **FFmpeg**: use our copy in `<app data>/engine/ffmpeg`, else PATH. Require the `scdet` filter. If missing and install is allowed, download from the same sources as `ffmpegSource()` in the JS. For zips use the remote-zip partial extraction (only `ffmpeg` and `ffprobe` binaries).
4. **Engine**: RIFE from `https://github.com/TNTwise/rife-ncnn-vulkan/releases/download/20250112/{windows|ubuntu|macos}.zip`, extracting only the exe, `vcomp140.dll` (Windows), `LICENSE` and the model folders `rife-v4.26`, `rife-v4.25-heavy`, `rife-v4.22-lite` through HTTP Range requests (≈ 72 MB instead of 827 MB). Note the Windows zip nests files under `rife-ncnn-vulkan-refs/heads/master-windows/`; find the prefix the way the JS does. chmod +x and strip macOS quarantine.
5. **GPU self-test**: make two 256×144 frames with ffmpeg, run RIFE once per Vulkan device (`-g N`), parse ncnn's `[N name]  queueC=` lines, prefer a dedicated GPU then the fastest, fall back to `-g -1` (CPU). Same `integrated` heuristic as `parseVulkanDevices`.
6. **Encoders**: test-encode 0.2 s of `color` with each of `hevc_nvenc, h264_nvenc, hevc_amf, h264_amf, hevc_qsv, h264_qsv, hevc_videotoolbox, h264_videotoolbox, libx265, libx264`; keep those that work.
7. Save the result to `<app data>/setup.json` (same fields as the JS `cfg`).

## Tauri surface

- Command `setup_run { install: bool, models?: Vec<String> }` → `{ ok, cfg }`, emitting `setup-progress` events with `{ id, label, state, detail, progress?, link? }` where state is `checking|ok|missing|installing|warn|error` and ids are `system, gpu, ffmpeg, engine, accel, encoder` (the onboarding UI keys off these).
- Command `setup_config` → saved cfg or null.
- Downloads: `reqwest` (rustls), streaming to `*.part` then rename, progress events at most every 150 ms. Retry a Range request when a signed URL expires (HTTP 403/410) by re-resolving the original URL, as the JS does.
- Unzip entries with `flate2` raw deflate; support stored and deflate, zip64 sizes/offsets.

## Tests (`cargo test setup::` must pass offline)

- Port `parseVulkanDevices` / `vendorOf` tests from `test/pipeline.test.js`.
- Remote-zip: build a small zip in memory (with a nested prefix and one zip64-style entry if practical), serve it from a local `127.0.0.1` HTTP server in the test that honours `Range`, and check extraction and prefix detection. No internet in tests.
- Mark any test that needs the network or a GPU `#[ignore]` with a comment explaining how to run it.
