## Goal

The user chose a new accent colour: **amber**. Apply it to the whole app, and remove the glow around the trim timeline, exactly as in the approved mock `design/app-design-v7-onboarding-v3.html` (its `:root` now has `--acc:#d9a55b; --acc-rgb:217,165,91; --acc-ink:#111`).

## Do

1. **Accent goes through variables everywhere.**
   - In `app/src/styles/tokens.css`, set `--acc: #d9a55b`, `--acc-rgb: 217,165,91` and `--acc-ink: #111`.
   - Replace every hard-coded sage literal in `app/src` (`#a9b79a`, its 8-digit alpha forms such as `#a9b79a30`, and `rgba(169,183,154,…)`) with `var(--acc)` or `rgba(var(--acc-rgb), α)`, keeping the same alpha.
   - Afterwards `grep -rni "a9b79a\|169, *183, *154" app/src` must find nothing.
2. **The warning colour becomes redder**, so a warning is never mistaken for amber. Clay `#c9907a` / `rgba(201,144,122,…)` becomes `#e0695a` / `rgba(224,105,90,…)`. Route it through `--warn` and `--warn-rgb` the same way. Afterwards a grep for `c9907a` finds nothing.
3. **Remove the trim lane glow.** In `app/src/styles/screens.css`, the `.sel` rule at about line 327 has `box-shadow: 0 0 24px -6px var(--acc)`. Remove that box-shadow, and remove any other glow, blur shadow or `filter: drop-shadow` on the trim lane or its handles. Keep the 2 px top/bottom amber border and the faint fill. Do not remove glows elsewhere: the progress bar and the onboarding timeline keep their look.
4. Text drawn on accent fills uses `var(--acc-ink)`.
5. Check the Tauri window background and any SVG/canvas drawing (the onboarding timeline, the waveform and thumbnails lane, the progress bars) for colours set in JS, and route them through the CSS variables too (read with `getComputedStyle(document.documentElement)`).

## Evidence

Headless Edge screenshots (`?mock=1`), saved in `.tween-task/screens/` and listed in your summary:
- Ready at 1280×820
- Custom fps invalid state
- Onboarding Welcome and System check
- Processing
- Done
- Settings open

Also give the grep outputs from steps 1 and 2.

## Must not change

Layout, sizes, behaviour, and anything T13 changed. This is a colour-only task. Keep `design/` untouched.
