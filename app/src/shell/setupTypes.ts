export interface OsGpu {
  name: string;
  driver?: string;
  vendor: string;
}

export interface GpuDevice {
  id: number;
  name: string;
  vendor: string;
  integrated: boolean;
  ok?: boolean;
  ms?: number;
}

export interface SetupConfig {
  platform: string;
  arch: string;
  checkedAt: string;
  freeBytes?: number;
  osGpus: OsGpu[];
  ffmpeg?: string;
  ffprobe?: string;
  rifeDir?: string;
  models?: string[];
  mode?: string;
  gpu?: GpuDevice;
  devices?: GpuDevice[];
  encoders?: string[];
  pathsExist?: boolean;
}

export interface SetupProgressEvent {
  id: string;
  label: string;
  state: "checking" | "installing" | "ok" | "warn" | "error" | "missing" | string;
  detail: string;
  progress?: number | null;
  link?: string | null;
}

export interface SetupResult {
  ok: boolean;
  cfg: SetupConfig;
}
