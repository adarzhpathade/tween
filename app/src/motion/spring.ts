/**
 * A damped spring with mass 1, in Apple's parameters: `response` is the
 * period of the undamped oscillation in seconds and `damping` the damping
 * ratio (1 = critically damped, below 1 overshoots).
 *
 *   stiffness = (2π / response)²      damping coefficient = 4π · ζ / response
 *
 * Retargeting (`to = …`) keeps the current position and velocity, so a spring
 * interrupted mid-flight carries its momentum into the new motion. Integration
 * is semi-implicit Euler; callers split a frame into substeps.
 *
 * Ported from nook (src/features/island/engine/spring.ts).
 */
import type { SpringSpec } from "./tokens";

export interface RestThreshold {
  /** Distance from the target (same unit as x). */
  x: number;
  /** Speed (units per second). */
  v: number;
}

export const DEFAULT_REST: RestThreshold = { x: 0.01, v: 0.05 };

export type SpringParam = SpringSpec | [number, number];

export function stiffnessOf(spec: SpringParam): number {
  const response = Array.isArray(spec) ? spec[0] : spec.response;
  return ((2 * Math.PI) / response) ** 2;
}

export function dampingOf(spec: SpringParam): number {
  const response = Array.isArray(spec) ? spec[0] : spec.response;
  const damping = Array.isArray(spec) ? spec[1] : spec.damping;
  return (4 * Math.PI * damping) / response;
}

export class Spring {
  x: number;
  v = 0;
  to: number;
  private k = 0;
  private c = 0;

  constructor(
    x: number,
    spec: SpringParam,
    private readonly rest: RestThreshold = DEFAULT_REST,
  ) {
    this.x = x;
    this.to = x;
    this.tune(spec);
  }

  get stiffness(): number {
    return this.k;
  }

  get damping(): number {
    return this.c;
  }

  /** Change the feel; position, velocity and target are kept. */
  tune(spec: SpringParam): void {
    this.k = stiffnessOf(spec);
    this.c = dampingOf(spec);
  }

  /** Advance by `dt` seconds (semi-implicit Euler: velocity first). */
  step(dt: number): void {
    const a = -this.k * (this.x - this.to) - this.c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
  }

  get atRest(): boolean {
    return (
      Math.abs(this.x - this.to) < this.rest.x && Math.abs(this.v) < this.rest.v
    );
  }

  /** Land exactly on the target (so nothing renders between pixels at rest). */
  snap(): void {
    this.x = this.to;
    this.v = 0;
  }

  /** Go to a value at once, with no motion (reduced motion, first paint). */
  jump(to: number): void {
    this.to = to;
    this.snap();
  }
}

/** Advance every spring by `dt`, split into `substeps` equal steps. */
export function stepAll(
  springs: readonly Spring[],
  dt: number,
  substeps: number,
): void {
  const h = dt / substeps;
  for (let i = 0; i < substeps; i++) {
    for (const s of springs) {
      s.step(h);
    }
  }
}

/** True when every spring is at rest; if so, each is snapped to its target. */
export function settleAll(springs: readonly Spring[]): boolean {
  if (!springs.every((s) => s.atRest)) return false;
  for (const s of springs) s.snap();
  return true;
}
