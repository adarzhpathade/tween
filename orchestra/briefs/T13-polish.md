## Goal

Fix four problems the user found in the running app. The window-button permissions are already fixed on main (`capabilities/default.json`); do not touch that file.

## 1. Frame-rate counter shows numbers like `176.46` that overflow the strip

Root cause, found in review: `ReadyScreen.tsx` animates `displayFps` with fractional values (`from + (to - from) * e`), and `formatFps` prints up to two decimals. Mid-animation, and whenever the animation is cancelled by a re-render, the counter shows or keeps a fractional number like `176.46`. That is wider than the 103 px strip.

Fix:
- While animating, show whole numbers only (`Math.round`). Always end exactly on the target value, including when the effect is cleaned up or re-run (on cleanup, cancel the frame and set the final value).
- The counter's number must always fit the strip. Choose the font size from the character count of the final value: 1–3 characters use the current size, 4–5 a smaller size, 6 or more smaller again. Do it by measuring or by fixed steps; the rule is never to clip and never to wrap.
- Non-integer sources (23.976, 29.97, 59.94) show at most two decimals in the final value, using the same fitting rule.
- The sliding selection pill must line up exactly with the selected row after any resize, maximize or row-count change. In the user's screenshot it sat a few px above the 3× row, leaving a white bar. Recompute it with a `ResizeObserver` on the strip.

## 2. The custom fps hint sits over the video

The hint tab (`Enter to apply · Esc to cancel · 61–240`) sticks out over the preview, and the user does not like it there. Move it inside the strip, directly under the counter's `FPS` label, as two short centered lines in the small mono label style: `Enter apply · Esc cancel`, then `61–240`. On error, the second line shows the reason in clay. It must not overflow the 103 px strip, and the rows below must not jump when it appears (reserve its space inside the counter cell, or overlay it within the cell). Also remove the native text-selection highlight box behind the number while editing (`::selection` styled or no select-all on focus).

## 3. Original / Interpolated switch text missing

In the user's screenshot the switch at the bottom of the preview shows `ORIGINAL 60 FPS`, and the right half is empty or illegible. The "Preview after processing" text is not visible. Make both halves readable on one line, styled like the mock's switch, at every window size.

## 4. Onboarding layout

Today the Welcome content is vertically centered, with a big empty gap above it. Change it as follows:
- Text (eyebrow, headline, paragraph) at the **top**, starting right under the WELCOME/SKIP row.
- The visual (the TIMELINE graphic with its fps label) at the **bottom**, just above the footer row.
- Consistent margins from the window edges: use the same horizontal padding as now, about `clamp(28px, 4vw, 56px)`, top and bottom.
- Apply the same top/bottom structure to the other onboarding pages: content at the top, the check grid or visual at the bottom, the footer pinned.

## 5. Window size

- Set `tauri.conf.json` to a default window of 1280×820, centered, with **minimum 1180×740**, so the app cannot be made smaller than a size where everything fits.
- Make sure nothing clips at exactly 1180×740. In the user's screenshot the model cards' text was cut off ("Newest RIFE model. Th...").
- Make sure maximize (Windows snap and double-click on the title bar) gives a correct full layout.

## Evidence

- Unit tests: the counter formatting and fitting rule, and that the animation ends on the exact value.
- Headless Edge screenshots (`?mock=1`, the same command as T10) in `.tween-task/screens/`:
  - Ready at 1180×740 and 1920×1080 with src 60 and 3× selected.
  - Custom editing at src 60.
  - Onboarding Welcome at 1180×740 and 1920×1080.
  - List them in your summary.

## Must not change

The accent colour (another task changes it). Keep `design/` untouched.
