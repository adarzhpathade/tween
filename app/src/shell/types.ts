export type Screen = "onboarding" | "ready" | "processing" | "done";

export interface ScreenContextValue {
  screen: Screen;
  setScreen: (screen: Screen) => void;
  title: string;
  setTitle: (title: string) => void;
}

export const SCREEN_TITLES: Record<Screen, string> = {
  onboarding: "Welcome",
  ready: "Tween",
  processing: "Processing",
  done: "Finished",
};

export interface ColourInfo {
  matrix: string;
  range: string;
  space: string;
  primaries: string;
  trc: string;
  hdr: boolean;
}

export interface ProbeInfo {
  file: string;
  name: string;
  width: number;
  height: number;
  codec: string;
  pixFmt: string;
  fpsNum: number;
  fpsDen: number;
  fps: number;
  vfr: boolean;
  duration: number;
  frames: number;
  hasAudio: boolean;
  audioCodec?: string | null;
  colour: ColourInfo;
  size: number;
}

export interface Target {
  mode: "multiplier" | "fps" | string;
  value: number;
}

export interface Trim {
  start: number;
  end: number;
}

export interface JobRequest {
  info: ProbeInfo;
  target: Target;
  model: string;
  encoder: string;
  quality?: number;
  keepAudio?: boolean;
  output: string;
  tempRoot?: string;
  trim?: Trim;
}

export interface JobProgressEvent {
  stage: "analyse" | "interpolate" | "encode" | "done" | string;
  pct?: number;
  done?: number;
  total?: number;
  speed?: number;
  eta?: number;
  preview?: string;
  note?: string;
}

export interface JobFinished {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  output?: string;
  seconds?: number;
  outSize?: number;
  frames?: number;
  cuts?: number;
}

export interface SystemStats {
  gpuUsage?: number | null;
  gpuMemoryUsed?: number | null;
  gpuMemoryTotal?: number | null;
  gpuTemperature?: number | null;
  cpuUsage?: number | null;
  cpuThreads?: number | null;
  ramUsed?: number | null;
  ramTotal?: number | null;
}
