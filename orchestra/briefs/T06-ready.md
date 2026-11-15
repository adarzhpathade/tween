## Goal

The Ready screen from the mock (`?state=open` empty, `?state=ready` loaded), wired to `probe_video` from T03.

## Behaviour (match the mock exactly)

- **Empty**: plain "Drop a video / or browse your computer / Choose video" box. Frame-rate strip, trim timeline and settings dimmed and disabled; the empty timeline shows faint ruler ticks. Drag and drop (Tauri drag-drop event) and the Tauri file dialog both work.
- **Loaded**: header shows the file name and one grey details line (`1920×1080 · 24 fps · 0:42 · H.264 · AAC · 1,008 frames`) from the real probe.
- Preview area with the Original / Interpolated switch (defaults to Interpolated). Before a job runs, both show the source poster frame (extract one frame with ffmpeg via a small backend command); say nothing misleading.
- **Frame-rate strip** (vertical, left of the right panel): 2×, 3×, 4×, 60, 120, Custom, with the sliding highlight and counting number (spring helpers). **Custom** opens a small numeric input (allowed 1 to 240 fps, must be above the source fps); this replaces the mock's placeholder that set 90.
- **Right panel**: model cards from the setup config (`Smooth` rife-v4.26 default, `Detail` rife-v4.25-heavy, `Fast` rife-v4.22-lite; only installed ones), Output (encoder list from `cfg.encoders` with friendly names from the encoder table, quality, keep audio), Save to (folder picker; default = the source file's folder; file name `<name>_<fps>fps.mp4`), estimates, Interpolate button.
- **Estimates**: frames = exact from ratio; time from a speed estimate (`cfg.gpu` self-test ms scaled by pixels, or a conservative default); size from bitrate guess. Label them as estimates.
- **Trim editor** below the video, as in the mock (drag in/out handles, I/O keys, reset). Trim feeds `job.trim`.
- Warnings in the panel's quiet style: HDR source ("HDR will be saved as SDR"), VFR source ("variable frame rate; output will be constant"), CPU mode ("no GPU, this will be slow").
- Ctrl+Enter starts. Persist the last model, encoder, quality and fps choice.
