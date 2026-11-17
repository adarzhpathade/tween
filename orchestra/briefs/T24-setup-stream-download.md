## Goal

Setup downloads `rife-ncnn-vulkan-stream` for the user's OS into the engine folder (next to `rife-ncnn-vulkan`), so stream mode (now the default "auto" mode) works for real users. Released after the quiet GPU benchmark showed stream is faster than file mode.

## Do

1. The release workflow (`.github/workflows/release.yml`) builds the stream binary with the same steps as the CI job `build-rife-stream` and attaches these release assets, plus a `SHA256SUMS` file covering every asset:
   - `rife-ncnn-vulkan-stream-windows-x64.exe`
   - `rife-ncnn-vulkan-stream-linux-x64`
   - `rife-ncnn-vulkan-stream-macos-arm64`
2. In `app/src-tauri/src/setup/mod.rs`, after the RIFE engine is installed, download the matching asset from `https://github.com/adarzhpathade/tween/releases/download/v<app version>/<asset>`, look up its SHA-256 in that release's `SHA256SUMS`, verify it, place it in the RIFE engine folder, chmod +x on unix, and clear macOS quarantine. The repo and asset names are constants in one place.
3. A failed or missing download (no release yet, no network, hash mismatch) must NOT fail setup. Log it and continue in file mode.
4. Unit-test asset selection per OS/arch, checksum parsing and hashing (no network), a failure test, and an `#[ignore]` real-download test.
5. No telemetry. Nothing from VideoProc/Digiarty.

## Must not change

UI files, `app/src-tauri/icons`. New tests use unique temp folders.
