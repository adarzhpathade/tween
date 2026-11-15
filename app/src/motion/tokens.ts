/**
 * Spring and motion tokens.
 * Ported from nook (src/lib/tokens.ts and src/lib/motionPresets.ts).
 */

export interface SpringSpec {
  response: number;
  damping: number;
}

export type MotionPresetKey = "smooth" | "lively" | "bouncy";

export interface MotionPreset {
  rows: [number, number];
  stagger: number;
  travel: [number, number];
  exit: number;
  glideW: [number, number];
  glideH: [number, number];
  flip: [number, number];
  lock: number;
  squash: number;
  endBump: number;
  rowScale: string;
  flipKick: number;
  pop: [number, number];
  popStagger: number;
  bW: [number, number];
  bH: [number, number];
  wind: number;
  enterKick: number;
  exitSquash: number;
  side: [[number, number], [number, number], number];
}

export const MOTION_PRESETS: Record<MotionPresetKey, MotionPreset> & {
  1: MotionPreset;
  2: MotionPreset;
  3: MotionPreset;
} = {
  smooth: {
    rows: [0.5, 0.72],
    stagger: 45,
    travel: [16, 6],
    exit: 170,
    glideW: [0.44, 0.78],
    glideH: [0.46, 0.8],
    flip: [0.46, 0.76],
    lock: 380,
    squash: 0,
    endBump: 60,
    rowScale: "0.96",
    flipKick: 0,
    pop: [0.42, 0.6],
    popStagger: 30,
    bW: [0.36, 0.55],
    bH: [0.42, 0.56],
    wind: 10,
    enterKick: 150,
    exitSquash: 70,
    side: [[0.5, 0.84], [0.46, 0.82], 560],
  },
  lively: {
    rows: [0.34, 0.55],
    stagger: 30,
    travel: [22, 8],
    exit: 120,
    glideW: [0.34, 0.58],
    glideH: [0.36, 0.55],
    flip: [0.34, 0.58],
    lock: 280,
    squash: 150,
    endBump: 140,
    rowScale: "0.96",
    flipKick: 0,
    pop: [0.32, 0.5],
    popStagger: 22,
    bW: [0.3, 0.48],
    bH: [0.34, 0.46],
    wind: 12,
    enterKick: 220,
    exitSquash: 110,
    side: [[0.4, 0.66], [0.36, 0.62], 480],
  },
  bouncy: {
    rows: [0.28, 0.4],
    stagger: 22,
    travel: [26, 10],
    exit: 90,
    glideW: [0.28, 0.42],
    glideH: [0.3, 0.38],
    flip: [0.28, 0.42],
    lock: 220,
    squash: 260,
    endBump: 230,
    rowScale: "0.92 1.14",
    flipKick: 140,
    pop: [0.26, 0.38],
    popStagger: 16,
    bW: [0.26, 0.38],
    bH: [0.28, 0.34],
    wind: 16,
    enterKick: 300,
    exitSquash: 160,
    side: [[0.32, 0.5], [0.3, 0.45], 420],
  },
  get 1() {
    return this.smooth;
  },
  get 2() {
    return this.lively;
  },
  get 3() {
    return this.bouncy;
  },
};

export const elastic = {
  maxStretch: 18,
  falloff: 70,
  pressScale: 1.08,
  dragThreshold: 3,
  iconZone: 40,
  tapInset: 6,
} as const;

export const spring = {
  snappy: {
    type: "spring" as const,
    stiffness: 800,
    damping: 42,
    mass: 1,
  },
  smooth: {
    type: "spring" as const,
    stiffness: 520,
    damping: 32,
    mass: 1,
  },
  settle: {
    type: "spring" as const,
    stiffness: 320,
    damping: 36,
    mass: 1,
  },
  bouncy: {
    type: "spring" as const,
    stiffness: 420,
    damping: 18,
    mass: 1,
  },
} as const;

export const tokens = {
  spring,
  elastic,
  motionPresets: MOTION_PRESETS,
} as const;
