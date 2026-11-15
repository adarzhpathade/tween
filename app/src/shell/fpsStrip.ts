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

export function checkCustomVal(
  str: string,
  sourceFps: number | null
): { v?: number; err?: string } {
  const s = str.trim();
  if (s === "") return { err: "Enter a number" };
  const v = Number(s);
  if (isNaN(v)) return { err: "Enter a number" };
  const minF = computeMinCustomFps(sourceFps);
  if (v < minF) {
    return { v, err: `Must be above ${sourceFps ? formatFps(sourceFps) : 0}` };
  }
  if (v > MAX_FPS) {
    return { v, err: `Must be ${MAX_FPS} or less` };
  }
  return { v };
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
