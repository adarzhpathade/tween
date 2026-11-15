# Third-Party Notices and Licences

Tween incorporates or interfaces with several open-source software packages and resources. This document lists the third-party components, their respective licences, and runtime distribution details.

---

## 1. RIFE / rife-ncnn-vulkan

- **Description**: Real-Time Intermediate Flow Estimation for Video Frame Interpolation, ported to ncnn and Vulkan.
- **Upstream Project**: [nihui/rife-ncnn-vulkan](https://github.com/nihui/rife-ncnn-vulkan)
- **Distribution**: Downloaded at runtime during onboarding from [TNTwise/rife-ncnn-vulkan](https://github.com/TNTwise/rife-ncnn-vulkan/releases). Not bundled directly inside the installer to minimize package size.
- **Licence**: MIT Licence
- **Copyright**: (c) nihui and RIFE authors.

---

## 2. Tencent ncnn

- **Description**: High-performance neural network inference framework optimized for mobile and desktop platforms.
- **Upstream Project**: [Tencent/ncnn](https://github.com/Tencent/ncnn)
- **Licence**: BSD 3-Clause Licence
- **Copyright**: (c) Tencent.

---

## 3. FFmpeg

- **Description**: Cross-platform solution to record, convert, and stream audio and video.
- **Upstream Project**: [FFmpeg Project](https://ffmpeg.org)
- **Distribution**: Downloaded at runtime during onboarding. Not bundled inside the installer.
  - Windows and Linux builds: Downloaded from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases).
  - macOS builds: Downloaded from [Martin Riedl FFmpeg Builds](https://ffmpeg.martin-riedl.de).
- **Licence**: GNU General Public Licence (GPL) v3.0 (with GPL-enabled build configurations). Source code for FFmpeg is available at [https://ffmpeg.org](https://ffmpeg.org) and [https://github.com/FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg).

---

## 4. Geist and Geist Mono Fonts

- **Description**: Modern monospace and sans-serif typefaces designed for developers.
- **Upstream Package**: `@vercel/geist` / [vercel/geist-font](https://github.com/vercel/geist-font) (bundled locally via npm package `geist`).
- **Licence**: SIL Open Font License 1.1 (OFL-1.1)
- **Copyright**: (c) Vercel, Inc.
