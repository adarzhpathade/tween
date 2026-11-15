/**
 * Animation loop: a requestAnimationFrame chain that runs only while some
 * spring is moving. kick() starts it; it stops by itself once every spring is
 * at rest, after snapping them to their exact targets and painting that final frame.
 * Nothing runs per frame at rest.
 *
 * Ported from nook (src/features/island/engine/loop.ts).
 */
import { type Spring, settleAll, stepAll } from "./spring";

export interface FrameHost {
  request(cb: (now: number) => void): number;
  cancel(handle: number): void;
  now(): number;
}

const browserHost: FrameHost = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (h) => cancelAnimationFrame(h),
  now: () => performance.now(),
};

export interface LoopOptions {
  springs: readonly Spring[];
  /** Writes the current spring values to the DOM. Called once per frame. */
  paint: () => void;
  /** Longest step integrated per frame (s). */
  maxStep: number;
  substeps: number;
  host?: FrameHost;
}

export interface Loop {
  /** Start the loop if it is not running. Call after changing a target or velocity. */
  kick(): void;
  readonly running: boolean;
  /** Stop without settling (teardown). */
  stop(): void;
}

export function createLoop({
  springs,
  paint,
  maxStep,
  substeps,
  host = browserHost,
}: LoopOptions): Loop {
  let handle = 0;
  let last = 0;

  function frame(now: number) {
    const dt = Math.min(maxStep, Math.max(0, (now - last) / 1000));
    last = now;
    stepAll(springs, dt, substeps);
    handle = settleAll(springs) ? 0 : host.request(frame);
    paint();
  }

  return {
    kick() {
      if (handle) return;
      last = host.now();
      handle = host.request(frame);
    },
    get running() {
      return handle !== 0;
    },
    stop() {
      if (handle) host.cancel(handle);
      handle = 0;
    },
  };
}
