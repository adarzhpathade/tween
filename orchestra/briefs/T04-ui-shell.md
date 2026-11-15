## Goal

Build the app shell and design system from the approved mock, plus the motion layer. No screen content yet beyond the shell.

## Source of truth

`design/app-design-v7-onboarding-v3.html`. Open it, read its CSS variables and layout. Copy exact values (colours such as `--acc #a9b79a` and clay `#c9907a`, near-black background, hairline borders, spacing, font sizes, Geist / Geist Mono). The mock's `?state=` and `?step=` URL params show every screen.

## Build

- `app/src/styles/tokens.css`: every CSS variable from the mock, unchanged names where practical.
- Fonts: Geist and Geist Mono from the `geist` npm package, bundled (no CDN).
- `app/src/shell/`: custom title bar (drag region, window controls minimise/maximise/close via the Tauri window API, styled exactly like the mock), main grid, and a simple screen router with screens `onboarding | ready | processing | done` (placeholders for now).
- **Motion** in `app/src/motion/`, ported from the user's own project **nook** at `E:\Projects\Products\nook` (read it; do not edit it):
  - `src/lib/motion.ts`: spring presets, `springEase()` (spring simulated into a CSS `linear()` easing), `springAnim()`, FLIP helpers, reduced-motion handling.
  - `src/features/island/engine/spring.ts` + `loop.ts`: damped spring with `response`/`damping`, retargeting keeps velocity, rAF loop that runs only while moving.
  - `src/lib/tokens.ts`: spring and elastic values.
  If that path is not readable, implement the same API from this description and say so in your summary.
- Respect `prefers-reduced-motion` everywhere.
- Screen transitions use the spring helpers (short, subtle; the mock's own transitions show the intended feel).

## Rules

- No icons or dots except the ones the mock keeps: window controls, toggle switch, playhead, onboarding check tick and spinner.
- Do not add a UI kit or Tailwind.
