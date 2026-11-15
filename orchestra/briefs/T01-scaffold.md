## Goal

Create the Tauri 2 project that will replace the Electron prototype. Structure only, no features.

## Build

- `app/` folder containing a Tauri 2 + React 18 + TypeScript + Vite project (`npm create tauri-app` layout is fine, but keep it minimal).
- `app/package.json` scripts: `dev` (vite), `build` (tsc -b && vite build), `typecheck` (tsc --noEmit), `tauri` (tauri CLI).
- Product name **Tween**, identifier `app.tween.desktop`, window 1280×820, min 1040×700, `decorations: false` (the design draws its own title bar), dark background `#0b0b0b` so there is no white flash.
- Rust crate in `app/src-tauri` named `tween`. Create empty modules `setup`, `pipeline`, `remotezip` (each `mod.rs` with a doc comment saying which `src/lib/*.js` file it will port) so later tasks only fill them in.
- Register one command `app_version` that returns the crate version, and call it from the React app so the IPC path is proven.
- `app/src/main.tsx` renders a placeholder `App` that shows "Tween" and the version. No styling work: that is T04.
- Add `.gitignore` entries for `app/node_modules`, `app/dist`, `app/src-tauri/target`.
- Commit `app/package-lock.json`.

## Notes

- Do not add UI libraries (no Tailwind, no component kits). T04 builds the design system from the mock.
- Tauri capabilities: only what is needed now (core, dialog will be added later).
