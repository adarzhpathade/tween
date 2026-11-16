# Upstream Source

- **Repository**: https://github.com/TNTwise/rife-ncnn-vulkan
- **Release Tag**: `20250112`
- **Commit SHA**: `5eea93c6e7079dda69d7a0ce9c1106ff5e641143`
- **License**: MIT (see `LICENSE`)

## Description
This directory vendors the open-source MIT-licensed `rife-ncnn-vulkan` engine code from upstream tag `20250112`.
It adds a streaming engine mode (`--stream`) allowing one process to load RIFE models once, read raw frames from stdin, and stream interpolated frames to stdout without round-tripping through disk.
No weights or code from VideoProc or Digiarty are used.
