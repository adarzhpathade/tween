## Goal

Show the user's real video everywhere. Today the Ready screen shows the mock's decorative glowing-ball placeholder, the timeline shows grey bars, the Processing preview is a broken image, and the Done comparison videos cannot load. Fix all of it.

## Root causes found in review

1. **Asset protocol is off.** `convertFileSrc()` URLs fail because the `tauri` crate has no `protocol-asset` feature and `tauri.conf.json` has no `app.security.assetProtocol`. This breaks the Processing preview (`ProcessingScreen.tsx`) and the Done videos (`DoneScreen.tsx`).
2. **Poster errors are swallowed.** `ReadyScreen.tsx` `loadVideo()` catches `extract_frame` failures silently and falls back to the decorative `.scene` placeholder.
3. **No player and no thumbnails exist.**

## Build

- **Asset protocol, safely:** enable `protocol-asset`. Do not allow the whole disk statically: keep the static scope empty (or limited to the app's temp/preview folder) and add each file the user opens or produces at runtime (`app.asset_protocol_scope().allow_file(...)`) from the Rust side when the video is opened, when a job starts (its preview frame folder), and when it finishes (the output file). Set a real CSP in `tauri.conf.json` that allows `asset:` / `http://asset.localhost` for `img-src` and `media-src`, `ipc:` and `http://ipc.localhost` for `connect-src`, self for the rest. This also resolves the `csp: null` review note.
- **Ready preview = real player:** an HTML `<video>` of the source via the asset URL. Muted by default, no native controls (the design has its own). Poster = `extract_frame` result. If the WebView cannot play the codec (`error` event, or `canPlayType` false), fall back to the poster plus frame stepping from `extract_frame` at the playhead, and show one quiet line "Preview limited for this format; the output is not affected".
- **Remove the decorative placeholders** (`.scene.orig`, `.scene.res`, the glowing ball) from Ready, Processing and Done in normal builds. They may stay only behind the existing DEV `?mock=1` path.
- **Surface errors:** if `extract_frame` or probing fails, log the error and show a short message in the stage instead of a fake picture. Find out why `extract_frame` fails today on a normal H.264 MP4 (`Bouncing Ball.mp4`, 1920×1080, 60 fps) and fix it; say what it was in your summary.
- **Timeline thumbnails:** new command `extract_thumbnails { path, count, height }` → data URLs (JPEG), produced with **one** ffmpeg run (for example `-vf fps=<count/duration>,scale=-2:<height>` to image2pipe mjpeg, or a single `tile` image you slice in CSS). Fill the trim lane's filmstrip with them (count = about lane width / thumb width, height 56 px), cached per file path. While loading, show the existing empty lane; never fake frames.
- **Playback controls:** the playhead follows the video while it plays; clicking/dragging the lane seeks; playback loops inside the trim in/out range.
- **Keyboard:** Space toggles play/pause on Ready and Done (call `preventDefault` so the page does not scroll; ignore it while focus is in a text input). Keep I / O / Esc as they are. Left/Right arrows step one frame when paused.
- **Original / Interpolated switch on Ready:** before a job has run there is no interpolated video; show the source in both views and label the Interpolated side as "Preview after processing" rather than pretending.
- **Processing preview:** shows the latest frame through the asset URL (throttled to about 2 per second). No broken-image icon ever: hide the `<img>` until it has loaded.
- **Done:** both videos load and play in sync with Space.

## Must not change

Layout, spacing and styling of the screens (another task handles layout). Do not touch the review switcher bar or the frame-rate strip.
