## Goal

Add the settings button and panel, and fix onboarding Skip, exactly as approved in `design/app-design-v7-onboarding-v3.html`. Preview them with `?state=ready&settings=open`, `&section=system|defaults|storage|about`, `&notices=open`, and on onboarding with `?state=empty&settings=open`. Read the mock's markup, CSS and JS for the settings sheet, the title-bar settings button, and Skip.

## 1. Onboarding Skip (a bug in the current app)

Skip must never bypass setup. Skip on the Welcome page goes to the system-check page, and the checks run there. Skip is hidden (with `visibility`, so the layout does not shift) on the system-check and permissions pages. Continue or Finish stays disabled until `setup_run` returns ok. There must be no path into the app without a saved, valid setup.

## 2. Title-bar settings button

Immediately left of minimize, on every screen including onboarding. Same 42 px size, hover and hairline treatment as the window controls. Use the mock's sliders glyph at the same stroke weight. Keep maximize.

## 3. Settings sheet

- A right-side sheet, 408 px wide, below the title bar, with a dimmed and blurred overlay over the app. Open and close with the T04 spring helpers. It closes on Esc, on an overlay click, on the X, or on the button again.
- A section nav (System, Defaults, Storage, About) that scrolls to each section and tracks the scroll position.
- **System**: real data from `setup_config`, with the same tick and warn styles as the onboarding check cards. Rows: System (OS, threads, RAM, free disk), Graphics (GPU names and driver), FFmpeg (version, bundled or system), Engine (RIFE build tag and installed models by their app names: Smooth, Detail, Fast), GPU acceleration (the device in use, or CPU mode), and Encoders.
  - **Run checks again**: calls `setup_run { install: true }` and animates the rows live from `setup-progress`, exactly like onboarding.
  - **Copy diagnostics**: copies a plain-text report to the clipboard and shows "Copied". The report contains the app version, OS, GPUs and driver, FFmpeg version and path, engine path and models, mode, encoders, free disk, and the last job error if there is one. It must contain no file names of the user's videos.
- **Defaults**: default model, default output folder (folder picker), default quality, keep audio, and scene-cut fix (default **on**). Persist them, and make the Ready screen use them for new videos. Scene-cut fix maps to `job.sceneDetect`.
- **Storage**:
  - The temp folder actually used by jobs.
  - Free space on that drive.
  - "In use": the size of Tween's leftover temp folders (`tween-*`) and self-test files.
  - "Clear temporary files": deletes only those, is disabled while a job runs, and shows "Cleared".
  - Add the backend commands needed (`storage_info`, `clear_temp`).
- **About**:
  - "Tween", the version from the crate (`app_version`), and **"Created by adarzh"** with **adarzh.tech** as a link to `https://adarzh.tech` (sage on hover).
  - A "Third-party notices" toggle listing RIFE (MIT), ncnn (BSD-3-Clause), FFmpeg ("GPL · downloaded build") and Geist (SIL OFL 1.1). Keep it consistent with `THIRD_PARTY_NOTICES.md`.
  - Opening the link goes through the existing safe `open_url` command. Add `https://adarzh.tech` to its allowlist as an exact https host match, with a unit test. Do not loosen the allowlist in any other way.

## Must not change

The frame-rate strip, video playback and the general layout; other tasks own those.
