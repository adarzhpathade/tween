## Goal

The app builds on Windows, macOS and Linux, but has only ever run on one Windows PC with an NVIDIA GPU. Make CI prove more on every OS, and fix the platform bugs it finds.

## Do

1. **CI runs the real pipeline tests on all three OSes.** In `.github/workflows/build.yml`:
   - Install ffmpeg on each runner. Use `choco` or `winget` on Windows, Homebrew on macOS, and apt on Ubuntu. Or use the app's own installer code path if that is practical.
   - Install Node.
   - Make sure `test_e2e_fake_rife` and the other e2e tests actually run instead of skipping. They currently skip when ffmpeg or node is missing. In CI, set an env var such as `TWEEN_REQUIRE_E2E=1` that turns a skip into a failure.
2. **Setup downloads tested for real.** Add an opt-in test (`#[ignore]`, run in CI with `--ignored` on all three OSes) that runs the setup installer against the real download URLs into a temp folder:
   - RIFE from the TNTwise release zip for that OS.
   - FFmpeg: the BtbN or martin-riedl build for that OS and architecture. macOS runners are arm64.

   Check that the extracted binaries exist, are executable (chmod on unix, and on macOS clear quarantine if needed), and that `ffmpeg -version` runs. For RIFE, only check the files and models are present. Do not run RIFE, because runners have no Vulkan GPU.
3. **Fix the platform issues this reveals**, and audit these by reading the code:
   - Paths with spaces and non-ASCII characters on every OS.
   - Executable bits after zip extraction on macOS and Linux.
   - Mac arm64 versus x86_64 binary selection.
   - Linux `xdg-open` for show in folder.
   - `open_url` on macOS and Linux (it must use `open` or `xdg-open` with the same allowlist).
   - The GPU listing fallbacks when `lspci` or `system_profiler` are missing.
   - The CPU fallback (`-g -1`) being chosen when no Vulkan device exists.
4. **AMD and Intel GPUs:** read the device parsing and the self-test selection. Add unit tests with real-world `rife-ncnn-vulkan` device listing strings for AMD (for example `[0 AMD Radeon RX 6600]`, `[0 AMD Radeon(TM) Graphics]` iGPU) and Intel (`[0 Intel(R) Arc(TM) A770 Graphics]`, `[1 Intel(R) UHD Graphics 770]`). Also cover a two-GPU laptop where the discrete GPU should win. Also check the encoder probe order chooses AMF on AMD and QSV on Intel when they work.

## Evidence

- A green CI run on all three OSes, with the e2e and download tests not skipped. Give the run URL. You may push to your task branch only. The orchestrator handles merges.
- If you cannot push, run what you can locally, and list exactly what remains unproven.
- List every platform bug you fixed.

## Must not change

UI files. Other tasks are editing them right now.
