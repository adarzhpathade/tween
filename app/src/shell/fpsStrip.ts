export const MAX_FPS = 240;

export interface FpsRow {
  key: string;
  label: string;
  sublabel: string;
  fps: number | null;
  multiplier?: number;
  isCustom?: boolean;
  disabled?: boolean;
  title?: string;
}

export function formatFps(fps: number): string {
  const rounded = Math.round(fps * 100) / 100;
  return String(rounded);
}

export function getFpsFontSize(val: number | string | null | undefined): number {
  if (val === null || val === undefined) return 46;
  const str = typeof val === "number" ? formatFps(val) : String(val).trim();
  const len = str.length;
  if (len <= 3) return 46;
  if (len <= 5) return 30;
  return 24;
}

export function stepFpsAnimation(from: number, to: number, progress: number): number {
  if (progress >= 1) return to;
  if (progress <= 0) return Math.round(from);
  const p = Math.min(1, Math.max(0, progress));
  const e = 1 - Math.pow(1 - p, 3);
  return Math.round(from + (to - from) * e);
}

export function computeMinCustomFps(sourceFps: number | null): number {
  return sourceFps ? Math.floor(sourceFps) + 1 : 1;
}

export function computeFpsRows(
  sourceFps: number | null,
  customFps: number | null
): FpsRow[] {
  if (!sourceFps) {
    return [
      { key: "2×", label: "2×", sublabel: "Double", fps: null, multiplier: 2 },
      { key: "3×", label: "3×", sublabel: "Triple", fps: null, multiplier: 3 },
      { key: "4×", label: "4×", sublabel: "Quad", fps: null, multiplier: 4 },
      { key: "60", label: "60", sublabel: "fps", fps: 60 },
      { key: "120", label: "120", sublabel: "fps", fps: 120 },
      { key: "Custom", label: "Custom", sublabel: "fps", fps: null, isCustom: true },
    ];
  }

  // 1. Multipliers 2×, 3×, 4×
  const multRows: FpsRow[] = [2, 3, 4].map((m) => {
    const f = sourceFps * m;
    const disabled = f > MAX_FPS;
    return {
      key: `${m}×`,
      label: `${m}×`,
      sublabel: `${formatFps(f)} fps`,
      fps: f,
      multiplier: m,
      disabled,
      title: disabled ? "Above 240 fps" : undefined,
    };
  });

  // 2. Fixed targets from [60, 120, 144, 240]
  // Keep only targets greater than sourceFps, at most 240, and not equal to any multiplier result
  const taken = new Set(multRows.map((r) => Math.round(r.fps!)));
  const fixedTargets = [60, 120, 144, 240]
    .filter((t) => t > sourceFps && t <= MAX_FPS && !taken.has(t))
    .slice(0, 2);

  const fixedRows: FpsRow[] = fixedTargets.map((t) => ({
    key: String(t),
    label: String(t),
    sublabel: "fps",
    fps: t,
  }));

  // 3. Custom row
  const customRow: FpsRow = {
    key: "Custom",
    label: "Custom",
    sublabel: customFps !== null ? `${customFps} fps` : "fps",
    fps: customFps,
    isCustom: true,
  };

  return [...multRows, ...fixedRows, customRow];
}

export interface CustomFpsHint {
  text: string;
  isError: boolean;
  v?: number;
}

export function getCustomFpsHint(
  str: string,
  sourceFps: number | null
): CustomFpsHint {
  const s = str.trim();
  const minF = computeMinCustomFps(sourceFps);
  if (s === "") {
    return { text: "NUMBER", isError: true };
  }
  const v = Number(s);
  if (isNaN(v)) {
    return { text: "NUMBER", isError: true };
  }
  if (v < minF) {
    return { text: `MIN ${minF}`, isError: true, v };
  }
  if (v > MAX_FPS) {
    return { text: `MAX ${MAX_FPS}`, isError: true, v };
  }
  return { text: `${minF}\u2013${MAX_FPS} FPS`, isError: false, v };
}

export function checkCustomVal(
  str: string,
  sourceFps: number | null
): { v?: number; err?: string } {
  const hint = getCustomFpsHint(str, sourceFps);
  if (hint.isError) {
    return hint.v !== undefined ? { v: hint.v, err: hint.text } : { err: hint.text };
  }
  return { v: hint.v };
}

export function clampCustomVal(
  val: number | undefined,
  sourceFps: number | null,
  fallbackVal: number | null = null
): number {
  const minF = computeMinCustomFps(sourceFps);
  const base = val === undefined ? (fallbackVal ?? minF) : val;
  return Math.min(MAX_FPS, Math.max(minF, base));
}
