## Goal

Build two simplifications that the user approved in `design/app-design-v7-onboarding-v3.html`. They are in the CSS block marked `/* simplify (user review) */` at the end of `<style>`, and in `paintHint()`. Preview them with `?state=open` and `?state=ready&src=60&custom=edit&customval=90` (also `customval=50` and `customval=300`).

## 1. Drop zone (empty Ready screen)

- No dot-grid background, in any state. Remove every `radial-gradient` dot pattern on the drop zone, including the one on hover/drag-over.
- No corner marks.
- A plain `var(--bg2)` panel with a 1 px dashed `var(--line2)` border.
- On hover or drag-over: the border becomes amber at about 55% (`rgba(var(--acc-rgb), .55)`) and the background gets a faint amber tint (`rgba(var(--acc-rgb), .03)`).
- Keep the text, the button and their spacing as they are.

## 2. Custom fps editing in the counter

- **No underline under the number while editing** (the user asked for this). Remove the amber bottom border from the custom input, in both the normal and the invalid state, and do not replace it with another line. An invalid value is shown only by the number and the hint line turning `var(--warn)`.
- Remove the up/down stepper buttons completely: markup, CSS and handlers. Arrow Up/Down (±1), Shift+Arrow (±10) and vertical drag on the number keep working.
- While editing, the `FPS` label under the number is replaced by **one** short line in the same small mono label style:
  - Valid value: `<min>–240 FPS` (for example `61–240 FPS`), muted.
  - Below the minimum: `MIN <min>`, in `var(--warn)`.
  - Above 240: `MAX 240`, in `var(--warn)`.
  - Empty or not a number: `NUMBER`, in `var(--warn)`.
- Remove the old two-line hint (`Enter apply · Esc cancel`, `61–240`).
- The line must fit the 103 px strip without wrapping or clipping. The rows below must not move when editing starts.
- Make the text-selection highlight behind the number subtle (`::selection` at `rgba(var(--acc-rgb), .25)`), or do not select all on focus. Pick whichever looks cleaner and say which.
- Enter still corrects an invalid value and applies it at once, and Esc or clicking outside still cancels.

## Evidence

- Headless Edge screenshots (`?mock=1`, same command as before) in `.tween-task/screens/`, listed in your summary:
  - Empty Ready
  - Custom editing at 90, 50 and 300 with src 60
- Update the unit tests for the hint text rule.

## Must not change

- Anything else. In particular, keep the fix in `ReadyScreen.tsx` that re-measures the Original/Preview switch (`data-pill`) and its CSS fallback in `screens.css`.
- Keep `design/` untouched.
