## Goal

Make Tween installable on Windows, macOS and Linux, with CI that builds all three.

## Build

- Tauri bundle config: Windows NSIS installer (per-user, no admin), macOS `.dmg` (universal or arm64 + x64), Linux AppImage and `.deb`. App name **Tween**, identifier `app.tween.desktop`, icons generated from a simple placeholder (`tauri icon`), clearly marked as placeholder in the summary.
- The RIFE engine and FFmpeg are **not** bundled: onboarding downloads them (T02/T05). Keep installers small.
- Licences: add a "Third-party notices" file covering RIFE / rife-ncnn-vulkan (MIT), ncnn (BSD-3), FFmpeg (GPL build, downloaded at runtime: state where it comes from), Geist fonts (OFL). Show it from an About entry if there is an obvious place; otherwise just include it in the bundle.
- `.github/workflows/build.yml`: matrix windows-latest, macos-latest, ubuntu-22.04; install Linux deps for Tauri 2 (webkit2gtk 4.1 etc.), `npm ci` in `app`, `cargo test`, `tauri build`; upload the bundles as workflow artifacts. Do not add release publishing or signing secrets.
- README section "Build from source" for the Tauri app.

## Notes

- You may not be able to run the macOS/Linux builds locally; say so, and make sure the workflow is valid YAML that GitHub accepts (`actionlint` if available).
