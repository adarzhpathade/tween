import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useScreen } from "../ScreenRouter";
import type { Screen } from "../types";

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
  ffmpeg?: string;
  ffprobe?: string;
  rifeDir?: string;
  models?: string[];
  mode?: string;
  gpu?: GpuDevice;
  encoders?: string[];
}

export interface ModelCard {
  id: string;
  name: string;
  desc: string;
  badge?: string;
  default?: boolean;
}

const KNOWN_MODELS: ModelCard[] = [
  {
    id: "rife-v4.26",
    name: "Smooth",
    desc: "Newest RIFE model. The best choice for most videos.",
    badge: "Recommended",
    default: true,
  },
  {
    id: "rife-v4.25-heavy",
    name: "Detail",
    desc: "Bigger model. Cleaner edges in fast motion, about 2 to 3 times slower.",
    badge: "Heavy",
    default: false,
  },
  {
    id: "rife-v4.22-lite",
    name: "Fast",
    desc: "Light model for older or integrated GPUs.",
    badge: "Fast",
    default: false,
  },
];

const ENCODER_NAMES: Record<string, string> = {
  hevc_nvenc: "H.265 · NVENC",
  h264_nvenc: "H.264 · NVENC",
  hevc_amf: "H.265 · AMF",
  h264_amf: "H.264 · AMF",
  hevc_qsv: "H.265 · Intel QSV",
  h264_qsv: "H.264 · Intel QSV",
  hevc_videotoolbox: "H.265 · Apple Silicon",
  h264_videotoolbox: "H.264 · Apple Silicon",
  libx265: "H.265 · CPU",
  libx264: "H.264 · CPU",
};

const MOCK_SAMPLE_PROBE: ProbeInfo = {
  file: "beach_sunset_24fps.mp4",
  name: "beach_sunset_24fps.mp4",
  width: 1920,
  height: 1080,
  codec: "H.264",
  pixFmt: "yuv420p",
  fpsNum: 24,
  fpsDen: 1,
  fps: 24,
  vfr: false,
  duration: 42.0,
  frames: 1008,
  hasAudio: true,
  audioCodec: "AAC",
  colour: {
    matrix: "bt709",
    range: "tv",
    space: "bt709",
    primaries: "bt709",
    trc: "bt709",
    hdr: false,
  },
  size: 38 * 1024 * 1024,
};

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTrimTime(sec: number): string {
  const safe = Math.max(0, sec);
  const m = Math.floor(safe / 60);
  const s = (safe - m * 60).toFixed(1);
  return `${String(m).padStart(2, "0")}:${s.padStart(4, "0")}`;
}

function formatCodec(codec: string): string {
  const upper = codec.toUpperCase();
  if (upper === "H264" || upper === "AVC1") return "H.264";
  if (upper === "HEVC" || upper === "H265") return "H.265";
  return upper;
}

export interface ReadyScreenProps {
  onNavigate?: (screen: Screen) => void;
}

export const ReadyScreen: React.FC<ReadyScreenProps> = ({ onNavigate }) => {
  const { setTitle } = useScreen();

  // Determine initial empty vs loaded state based on URL
  const [probeInfo, setProbeInfo] = useState<ProbeInfo | null>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const stateParam = params.get("state");
      if (stateParam === "open") return null;
      if (stateParam === "ready") return MOCK_SAMPLE_PROBE;
    }
    return MOCK_SAMPLE_PROBE;
  });

  const isLoaded = probeInfo !== null;
  const sourceFps = probeInfo?.fps ?? 24;
  const duration = probeInfo?.duration ?? 42.0;

  // Setup config from backend
  const [setupConfig, setSetupConfig] = useState<SetupConfig | null>(null);

  useEffect(() => {
    invoke<SetupConfig | null>("setup_config")
      .then((cfg) => {
        if (cfg) setSetupConfig(cfg);
      })
      .catch(() => {});
  }, []);

  // Update window title and data-file attribute on mount/update
  useEffect(() => {
    setTitle(isLoaded ? probeInfo.name : "Tween");
    const win = document.querySelector(".win") as HTMLElement | null;
    if (win) {
      win.dataset.file = isLoaded ? "loaded" : "none";
    }
    return () => {
      if (win) win.dataset.file = undefined;
    };
  }, [isLoaded, probeInfo?.name, setTitle]);

  // Poster frame preview
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [view, setView] = useState<"orig" | "res">("res");

  // Output folder
  const [outputFolder, setOutputFolder] = useState<string>(() => {
    return "D:\\Videos\\Flowmotion";
  });

  // Settings persistence
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    return localStorage.getItem("tween_last_model") || "rife-v4.26";
  });

  const [selectedEncoder, setSelectedEncoder] = useState<string>(() => {
    return localStorage.getItem("tween_last_encoder") || "h264_nvenc";
  });

  const [quality, setQuality] = useState<number>(() => {
    const saved = localStorage.getItem("tween_last_quality");
    return saved ? parseInt(saved, 10) : 18;
  });

  const [keepAudio, setKeepAudio] = useState<boolean>(true);

  // Frame rate strip state
  type FpsOption = "2×" | "3×" | "4×" | "60" | "120" | "Custom";
  const [fpsChoice, setFpsChoice] = useState<FpsOption>(() => {
    const saved = localStorage.getItem("tween_last_fps_choice") as FpsOption | null;
    return saved || "2×";
  });

  const [customFps, setCustomFps] = useState<number>(() => {
    const saved = localStorage.getItem("tween_last_custom_fps");
    return saved ? parseInt(saved, 10) : 90;
  });

  const [isEditingCustom, setIsEditingCustom] = useState<boolean>(false);

  // Compute target FPS
  const targetFps = useMemo(() => {
    switch (fpsChoice) {
      case "2×":
        return Math.round(sourceFps * 2);
      case "3×":
        return Math.round(sourceFps * 3);
      case "4×":
        return Math.round(sourceFps * 4);
      case "60":
        return 60;
      case "120":
        return 120;
      case "Custom":
        return customFps;
    }
  }, [fpsChoice, sourceFps, customFps]);

  // Animated counting number for Target FPS
  const [displayFps, setDisplayFps] = useState<number>(targetFps);
  const animRef = useRef<number>(0);
  const prevFpsRef = useRef<number>(targetFps);

  useEffect(() => {
    const from = prevFpsRef.current;
    const to = targetFps;
    prevFpsRef.current = to;

    if (from === to) {
      setDisplayFps(to);
      return;
    }

    const t0 = performance.now();
    const d = 480;

    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / d);
      // Cubic ease out
      const e = 1 - Math.pow(1 - p, 3);
      const val = Math.round(from + (to - from) * e);
      setDisplayFps(val);
      if (p < 1) {
        animRef.current = requestAnimationFrame(tick);
      }
    };

    cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(animRef.current);
  }, [targetFps]);

  // Trim editor state
  const [inT, setInT] = useState<number>(0);
  const [outT, setOutT] = useState<number>(duration);
  const [playhead, setPlayhead] = useState<number>(0);
  const laneRef = useRef<HTMLDivElement | null>(null);

  // Keep trim in sync with duration changes
  useEffect(() => {
    setInT(0);
    setOutT(duration);
    setPlayhead(0);
  }, [duration]);

  const MIN_TRIM = 0.5;

  const handleSetIn = useCallback(() => {
    setInT(Math.min(playhead, outT - MIN_TRIM));
  }, [playhead, outT]);

  const handleSetOut = useCallback(() => {
    setOutT(Math.max(playhead, inT + MIN_TRIM));
  }, [playhead, inT]);

  const handleResetTrim = useCallback(() => {
    setInT(0);
    setOutT(duration);
  }, [duration]);

  // I/O keyboard shortcuts for trim
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (e.key === "i" || e.key === "I") {
        handleSetIn();
      } else if (e.key === "o" || e.key === "O") {
        handleSetOut();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleStart();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSetIn, handleSetOut]);

  // Video loader function
  const loadVideo = useCallback(async (filePath: string) => {
    try {
      const info = await invoke<ProbeInfo>("probe_video", { path: filePath });
      setProbeInfo(info);

      // Default output folder to source video directory
      const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
      if (lastSlash > 0) {
        setOutputFolder(filePath.slice(0, lastSlash));
      }

      // Extract poster frame
      try {
        const frameDataUrl = await invoke<string>("extract_frame", {
          path: filePath,
          time: 0.0,
        });
        if (frameDataUrl) {
          setPosterUrl(frameDataUrl);
        }
      } catch {
        setPosterUrl(null);
      }
    } catch (err) {
      console.error("Failed to probe video:", err);
    }
  }, []);

  // Tauri Drag and Drop listener
  const [isOver, setIsOver] = useState<boolean>(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function listenDrop() {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setIsOver(true);
          } else if (event.payload.type === "leave") {
            setIsOver(false);
          } else if (event.payload.type === "drop") {
            setIsOver(false);
            const paths = event.payload.paths;
            if (paths && paths.length > 0) {
              loadVideo(paths[0]);
            }
          }
        });
      } catch (err) {
        console.warn("Tauri drag-drop not bound:", err);
      }
    }
    listenDrop();
    return () => {
      if (unlisten) unlisten();
    };
  }, [loadVideo]);

  // File dialog choose
  const handleChooseVideo = useCallback(async () => {
    try {
      const picked = await invoke<string | null>("pick_video_file");
      if (picked) {
        loadVideo(picked);
        return;
      }
    } catch {
      // Fallback to plugin-dialog
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const res = await open({
          multiple: false,
          directory: false,
          filters: [
            {
              name: "Video",
              extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "ts", "mts", "m2ts", "gif"],
            },
          ],
        });
        if (typeof res === "string") {
          loadVideo(res);
        }
      } catch (e2) {
        console.error("Choose video failed:", e2);
      }
    }
  }, [loadVideo]);

  // Folder dialog choose
  const handlePickFolder = useCallback(async () => {
    try {
      const picked = await invoke<string | null>("pick_output_folder", {
        defaultPath: outputFolder,
      });
      if (picked) {
        setOutputFolder(picked);
        return;
      }
    } catch {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const res = await open({
          multiple: false,
          directory: true,
          defaultPath: outputFolder,
        });
        if (typeof res === "string") {
          setOutputFolder(res);
        }
      } catch (e2) {
        console.error("Choose folder failed:", e2);
      }
    }
  }, [outputFolder]);

  // Models list
  const availableModels = useMemo(() => {
    if (!setupConfig?.models || setupConfig.models.length === 0) {
      return KNOWN_MODELS;
    }
    const filtered = KNOWN_MODELS.filter((m) => setupConfig.models?.includes(m.id));
    return filtered.length > 0 ? filtered : KNOWN_MODELS;
  }, [setupConfig?.models]);

  // Available encoders list
  const availableEncoders = useMemo(() => {
    if (!setupConfig?.encoders || setupConfig.encoders.length === 0) {
      return ["hevc_nvenc", "h264_nvenc", "libx264"];
    }
    return setupConfig.encoders;
  }, [setupConfig?.encoders]);

  const activeEncoderName = ENCODER_NAMES[selectedEncoder] || selectedEncoder;

  const handleCycleEncoder = useCallback(() => {
    const idx = availableEncoders.indexOf(selectedEncoder);
    const nextIdx = (idx + 1) % availableEncoders.length;
    const nextEnc = availableEncoders[nextIdx];
    setSelectedEncoder(nextEnc);
    localStorage.setItem("tween_last_encoder", nextEnc);
  }, [availableEncoders, selectedEncoder]);

  const handleCycleQuality = useCallback(() => {
    const qList = [16, 18, 20, 22, 24];
    const idx = qList.indexOf(quality);
    const nextQ = qList[(idx + 1) % qList.length];
    setQuality(nextQ);
    localStorage.setItem("tween_last_quality", String(nextQ));
  }, [quality]);

  // Estimates calculation
  const trimDuration = Math.max(0.1, outT - inT);
  const trimFrames = Math.round(trimDuration * sourceFps);
  const estFrames = Math.round(trimFrames * (targetFps / sourceFps));

  const estTime = useMemo(() => {
    let speedFps = 38;
    if (setupConfig?.gpu?.ms && setupConfig.gpu.ms > 0) {
      const ms = setupConfig.gpu.ms;
      const pixelRatio = ((probeInfo?.width ?? 1920) * (probeInfo?.height ?? 1080)) / (1920 * 1080);
      speedFps = Math.max(5, Math.round(1000 / (ms * pixelRatio)));
    }
    const secs = Math.max(1, Math.round(estFrames / speedFps));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }, [setupConfig?.gpu?.ms, probeInfo?.width, probeInfo?.height, estFrames]);

  const estSizeMB = useMemo(() => {
    return Math.max(1, Math.round((trimDuration * 1.24 * targetFps) / 48));
  }, [trimDuration, targetFps]);

  // Warnings
  const warnings = useMemo(() => {
    const list: string[] = [];
    if (probeInfo?.colour?.hdr) {
      list.push("HDR will be saved as SDR");
    }
    if (probeInfo?.vfr) {
      list.push("variable frame rate; output will be constant");
    }
    if (setupConfig?.mode === "cpu") {
      list.push("no GPU, this will be slow");
    }
    return list;
  }, [probeInfo?.colour?.hdr, probeInfo?.vfr, setupConfig?.mode]);

  // Handle Interpolate start
  const handleStart = useCallback(() => {
    if (!isLoaded) return;
    // Persist selections
    localStorage.setItem("tween_last_model", selectedModel);
    localStorage.setItem("tween_last_encoder", selectedEncoder);
    localStorage.setItem("tween_last_quality", String(quality));
    localStorage.setItem("tween_last_fps_choice", fpsChoice);
    if (fpsChoice === "Custom") {
      localStorage.setItem("tween_last_custom_fps", String(customFps));
    }
    onNavigate?.("processing");
  }, [isLoaded, selectedModel, selectedEncoder, quality, fpsChoice, customFps, onNavigate]);

  // Folder name
  const folderName = useMemo(() => {
    const parts = outputFolder.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || "Output";
  }, [outputFolder]);

  // Ruler tick items for timeline
  const rulerTicks = useMemo(() => {
    const step = duration > 120 ? 30 : duration > 60 ? 10 : 6;
    const ticks: { pos: number; label: string }[] = [];
    for (let s = 0; s <= duration; s += step) {
      ticks.push({
        pos: (s / duration) * 100,
        label: formatDuration(s),
      });
    }
    return ticks;
  }, [duration]);

  // Pill highlight for vertical rail
  const railButtons = ["2×", "3×", "4×", "60", "120", "Custom"] as const;
  const activeRailIndex = railButtons.indexOf(fpsChoice);
  const railPillStyle: React.CSSProperties = {
    top: `${(activeRailIndex / railButtons.length) * 100}%`,
    height: `${(1 / railButtons.length) * 100}%`,
  };

  // View switch pill style
  const viewPillStyle: React.CSSProperties = {
    transform: view === "orig" ? "translateX(0)" : "translateX(100%)",
    width: "50%",
  };

  // Lane pointer handlers for trim
  const handleLanePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".hdl")) return;
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pos = Math.min(duration, Math.max(0, ((e.clientX - rect.left) / rect.width) * duration));
    setPlayhead(pos);

    const onPointerMove = (ev: PointerEvent) => {
      const curPos = Math.min(duration, Math.max(0, ((ev.clientX - rect.left) / rect.width) * duration));
      setPlayhead(curPos);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const handleInHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect) return;

    const onPointerMove = (ev: PointerEvent) => {
      const pos = Math.min(outT - MIN_TRIM, Math.max(0, ((ev.clientX - rect.left) / rect.width) * duration));
      setInT(pos);
      setPlayhead((ph) => Math.max(ph, pos));
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const handleOutHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect) return;

    const onPointerMove = (ev: PointerEvent) => {
      const pos = Math.max(inT + MIN_TRIM, Math.min(duration, ((ev.clientX - rect.left) / rect.width) * duration));
      setOutT(pos);
      setPlayhead((ph) => Math.min(ph, pos));
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  return (
    <>
      <section className="ws" data-file={isLoaded ? "loaded" : "none"}>
        {/* Header */}
        <div className="fh nv">
          <div>
            <span className="lbl" id="fhLbl">01 · Source</span>
            <h2 id="fhName">{isLoaded ? probeInfo.name : "No video selected"}</h2>
            {isLoaded ? (
              <div className="fmeta" id="fhMeta">
                {`${probeInfo.width}×${probeInfo.height} · ${Math.round(probeInfo.fps)} fps · ${formatDuration(
                  probeInfo.duration
                )} · ${formatCodec(probeInfo.codec)}${
                  probeInfo.audioCodec ? ` · ${formatCodec(probeInfo.audioCodec)}` : ""
                } · ${probeInfo.frames.toLocaleString()} frames`}
              </div>
            ) : null}
          </div>
        </div>

        {/* Stage */}
        <div className="stage">
          {isLoaded ? (
            <div className="canvas nv" id="canvas" data-view={view}>
              {posterUrl ? (
                <img
                  src={posterUrl}
                  alt="Source poster frame"
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                  }}
                />
              ) : (
                <>
                  <div className="scene orig" />
                  <div className="scene res" id="res" />
                </>
              )}
              <div className="vsw v-ready v-done" id="vsw">
                <i className="vpill" id="vpill" style={viewPillStyle} />
                <button
                  type="button"
                  data-v="orig"
                  className={view === "orig" ? "on" : ""}
                  onClick={() => setView("orig")}
                >
                  Original <small>{Math.round(sourceFps)} fps</small>
                </button>
                <button
                  type="button"
                  data-v="res"
                  className={view === "res" ? "on" : ""}
                  onClick={() => setView("res")}
                >
                  Interpolated <small id="tagTo">{Math.round(targetFps)} fps</small>
                </button>
              </div>
            </div>
          ) : (
            <div
              className={`dz sdz ${isOver ? "over" : ""}`}
              id="dz"
              tabIndex={0}
              onDragOver={(e) => {
                e.preventDefault();
                setIsOver(true);
              }}
              onDragLeave={() => setIsOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsOver(false);
                const file = e.dataTransfer?.files?.[0];
                if (file) {
                  const path = (file as any).path || file.name;
                  loadVideo(path);
                }
              }}
            >
              <i className="cm a" />
              <i className="cm b" />
              <i className="cm c" />
              <i className="cm d" />
              <div className="dzr">
                <b className="dzt" id="dzt">
                  Drop a video
                </b>
                <span className="dzs" id="dzs">
                  or browse your computer
                </span>
                <button type="button" className="btn solid cta" id="pick" onClick={handleChooseVideo}>
                  Choose video <span>→</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Trim Editor */}
        <div className="tr nv trim" id="trim">
          <div className="trh">
            <div className="trl">
              <span className="lbl">Trim</span>
              <span className="rd">
                <span>In</span>
                <b id="tIn">{formatTrimTime(inT)}</b>
              </span>
              <span className="rd">
                <span>Out</span>
                <b id="tOut">{formatTrimTime(outT)}</b>
              </span>
              <span className="rd len">
                <span>Length</span>
                <b id="tLen">{formatTrimTime(trimDuration)}</b>
              </span>
              <span className="rd">
                <span>Frames</span>
                <b id="tFr">{trimFrames.toLocaleString()}</b>
              </span>
            </div>
            <div className="tbs">
              <button type="button" className="tbn" id="trIn" onClick={handleSetIn}>
                Set in <kbd>I</kbd>
              </button>
              <button type="button" className="tbn" id="trOut" onClick={handleSetOut}>
                Set out <kbd>O</kbd>
              </button>
              <button type="button" className="tbn mute" id="trReset" onClick={handleResetTrim}>
                Reset
              </button>
            </div>
          </div>

          <div className="lane" id="lane" ref={laneRef} onPointerDown={handleLanePointerDown}>
            <div className="film" id="film">
              {Array.from({ length: 150 }).map((_, i) => (
                <i key={i} />
              ))}
            </div>
            <div className="shade" id="shL" style={{ width: `${(inT / duration) * 100}%` }} />
            <div className="shade" id="shR" style={{ width: `${Math.max(0, 100 - (outT / duration) * 100)}%` }} />
            <div
              className="sel"
              id="sel"
              style={{
                left: `${(inT / duration) * 100}%`,
                width: `${Math.max(0, ((outT - inT) / duration) * 100)}%`,
              }}
            />
            <div
              className="hdl in"
              id="hIn"
              style={{ left: `${(inT / duration) * 100}%` }}
              onPointerDown={handleInHandlePointerDown}
            >
              <span className="tip" id="tipIn">
                {formatTrimTime(inT)}
              </span>
            </div>
            <div
              className="hdl out"
              id="hOut"
              style={{ left: `${(outT / duration) * 100}%` }}
              onPointerDown={handleOutHandlePointerDown}
            >
              <span className="tip" id="tipOut">
                {formatTrimTime(outT)}
              </span>
            </div>
            <div className="ph" id="ph" style={{ left: `${(playhead / duration) * 100}%` }} />
          </div>

          <div className="rul" id="rul">
            {rulerTicks.map((tick, i) => (
              <span key={i} style={{ left: `${tick.pos}%` }}>
                {tick.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Frame Rate Strip (Column 2) */}
      <aside className="frail nv" data-file={isLoaded ? "loaded" : "none"}>
        <span className="lbl">Frame rate</span>
        <div className="rv">
          <div className="fr0">
            {Math.round(sourceFps)} <i>→</i>
          </div>
          <div className="fr1" id="fpsTo">
            {displayFps}
          </div>
          <small>fps</small>
        </div>

        <div className="fseg v" id="fseg">
          <i className="pill" id="pill" style={railPillStyle} />
          <button
            type="button"
            className={fpsChoice === "2×" ? "on" : ""}
            onClick={() => {
              setFpsChoice("2×");
              setIsEditingCustom(false);
            }}
          >
            <b>2×</b>
            <span>{Math.round(sourceFps * 2)} fps</span>
          </button>
          <button
            type="button"
            className={fpsChoice === "3×" ? "on" : ""}
            onClick={() => {
              setFpsChoice("3×");
              setIsEditingCustom(false);
            }}
          >
            <b>3×</b>
            <span>{Math.round(sourceFps * 3)} fps</span>
          </button>
          <button
            type="button"
            className={fpsChoice === "4×" ? "on" : ""}
            onClick={() => {
              setFpsChoice("4×");
              setIsEditingCustom(false);
            }}
          >
            <b>4×</b>
            <span>{Math.round(sourceFps * 4)} fps</span>
          </button>
          <button
            type="button"
            className={fpsChoice === "60" ? "on" : ""}
            onClick={() => {
              setFpsChoice("60");
              setIsEditingCustom(false);
            }}
          >
            <b>60</b>
            <span>fps</span>
          </button>
          <button
            type="button"
            className={fpsChoice === "120" ? "on" : ""}
            onClick={() => {
              setFpsChoice("120");
              setIsEditingCustom(false);
            }}
          >
            <b>120</b>
            <span>fps</span>
          </button>
          <button
            type="button"
            className={fpsChoice === "Custom" ? "on" : ""}
            onClick={() => {
              setFpsChoice("Custom");
              setIsEditingCustom(true);
            }}
          >
            <b>Custom</b>
            {isEditingCustom ? (
              <input
                type="number"
                className="custom-fps-input"
                min={Math.floor(sourceFps) + 1}
                max={240}
                value={customFps}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) {
                    setCustomFps(val);
                  }
                }}
                onBlur={() => {
                  if (customFps <= sourceFps) {
                    setCustomFps(Math.max(1, Math.min(240, Math.floor(sourceFps) + 1)));
                  } else if (customFps > 240) {
                    setCustomFps(240);
                  }
                  setIsEditingCustom(false);
                }}
                autoFocus
              />
            ) : (
              <span>{customFps} fps</span>
            )}
          </button>
        </div>

        <div className="gainv">
          <b id="gainT">
            +{Math.max(0, Math.round(targetFps - sourceFps))} frames
            <br />
            every second
          </b>
        </div>
      </aside>

      {/* Inspector / Settings (Column 3) */}
      <aside className="insp" id="insp" data-file={isLoaded ? "loaded" : "none"}>
        <div className="iscroll">
          {/* Quiet warnings */}
          {warnings.length > 0 && (
            <div className="grp" style={{ padding: "12px 24px" }}>
              {warnings.map((w, idx) => (
                <div key={idx} className="quiet-warn">
                  <span>•</span>
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {/* Model selection */}
          <div className="grp">
            <div className="lbl">Model</div>
            <div className="opt">
              {availableModels.map((m) => {
                const isSelected = selectedModel === m.id;
                return (
                  <div
                    key={m.id}
                    className={`model ${isSelected ? "on" : ""}`}
                    onClick={() => {
                      setSelectedModel(m.id);
                      localStorage.setItem("tween_last_model", m.id);
                    }}
                  >
                    <div className="mtx">
                      <b>{m.name}</b>
                      <small>{m.desc}</small>
                    </div>
                    {m.badge ? <em>{m.badge}</em> : null}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Output settings */}
          <div className="grp">
            <div className="lbl">Output</div>
            <div className="row" onClick={handleCycleEncoder} style={{ cursor: "pointer" }}>
              <span>Encoder</span>
              <b>{activeEncoderName}</b>
            </div>
            <div className="row" onClick={handleCycleQuality} style={{ cursor: "pointer" }}>
              <span>Quality</span>
              <b>CQ {quality}</b>
            </div>
            <div className="row">
              <span>Keep audio</span>
              <div
                className={`sw ${keepAudio ? "" : "off"}`}
                onClick={() => setKeepAudio(!keepAudio)}
              />
            </div>
          </div>

          {/* Save to folder */}
          <div className="grp">
            <div className="lbl">Save to</div>
            <button className="fold" id="outPick" type="button" onClick={handlePickFolder}>
              <svg viewBox="0 0 20 16">
                <path d="M1 3a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z" />
              </svg>
              <div>
                <b id="outName">{folderName}</b>
                <small id="outPath">{outputFolder}</small>
              </div>
              <span>Choose</span>
            </button>
          </div>
        </div>

        {/* Footer with Estimates & Button */}
        <div className="ifoot">
          <div className="est nv">
            <span>
              ~ <b id="estT">{estTime}</b>
            </span>
            <span>
              <b id="estF">{estFrames.toLocaleString()}</b> frames
            </span>
            <span>
              ~ <b id="estS">{estSizeMB}</b> MB
            </span>
          </div>

          <button
            type="button"
            className={`go ${isLoaded ? "v-ready v-done" : "off v-empty"}`}
            onClick={handleStart}
            disabled={!isLoaded}
          >
            <span>Interpolate</span>
            <kbd>Ctrl ↵</kbd>
          </button>
        </div>
      </aside>
    </>
  );
};
