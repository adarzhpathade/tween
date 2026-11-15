# Tween

A desktop app that raises a video's frame rate (for example 24 to 48 or 60 fps) by generating the frames in between. It runs on your own GPU with [RIFE](https://github.com/nihui/rife-ncnn-vulkan) (`rife-ncnn-vulkan`) and FFmpeg. Your videos never leave your device.

> Status: early prototype. The UI is being designed in HTML mocks first (`design/`); the Electron app in `src/` is a working-in-progress pipeline.

## Requirements

- Windows with a Vulkan-capable GPU
- [Node.js](https://nodejs.org) 20+
- [FFmpeg](https://ffmpeg.org) on your `PATH`
- The RIFE engine (not included in this repo, see below)

## Set up the RIFE engine

1. Download a Windows release of `rife-ncnn-vulkan` from <https://github.com/nihui/rife-ncnn-vulkan/releases>.
2. Extract it so that `engine/rife/rife-ncnn-vulkan.exe` exists, with the model folders (`rife-v4.6`, and so on) beside it.

## Run

```
npm install
npm start
```

## Build from source

The modern desktop app is built with Tauri 2, Rust, and React located in `app/`.

### Prerequisites

- [Node.js](https://nodejs.org) 20+
- [Rust](https://www.rust-lang.org) (stable toolchain)
- Platform dependencies:
  - **Windows**: Microsoft C++ Build Tools and WebView2 (pre-installed on Windows 10/11)
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux (Ubuntu/Debian)**:
    ```bash
    sudo apt-get update && sudo apt-get install -y \
      libwebkit2gtk-4.1-dev \
      build-essential \
      curl \
      wget \
      file \
      libxdo-dev \
      libssl-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      squashfs-tools
    ```

### Development

1. Install frontend dependencies:
   ```bash
   cd app
   npm ci
   ```

2. Run the Tauri app in development mode:
   ```bash
   npm run tauri dev
   ```

3. Run Rust unit tests:
   ```bash
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

### Packaging

To build release installers and bundles for your platform:

```bash
cd app
npm run tauri build
```

This generates packages in `app/src-tauri/target/release/bundle/`:
- **Windows**: NSIS installer (`.exe`) configured for per-user installation without requiring administrator privileges.
- **macOS**: Apple Disk Image (`.dmg`) for Apple Silicon and Intel Macs.
- **Linux**: Standalone AppImage (`.AppImage`) and Debian package (`.deb`).

> **Note**: The RIFE inference engine and FFmpeg are **not** bundled into the installer to keep download sizes small; Tween automatically downloads and configures them during initial onboarding.

## Design

Open any file in `design/` in a browser. The current one is `design/app-design-v7-onboarding-v3.html`. Use the bar at the bottom to switch between the Welcome, Open, Ready, Processing and Done screens.

## Licence

MIT. See [LICENSE](LICENSE) for details. Third-party components, runtime dependencies, and notice details are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
