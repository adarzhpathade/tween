## Goal

Setup downloads `rife-ncnn-vulkan-stream` for the user's OS into the engine folder (next to `rife-ncnn-vulkan`), so stream mode works for real users. DO NOT START until the orchestrator releases it (depends on the quiet GPU benchmark result).

## Do

1. The CI job `build-rife-stream` builds the binary on windows-x64, linux-x64 and macos-arm64. Make the release workflow (T22) or a documented release asset attach these as assets named `rife-ncnn-vulkan-stream-<os>-<arch>(.exe)` (read T22's workflow on main; extend it if needed, without creating tags).
2. In `app/src-tauri/src/setup/mod.rs`, after the RIFE engine is installed, download the matching stream asset from the GitHub release assets (URL constant in one place), verify it (size and SHA-256 listed next to the URL, or a checksums file asset), place it in the RIFE engine folder, chmod +x on unix, and clear macOS quarantine.
3. A failed or missing stream download must NOT fail setup. Log it and continue in file mode. Stream mode stays opt-in/auto exactly as today (file default unless the self-test passes and the mode is chosen).
4. Unit-test URL selection per OS/arch (no network), and an `#[ignore]` real-download test run in CI like the existing real setup tests.
5. No telemetry. Nothing from VideoProc/Digiarty.

## Must not change

UI files, `app/src-tauri/icons`. New tests use unique temp folders.
