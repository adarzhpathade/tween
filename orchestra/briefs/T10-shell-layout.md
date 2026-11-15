## Goal

The real app must look like an app, not like the HTML mock. Two problems from the user's screenshots.

## 1. Remove the mock's review switcher

The bar at the bottom ("SCREEN · Onboarding · Ready · Processing · Done", `.router-switcher` in `app/src/shell/ScreenRouter.tsx`) is the design mock's review tool. It must not exist in the app. Also remove the 1–4 number-key screen shortcuts. Screens change only through the real flow: onboarding → Ready → Processing → Done → Ready.

You may keep a developer-only switcher behind `import.meta.env.DEV && ?mock=1`, never shown otherwise.

## 2. Fill the window at any size

Today the sizes are copied from the mock's fixed 1280×740 window:
- Onboarding uses only the top part of the window, with a large empty area below.
- At smaller widths, the Ready screen's right side (frame-rate strip and settings panel) is clipped off the edge.

Fix:
- The app root fills the whole window (`100vw × 100vh`, no page scroll, no horizontal overflow at any size from the minimum window 1040×700 up to 2560×1440).
- **Onboarding:** content uses the full height. Keep the mock's proportions and keep the Welcome page's timeline graphic and footer pinned sensibly (the footer row at the bottom, content vertically balanced). Scale type and spacing with `clamp()` so it looks right from 1040×700 to full-screen 1920×1080.
- **Ready / Processing / Done:** grid columns are `minmax()`-based. The stage (video) shrinks first, then the settings panel; the frame-rate strip keeps its width. If the window is too short, only the settings panel scrolls (with a subtle scrollbar), never the whole window.
- The status bar stays at the bottom edge.
- The title bar shows the window controls on every screen (as the first screenshot already does).

## Evidence required

Run the Vite dev server and take screenshots with headless Edge (Windows: `msedge.exe --headless=new --disable-gpu --hide-scrollbars --window-size=W,H --virtual-time-budget=1500 --screenshot=out.png "http://localhost:1420/?mock=1&screen=..."`; add a `screen` URL parameter to the DEV-only mock path if needed) at **1040×700, 1280×820 and 1920×1080** for Onboarding (page 1), Ready (loaded) and Processing. Save them to `.tween-task/screens/` and list them in your summary with one line each on what you checked. Do not commit the screenshots.

## Must not change

Colours, type choices, the content of the screens, the frame-rate strip's options and behaviour, or anything about video playback (another task does that). Keep `design/` untouched.
