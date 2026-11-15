## Goal

A GitHub Release workflow that builds installers when a `v*` tag is pushed. Do NOT create or push any tag, and do not publish a release. Only add the workflow and docs.

## Do

1. Add `.github/workflows/release.yml`, triggered on `push: tags: ['v*']` and `workflow_dispatch` (dispatch builds artifacts but does not publish).
2. Build with `tauri-action` (pin an exact version) or `npx tauri build`:
   - Windows x64: NSIS `setup.exe`.
   - macOS: aarch64 `.dmg` only (Apple Silicon, `macos-latest`); no x64 or Intel build.
   - Linux: `AppImage` and `.deb` (ubuntu-22.04, install the needed system packages).
3. Create the GitHub Release as a draft with notes generated from a template file `.github/release-notes.md`, covering:
   - What Tween is (no telemetry).
   - Benchmarks: copy only real rows from README's Benchmarks section; leave "pending" rows as pending. No invented numbers.
   - How to install unsigned builds: Windows SmartScreen "More info > Run anyway"; macOS "right-click > Open" or `xattr -dr com.apple.quarantine /Applications/Tween.app`; Linux `chmod +x` for the AppImage.
   - Known limits (GPU needed for RIFE; Vulkan).
4. Version in `tauri.conf.json`, `Cargo.toml` and `package.json` must match the tag; add a check step that fails when they differ.
5. Validate the YAML locally (for example with `actionlint` if available, or a YAML parse) and the existing `build.yml` must be unchanged.

## Must not change

App source, `app/src-tauri/icons`. No secrets: no signing keys are used.

## Supported systems (user decision)

Intel Macs (x86_64) are not supported. Update the README supported-systems text to say "macOS on Apple Silicon only" and mention it in the release notes template.
