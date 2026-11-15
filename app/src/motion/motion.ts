import type { Transition } from "motion/react";
import { flushSync } from "react-dom";
import {
  MOTION_PRESETS,
  type MotionPreset,
  type MotionPresetKey,
  tokens,
} from "./tokens";

export type { MotionPreset, MotionPresetKey };
export { MOTION_PRESETS };

export type SpringPreset = "snappy" | "smooth" | "settle" | "bouncy";

export const snappy: Transition = tokens.spring.snappy;
export const smooth: Transition = tokens.spring.smooth;
export const settle: Transition = tokens.spring.settle;
/** Overshooting spring, reserved for bouncy reactions. */
export const bouncy: Transition = tokens.spring.bouncy;

export const instant: Transition = { duration: 0 };

export const springPresets = {
  snappy,
  smooth,
  settle,
  bouncy,
} as const;

export type ReduceMotionPreference = "system" | "on" | "off";

let reduceMotionPreference: ReduceMotionPreference = "system";

/**
 * Sets the module-level reduced motion preference ("system" | "on" | "off").
 * Defaults to "system".
 */
export function setReduceMotionPreference(pref: ReduceMotionPreference): void {
  reduceMotionPreference = pref;
}

/**
 * Returns the current module-level reduced motion preference.
 */
export function getReduceMotionPreference(): ReduceMotionPreference {
  return reduceMotionPreference;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Checks whether reduced motion is preferred, respecting the user override
 * ("on" | "off") or falling back to the system media query ("system").
 */
export function prefersReducedMotion(): boolean {
  if (reduceMotionPreference === "on") {
    return true;
  }
  if (reduceMotionPreference === "off") {
    return false;
  }
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Returns an instant transition when reduce-motion is active,
 * otherwise returns the requested spring preset or transition.
 */
export function getTransition(
  presetOrTransition: SpringPreset | Transition,
): Transition {
  if (prefersReducedMotion()) {
    return instant;
  }
  if (typeof presetOrTransition === "string") {
    return springPresets[presetOrTransition];
  }
  return presetOrTransition;
}

/**
 * Convenience helper to get a spring preset with reduce-motion awareness.
 */
export function getSpring(preset: SpringPreset): Transition {
  return getTransition(preset);
}

/**
 * Wraps any transition to return `instant` when reduced motion is preferred.
 */
export function withReducedMotion(transition: Transition): Transition {
  return prefersReducedMotion() ? instant : transition;
}

let activePresetKey: MotionPresetKey = "smooth";

/**
 * Sets the active motion preset ("smooth" | "lively" | "bouncy").
 */
export function setMotionPreset(preset: MotionPresetKey): void {
  if (preset in MOTION_PRESETS) {
    activePresetKey = preset;
  }
}

/**
 * Gets the current active motion preset key.
 */
export function getMotionPreset(): MotionPresetKey {
  return activePresetKey;
}

/**
 * Gets the configuration table for the active motion preset.
 */
export function getActiveMotionPreset(): MotionPreset {
  return MOTION_PRESETS[activePresetKey];
}

export interface SpringEaseResult {
  easing: string;
  duration: number;
}

const EASES = new Map<string, SpringEaseResult>();

/**
 * Simulates a mass-1 spring (k = (2π/response)², c = 4π·ζ/response) from 0 to 1
 * sampled at 60 Hz into a CSS linear() easing string. Cached per parameter pair.
 */
export function springEase(response: number, ratio: number): SpringEaseResult {
  const key = `${response}/${ratio}`;
  const cached = EASES.get(key);
  if (cached) return cached;

  const k = ((2 * Math.PI) / response) ** 2;
  const c = (4 * Math.PI * ratio) / response;
  let x = 0;
  let v = 0;
  const to = 1;

  const pts: number[] = [0];
  const dt = 1 / 600;
  let t = 0;
  let next = 1 / 60;

  while (t < 2) {
    const a = -k * (x - to) - c * v;
    v += a * dt;
    x += v * dt;
    t += dt;
    if (t >= next) {
      pts.push(Number(x.toFixed(4)));
      next += 1 / 60;
      const atRest = Math.abs(x - to) < 0.01 && Math.abs(v) < 0.05;
      if (atRest) break;
    }
  }
  pts[pts.length - 1] = 1;

  const duration = Math.round(((pts.length - 1) / 60) * 1000);
  const res: SpringEaseResult = {
    easing: `linear(${pts.join(", ")})`,
    duration,
  };
  EASES.set(key, res);
  return res;
}

/**
 * Animates an element using a CSS linear() spring simulation easing curve.
 */
export function springAnim(
  el: HTMLElement,
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
  response: number,
  ratio: number,
  extra: KeyframeAnimationOptions = {},
): Animation {
  if (typeof el.animate !== "function") {
    return {
      cancel: () => {},
      finished: Promise.resolve(),
    } as unknown as Animation;
  }
  if (prefersReducedMotion()) {
    return el.animate(
      Array.isArray(keyframes)
        ? [{ opacity: 0 }, { opacity: 1 }]
        : { opacity: [0, 1] },
      {
        duration: 120,
        easing: "ease-out",
        fill: "backwards",
        ...extra,
      },
    );
  }
  const e = springEase(response, ratio);
  return el.animate(keyframes, {
    duration: e.duration,
    easing: e.easing,
    ...extra,
  });
}

/** Elements that FLIP inside a container. */
const FLIP_SELECTOR =
  ".row, .btn, .card-btn, [data-flip]";

export interface FlipSnapshot {
  box0: DOMRect;
  before: Map<Element, DOMRect>;
}

/**
 * Captures positions of row/button elements before a layout change.
 */
export function measureFlip(root: HTMLElement): FlipSnapshot {
  const box0 = root.getBoundingClientRect();
  const before = new Map<Element, DOMRect>();
  for (const e of root.querySelectorAll(FLIP_SELECTOR)) {
    if ((e as HTMLElement).offsetParent !== null) {
      before.set(e, e.getBoundingClientRect());
    }
  }
  return { box0, before };
}

/**
 * Plays spring FLIP animations from a previously captured snapshot.
 */
export function playFlip(
  root: HTMLElement,
  snapshot: FlipSnapshot,
  engine?: {
    glide?: (dir?: 1 | -1 | 0) => void;
    bump?: (b: { w?: number; h?: number }) => void;
  } | null,
): void {
  if (prefersReducedMotion()) return;
  const mo = getActiveMotionPreset();
  const { box0, before } = snapshot;

  if (mo.flipKick && engine?.bump) {
    engine.bump({ h: mo.flipKick, w: -mo.flipKick * 0.5 });
  }

  const box1 = root.getBoundingClientRect();
  for (const e of root.querySelectorAll(FLIP_SELECTOR)) {
    const el = e as HTMLElement;
    if (el.offsetParent === null) continue;
    const a = el.getBoundingClientRect();
    const b = before.get(el);
    if (!b) {
      springAnim(
        el,
        [
          { opacity: 0, scale: 0.8, filter: "blur(4px)" },
          { opacity: 1, scale: 1, filter: "blur(0px)" },
        ],
        mo.flip[0],
        mo.flip[1],
      );
      continue;
    }
    const dx = b.left - box0.left - (a.left - box1.left);
    const dy = b.top - box0.top - (a.top - box1.top);
    if (Math.abs(dx) + Math.abs(dy) < 0.5) continue;
    springAnim(
      el,
      [{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }],
      mo.flip[0],
      mo.flip[1],
    );
  }
}

/**
 * Animates layout changes of rows/buttons within a container using FLIP.
 */
export function flipCard(
  root: HTMLElement,
  change: () => void,
  engine?: {
    glide?: (dir?: 1 | -1 | 0) => void;
    bump?: (b: { w?: number; h?: number }) => void;
  } | null,
): void {
  if (prefersReducedMotion()) {
    change();
    return;
  }
  const snapshot = measureFlip(root);
  engine?.glide?.();
  if (typeof flushSync === "function") {
    flushSync(() => {
      change();
    });
  } else {
    change();
  }
  playFlip(root, snapshot, engine);
}
