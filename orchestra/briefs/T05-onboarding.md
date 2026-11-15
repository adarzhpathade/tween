## Goal

The three onboarding pages from the mock (`?state=empty`, `?step=0|1|2`, `&allow=1`, `?missing=1`), wired to the real setup commands from T02.

## Behaviour

- **Page 1, Welcome**: as in the mock, including its welcome motion (re-create with the T04 spring helpers).
- **Page 2, System check**: one card per setup item (`system, gpu, ffmpeg, engine, accel, encoder`). On entering the page call `setup_run { install: true }` and update cards live from `setup-progress` events: spinner while `checking`/`installing` (with a progress bar and MB count when `progress` is set), tick for `ok`, clay warning style for `warn`, error style with a Retry button for `error`. If an item has a `link` (graphics driver), show a button that opens it in the browser.
  The user should not have to do anything on a normal machine: everything missing downloads by itself. "Continue" enables once `setup_run` returns `ok: true`. A `warn` (for example CPU mode) does not block, but its text stays visible.
- **Page 3, Permissions**: as in the mock. Only show items Tween really needs (choosing output folders). Do not invent permission prompts the OS does not have.
- Finish goes to the Ready screen with no video loaded (as in the mock).
- On later launches, if `setup_config` returns a saved config, skip onboarding. If the saved paths no longer exist, show page 2 again.
- Copy: use the mock's wording. Where real results replace demo data (GPU names, sizes), keep the same format.
