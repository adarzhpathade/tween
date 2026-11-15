## Goal

Remove every leftover "Flowmotion" and every hard-coded fake folder from the app. Today `D:\Videos\Flowmotion` and `D:\Flowmotion\scratch` are used as defaults and placeholders, in `OnboardingScreen.tsx`, `SettingsSheet.tsx` and `DoneScreen.tsx`. On a PC with no D: drive, saving fails. The app is called **Tween**.

## Do

1. **Real default folders, from the Rust side.** Add a command `default_folders` that returns:
   - `output`: the OS Videos folder plus `Tween`. Use `dirs::video_dir()`, falling back to the home folder plus `Videos`, then to the home folder. On Windows this gives `C:\Users\<name>\Videos\Tween`.
   - `temp`: the folder jobs actually use, `std::env::temp_dir()`, unless the user set a custom one.

   Create the output folder only when a job first writes to it, not at startup.
2. **Frontend.**
   - Onboarding (permissions page), Settings (Defaults and Storage) and Done must show these real paths and never a hard-coded `D:\...` path.
   - When nothing is known yet, show `—`, never a fake path.
   - Defaults chosen in onboarding persist to the same settings store that Settings and Ready use, so all three agree.
3. **Text.**
   - Welcome: "Tween adds the frames your footage never had, so 24 or 30 fps video plays as smooth as 60."
   - Permissions: "Choose what Tween may read and where it writes. You can change this later."
   - The context-menu label becomes "Interpolate with Tween".

   After this, `grep -rni flowmotion app/src app/src-tauri/src app/index.html` must find nothing (excluding `?mock=1` mock data, which should also say Tween).
4. **Window and installer names.** Check `tauri.conf.json` (`productName`, window `title`) and `index.html` `<title>`. They must say Tween.

## Evidence

- A unit test for `default_folders`: the path ends with `Tween`, and nothing is created on disk.
- The grep output from step 3.
- Headless Edge screenshots (`?mock=1`) of the permissions page and the Settings Storage section.

## Must not change

Layout, colours, and the Ready screen's frame-rate strip and drop zone, which another task is changing right now. Keep `design/` untouched.
