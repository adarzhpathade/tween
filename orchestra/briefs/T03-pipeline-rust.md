## Goal

Port `src/lib/pipeline.js` to Rust in `app/src-tauri/src/pipeline/`. It is tested and correct; keep every number and edge case. Read it and `test/pipeline.test.js`, `test/e2e-fake.js`, `test/fake-rife.js` fully first.

## Behaviour to keep

1. **probe** via ffprobe JSON: size (swap for 90° rotation), fps as a rational, VFR flag, exact frames, audio codec, colour (`colourOf`: matrix from `color_space`, else bt709 for ≥720p and bt601 below; HDR flag).
2. **ratio**: output/input frames as a reduced fraction p/q; multiplier or target fps (`60`, `59.94`, `60000/1001`).
3. **analyse pass**: low-res decode (`scale=-2:270,scdet=threshold=10,metadata=mode=print:key=lavfi.scd.time:file=scenes.txt`, cwd = temp dir so the path needs no escaping) gives the exact frame count and scene-cut frame indices. Same trim args on every pass.
4. **planChunks / rifeMap / cutFixes / chunkSize**: identical maths (rifeMap must use f32 like the C++: `fx = (i as f64 * scale) as f32`). Chunks keep disk use near 1.2 GB.
5. **Extractor**: one ffmpeg writing PNGs to stdout (`image2pipe`, `-compression_level 2`, `scale=in_color_matrix=…:in_range=…:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24`), split by PNG chunk parsing (port `PngSplitter`), with back-pressure (stop reading when too far ahead).
6. **RIFE per chunk**: hard-link (copy fallback) frames into a chunk dir, run `rife-ncnn-vulkan -i -o -m -n -f %08d.png -g -j`, `-u` above 2560×1440, `-x` when TTA is on, `-j 1:1:1` on integrated GPU/CPU. On failure retry with `-j 1:1:1`, then once on CPU (`-g -1`) and emit a note.
7. **Scene-cut fix**: overwrite outputs whose pair straddles a cut with the nearer real frame.
8. **Encoder**: one ffmpeg reading `image2pipe` PNGs from stdin, source as input 1 (same trim) for audio and metadata, colour matrix back out with matching tags, `-fps_mode cfr`, `-t total/outFps` (not `-shortest`; that cut 3 frames in testing). Audio copy only when untrimmed, MP4/MOV and codec in the copy list; else AAC 256k. Encoder argument table exactly as `ENCODERS` in the JS.
9. Overlap: chunk k is fed to the encoder while chunk k+1 runs in RIFE.
10. Cancel kills every child process (Windows: kill the process tree). Temp dirs are removed; a startup sweep removes leftovers.

## Speed (measured on the JS version, RTX 4050, 1080p)

The JS pipeline makes only 15 to 18 output frames/s, and the light and heavy models run at nearly the same speed, so RIFE is not the bottleneck. Likely causes: PNG encode/decode to disk, and RIFE reloading the model for every chunk. After the port works and its tests pass, measure each stage and reduce the overhead (for example a faster PNG compression level, bigger chunks when disk allows, or overlapping extraction more aggressively). Do not trade away correctness or the tests to do it, and report before/after numbers in your summary (you may not be able to run the real engine; then say so and leave the measurement hooks in).

## Tauri surface

- `probe_video { path }` → info; `start_job { job }` → `Ok` or error if one is already running; `cancel_job`.
- Events: `job-progress` `{ stage: analyse|interpolate|encode|done, pct, done, total, speed, eta, preview, note }` (`preview` is a frame file path for the UI), and `job-finished` `{ ok, cancelled?, error?, output?, seconds?, outSize?, frames?, cuts? }`.
- Use `tokio::process`. No blocking work on the main thread.

## Tests (`cargo test pipeline::` must pass without a GPU)

- Port every case in `test/pipeline.test.js` (ratio, planChunks timeline cases, the never-past-own-files case, cutFixes, PngSplitter, colourOf) with the same vectors.
- End-to-end with the stand-in engine: allow a `rife_cmd` override in config (test-only) and run `node test/fake-rife.js` the way `test/e2e-fake.js` does, for the 2x, 60 fps, trim-3x, chunked and GPU-fails cases. These tests need ffmpeg on PATH; skip with a clear message if it is missing.
