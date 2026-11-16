# Tween

**Between every frame.** Tween is a desktop app that makes video smoother by creating the frames your footage never had. It turns 24 or 30 fps into 48, 60, 120 fps or any rate up to 240. It runs on your own graphics card, and your videos never leave your device.

- **Private by design:** Everything runs locally on your GPU. No telemetry, no tracking, no account, and no network access needed after initial engine setup.
- **Works on the GPU you have:** NVIDIA, AMD, and Intel graphics through Vulkan, including integrated graphics, with automatic CPU fallback.

---

## Supported systems

- **Windows 10/11 (x64):** NSIS setup installer (`.exe`).
- **macOS on Apple Silicon only (arm64):** Disk image (`.dmg`). *Note: Intel Macs (x86_64) are not supported.*
- **Linux (x64, glibc):** `AppImage` and Debian package (`.deb`).

---

## How to install unsigned builds

These builds are not code-signed yet, so your operating system will show a security warning on first launch:

- **Windows:** When SmartScreen appears, click **More info** and then click **Run anyway**.
- **macOS (Apple Silicon only):** Right-click `Tween.app` in `/Applications` (or Finder) and select **Open**, or run in Terminal:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Tween.app
  ```
- **Linux (AppImage):** Make the AppImage executable before running:
  ```bash
  chmod +x Tween_*.AppImage
  ./Tween_*.AppImage
  ```

---

## Benchmarks

All numbers below are **measured**, not estimated. Each row says which version and which machine produced it.

### Test machine A
Windows 11 laptop, NVIDIA GeForce RTX 4050 Laptop GPU (6 GB), Intel UHD Graphics 770, 12 CPU threads, 16 GB RAM, NVENC HEVC encoder.

| Version | Engine mode | Job | Output fps | Time for 10 min @ 2× |
|---|---|---|---|---|
| 0.1.0 reference pipeline | File (PNG on disk) | Smooth, 2× | **17.8** | ~27 min |
| 0.1.0 reference pipeline | File (PNG on disk) | Smooth, to 60 fps | **14.7** | — |
| 0.1.0 reference pipeline | File (PNG on disk) | Fast, 2× | **18.0** | ~27 min |
| 0.1.0 reference pipeline | File (PNG on disk) | Detail, 2× | **14.6** | ~33 min |
| Speed update 1 (quick wins, Rust pipeline) | File, tuned | Smooth, 2× | **17.7** | ~27 min |
| Speed update 2 (streaming engine) | Stream (no disk) | Smooth, 2× | *pending* | *pending* |

**GPU self-test on the same machine:** RTX 4050 Laptop **1.6 s**, Intel UHD 770 **4.9 s**. Tween chose the RTX.

---

## Known limits

- **Vulkan GPU recommended:** RIFE requires a Vulkan-compatible GPU for acceptable performance. Without a working Vulkan device, Tween runs on the CPU (much slower).
- **macOS hardware:** macOS is supported on Apple Silicon only (M1/M2/M3/M4); Intel Macs are not supported.
- **Hardware encoding:** Supported with NVENC, AMD AMF, Intel Quick Sync, and Apple VideoToolbox. CPU fallback encoding (x264/x265) is used when hardware encoders are unavailable.
