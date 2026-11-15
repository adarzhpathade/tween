## Goal

Clean up three known leftovers. Keep the UI identical to `design/app-design-v7-onboarding-v3.html`.

## Do

1. **Custom fps estimate from an invalid typed value.** While the custom fps field holds an invalid value (below min, above max, empty or non-numeric), the estimates (time, frames, size) and the Custom row must not be computed from it. Show an em dash for the estimates and keep Interpolate disabled until the value is valid. Add a unit test in `test/` (see `test/fps-strip.test.mjs`).
2. **`?custom=` URL params.** `?custom=edit&customval=` is read in `ReadyScreen.tsx` outside DEV. Gate it behind `import.meta.env.DEV` (and `?mock=1` where the other preview params use it), so a production build ignores them.
3. **Temp root.** `storage_info` and `clear_temp` use `std::env::temp_dir()`. They must use the same temp root the pipeline uses (`resolve_temp_root`: the user's chosen temp folder, else the default). Unit test it with a custom temp folder. `clear_temp` must only delete Tween's own subfolder, never the parent.

## Evidence

Checks pass. Screenshots of the Ready screen with an invalid custom value (50 and 300 at a 60 fps source) in `.tween-task/screens/`.

## Must not change

`app/src-tauri/icons`, the `data-pill` code, the design.

## Test temp folders

Every new test uses a unique temp folder (`std::process::id()` plus a counter, or `tempfile`), never a fixed name.
