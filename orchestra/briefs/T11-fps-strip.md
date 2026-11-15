## Goal

Build the frame-rate strip and the Custom fps input exactly as the user approved them in `design/app-design-v7-onboarding-v3.html`. Read the mock's markup, CSS and JS for the strip (`#fseg`, the counter with `#fpsFrom`, `#fpsTo` and `#fpsIn`, the steppers, `#fpsHint`, and the fps selector script). Preview it in a browser with `?state=ready&src=24|30|60`, `&custom=edit&customval=90`, and `&custom=applied&customval=90`.

## Behaviour (approved by the user)

- **Options adapt to the real source fps** from `probe_video`:
  - Always show the multipliers 2×, 3× and 4×, each with its result fps.
  - Then show up to two fixed targets, taken in order from [60, 120, 144, 240]. Keep only targets greater than the source fps, at most 240, and not equal to any multiplier result.
  - Then show Custom.
  - Examples: 24 fps gives 48 / 72 / 96 / 60 / 120 / Custom. 60 fps gives 120 / 180 / 240 / 144 / Custom.
- The remaining rows share the height evenly; the strip never has a gap.
- Multipliers above 240 fps are dimmed and disabled, with `title="Above 240 fps"`.
- Non-integer sources (23.976, 29.97, 59.94) must work: show the result rounded to two decimals at most. Send the exact rational to the backend, as T03's `ratio` expects.
- **Custom input** lives inside the big counter:
  - Type in big mono digits, using up/down steppers, Arrow keys (±1) and Shift+Arrow (±10), or drag vertically to scrub.
  - The hint reads `Enter to apply · Esc to cancel · <src+1>–240`. Keep the mock's placement: a hairline tab to the left of the counter, over the preview, while editing.
  - Out of range: the number, underline and hint turn clay `#c9907a` with the reason (for example `Must be above 60`).
  - **Enter applies at once. If the value is invalid, it is corrected to the nearest valid value and applied directly.** This is the user's decision, and the mock already does it.
  - Esc or clicking outside cancels.
  - After apply, the Custom row reads `Custom · 90 FPS` and is selected, and the counter does a small spring bounce.
- The selected target feeds the job request and the estimates (frames, time, size), and persists as the last choice, as T06 already does.
- Remove the old improvised custom-fps box completely.

## Must not change

Anything outside the strip and its counter: video playback, layout, and the settings panel are other tasks.
