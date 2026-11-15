## Goal

Make jobs faster with low-risk changes to the Rust pipeline (`app/src-tauri/src/pipeline/`), and add a GPU benchmark the user can run.

Measured baseline on an RTX 4050 Laptop at 1080p: about 18 output fps with v4.26 at 2×. The bottleneck is PNG encode/decode and disk I/O, plus the model reloading once per chunk. The RIFE compute itself is not the bottleneck. **Output quality must not change.**

## Do

1. **Benchmark first.** Add an `#[ignore]` test or a small bin, `tween-bench`, plus `npm run bench` in `app/`. It runs the real pipeline on a generated 1080p clip: 20 s of `testsrc2` plus motion, 24 fps, at 2× with v4.26. It prints:
   - total time and output fps
   - time per stage: analyse, extract, RIFE, encode
   - peak temp disk use
   - chosen GPU and encoder

   It also writes a JSON result to `bench-results/<timestamp>.json` (gitignored). It must exit clearly with "no GPU engine installed" when setup has not run.
2. **Uncompressed-fast PNGs.** Extract frames with `-compression_level 0` (or the lowest the PNG encoder supports). That makes ffmpeg's encode and RIFE's decode much cheaper, at the cost of disk space. Account for the larger files in the chunk-size and disk-space calculation.
3. **RIFE thread tuning.** Choose `-j load:proc:save` from the CPU thread count and the GPU, for example `-j 4:2:4` on 8 or more threads. Keep the existing retry with `-j 1:1:1` on failure.
4. **Fewer model reloads.** Make chunks as large as free disk allows, up to a cap (for example 4 GB or 1500 frames), instead of the fixed ~1.2 GB, so the model reloads fewer times. Keep the exact chunk-join maths from `planChunks` and its tests.
5. **Overlap stages.** While RIFE processes chunk N, extract chunk N+1, and encode chunk N-1 as its frames arrive, if this is not already done. Never hold more than two chunks on disk at once.
6. **Hardware decode** for extraction when available: `-hwaccel auto`, with automatic fallback to software on any error. Pixel output must be identical, so test that one extracted frame matches software decode (ssim > 0.999).
7. **Temp folder on the fastest drive:** keep the user's setting. If none is set, prefer the drive of the output folder when it has more free space than the system temp drive.

## Evidence

- All existing tests stay green, and `planChunks` and the join tests still pass.
- Unit tests for the `-j` choice and the chunk sizing.
- Run the end-to-end tests with the fake engine.
- You cannot run the real GPU benchmark here. Say that in your summary. The orchestrator or the user will run `npm run bench` before and after.

## Must not change

UI files, which other tasks are editing. Do not change the default model or the output encoding settings.
