## Goal

Prove the Rust pipeline (`app/src-tauri/src/pipeline/`) is correct on long, realistic videos before users try them. Fix every bug the tests find. The real RIFE engine cannot run in this environment, so use the existing fake engine (`test/fake-rife.js`, which writes blended frames and honours `-n`). The existing `test_e2e_fake_rife` in `pipeline/mod.rs` shows how.

## Add these end-to-end tests (Rust, fake RIFE, generated inputs)

Generate each input with ffmpeg `lavfi` (`testsrc2` plus a `sine` audio tone) at a small resolution such as 320×180, so the tests stay fast. Use `job.chunkFrames` or the equivalent override to force many chunks.

1. **Long, many chunks:** 10 minutes, 24 fps, with audio, at 2×. Assert all of these:
   - The output frame count is exactly 2 × the input frames (`ffprobe -count_packets`).
   - The output fps is 48.
   - The output duration is within one output frame of the input.
   - The audio stream exists, and its duration is within 50 ms of the video.
   - No frame is duplicated or dropped at chunk joins. Check this by comparing per-frame timestamps, or the `testsrc2` frame counter digits through a `select` of the frames around each join.
2. **Non-integer rates:** 23.976 fps to 59.94 (custom) and 29.97 fps at 2×. Assert the exact rational output rate in the stream header, and the frame count to ±1.
3. **Trim:** in = 61.5 s, out = 75.25 s. Assert the duration and the audio sync.
4. **Scene cuts:** concatenate two different `testsrc2` patterns, so there is a hard cut at 5 s, with scene-cut fix on. Assert no blended frames at the cut: the frames on each side match their own source pattern (compare them with ffmpeg `ssim` against the source frames).
5. **Variable frame rate input:** make one with `-vf setpts` jitter or `-fps_mode vfr`. Assert the job either succeeds with a constant-rate output or fails with a clear message. It must never hang.
6. **Disk-space guard and cancel:** cancelling mid-job removes the `tween-*` temp folder, and the process tree ends within 5 seconds.

Mark the slow tests `#[ignore]` only if they take longer than about 60 seconds each. Add a `npm run test:long` (or a cargo alias) that runs them. Report the timings.

## Must not change

The UI (other tasks are editing it right now). Change pipeline code only to fix real bugs the tests reveal, and explain each fix in your summary: what broke, why, and the fix.
