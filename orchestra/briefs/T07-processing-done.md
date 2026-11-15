## Goal

The Processing and Done screens from the mock (`?state=proc`, `?state=done`), driven by real `job-progress` / `job-finished` events from T03.

## Processing

- Side panels hidden; preview plus the right 300 px column: progress %, stages (Analyse → Interpolate → Encode, map `analyse` to the mock's first stage), elapsed / left / speed, GPU and CPU.
- Preview shows the latest frame from `preview` (convert the path with Tauri's asset protocol; throttle to about 2 updates per second).
- **GPU and CPU numbers must be real or hidden.** Add a backend command that samples usage once a second: NVIDIA via `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits`; on Windows for any vendor via the `\GPU Engine(*)\Utilization Percentage` performance counter (PowerShell `Get-Counter`) as a fallback; CPU and RAM via `sysinfo`. If a value is unavailable, hide that cell; never show made-up numbers.
- Cancel button in the header and Esc: confirm-free, calls `cancel_job`, returns to Ready with settings kept.
- A `note` in a progress event (for example GPU fell back to CPU) shows as one quiet line.
- When the job finishes the app moves to Done by itself.

## Done

- Same layout; the right column shows result, file name, frame rate, size, time taken, saved-to, and the buttons "Show in folder" (reveal in Explorer/Finder) and "Interpolate another" (back to empty Ready).
- The Original / Interpolated switch now plays the source vs the output video, synced.
- Errors: show the error text plainly with "Try again" (back to Ready, settings kept). Cancelled: back to Ready silently.
