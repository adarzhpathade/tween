export interface StorageInfo {
  tempDir: string;
  freeBytes: number;
  inUseBytes: number;
}

export interface SettingsDefaults {
  model: string;
  quality: number;
  outputFolder: string;
  keepAudio: boolean;
  sceneDetect: boolean;
}

const DEFAULTS_STORAGE_KEY = "tween_settings_defaults";

export const DEFAULT_SETTINGS: SettingsDefaults = {
  model: "rife-v4.26",
  quality: 18,
  outputFolder: "",
  keepAudio: true,
  sceneDetect: true,
};

export function loadSettingsDefaults(): SettingsDefaults {
  if (typeof window === "undefined" || !window.localStorage) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = localStorage.getItem(DEFAULTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        model: typeof parsed.model === "string" ? parsed.model : DEFAULT_SETTINGS.model,
        quality: typeof parsed.quality === "number" ? parsed.quality : DEFAULT_SETTINGS.quality,
        outputFolder: typeof parsed.outputFolder === "string" ? parsed.outputFolder : DEFAULT_SETTINGS.outputFolder,
        keepAudio: typeof parsed.keepAudio === "boolean" ? parsed.keepAudio : DEFAULT_SETTINGS.keepAudio,
        sceneDetect: typeof parsed.sceneDetect === "boolean" ? parsed.sceneDetect : DEFAULT_SETTINGS.sceneDetect,
      };
    }
  } catch {
    // fallback
  }

  // Backwards compatibility with previous individual localStorage keys if present
  const lastModel = localStorage.getItem("tween_last_model");
  const lastQuality = localStorage.getItem("tween_last_quality");
  return {
    ...DEFAULT_SETTINGS,
    model: lastModel || DEFAULT_SETTINGS.model,
    quality: lastQuality ? Number(lastQuality) : DEFAULT_SETTINGS.quality,
  };
}

export function saveSettingsDefaults(defaults: SettingsDefaults): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    localStorage.setItem(DEFAULTS_STORAGE_KEY, JSON.stringify(defaults));
    // Also sync last keys
    localStorage.setItem("tween_last_model", defaults.model);
    localStorage.setItem("tween_last_quality", String(defaults.quality));
  } catch {
    // ignore
  }
}

export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || isNaN(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const idx = Math.min(units.length - 1, Math.max(0, i));
  const val = bytes / Math.pow(1024, idx);
  if (idx === 0) return `${Math.round(val)} B`;
  return `${val >= 10 || idx > 2 ? val.toFixed(idx === 3 ? 0 : 1) : val.toFixed(1)} ${units[idx]}`.replace(
    /\.0 /,
    " ",
  );
}
