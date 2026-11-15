import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useScreen } from "../ScreenRouter";
import type { Screen, ProbeInfo, ColourInfo, JobRequest } from "../types";
import { loadSettingsDefaults } from "../settingsTypes";
import {
  MAX_FPS,
  type FpsRow,
  formatFps,
  getFpsFontSize,
  stepFpsAnimation,
  computeMinCustomFps,
  computeFpsRows,
  checkCustomVal,
  clampCustomVal,
} from "../fpsStrip";

export type { ColourInfo, ProbeInfo, FpsRow };
export { formatFps };

const THUMBNAIL_CACHE = new Map<string, string[]>();

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
  hevc_amf: "H.265 · AMD",
  h264_amf: "H.264 · AMD",
  hevc_qsv: "H.265 · Intel QSV",
  h264_qsv: "H.264 · Intel QSV",
  hevc_videotoolbox: "H.265 · Apple Silicon",
  h264_videotoolbox: "H.264 · Apple Silicon",
  libx265: "H.265 · CPU",
  libx264: "H.264 · CPU",
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
  initialProbe?: ProbeInfo | null;
  onNavigate?: (screen: Screen) => void;
  onVideoLoaded?: (loaded: boolean) => void;
  onStartJob?: (job: JobRequest) => void;
}

export const ReadyScreen: React.FC<ReadyScreenProps> = ({
  initialProbe,
  onNavigate,
  onVideoLoaded,
  onStartJob,
}) => {
  const { setTitle } = useScreen();

  const isMock = Boolean(
    import.meta.env.DEV &&
      typeof window !== "undefined" &&
      (new URLSearchParams(window.location.search).get("mock") === "1" ||
        new URLSearchParams(window.location.search).has("src") ||
        new URLSearchParams(window.location.search).has("custom") ||
        new URLSearchParams(window.location.search).has("customval") ||
        new URLSearchParams(window.location.search).get("state") === "ready")
  );

  // The app starts strictly in the empty state (probeInfo = null).
  // Mock data is only allowed in DEV with explicit mock/preview parameters.
  const [probeInfo, setProbeInfo] = useState<ProbeInfo | null>(() => {
    if (initialProbe) return initialProbe;
    if (typeof window !== "undefined") {
      const searchParams = new URLSearchParams(window.location.search);
      const isMockOrPreview =
        (import.meta.env.DEV && searchParams.get("mock") === "1") ||
        searchParams.has("src") ||
        searchParams.has("custom") ||
        searchParams.has("customval") ||
        (import.meta.env.DEV && searchParams.get("state") === "ready");

      if (isMockOrPreview) {
        const srcParam = parseFloat(searchParams.get("src") || "24");
        const mockFps = isNaN(srcParam) || srcParam <= 0 ? 24 : srcParam;
        const fpsNum = Math.round(mockFps * 1000);
        const fpsDen = 1000;
        return {
          file: `beach_sunset_${Math.round(mockFps)}fps.mp4`,
          name: `beach_sunset_${Math.round(mockFps)}fps.mp4`,
          width: 1920,
          height: 1080,
          codec: "H.264",
          pixFmt: "yuv420p",
          fpsNum: Number.isInteger(mockFps) ? mockFps : fpsNum,
          fpsDen: Number.isInteger(mockFps) ? 1 : fpsDen,
          fps: mockFps,
          vfr: false,
          duration: 42.0,
          frames: Math.round(42.0 * mockFps),
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
      }
    }
    return null;
  });

  const isLoaded = probeInfo !== null;
  const sourceFps = probeInfo ? probeInfo.fps : null;
  const duration = probeInfo ? probeInfo.duration : 0;

  // Setup config from backend
  const [setupConfig, setSetupConfig] = useState<SetupConfig | null>(null);

  useEffect(() => {
    if (initialProbe) {
      setProbeInfo(initialProbe);
    }
  }, [initialProbe]);

  useEffect(() => {
    invoke<SetupConfig | null>("setup_config")
      .then((cfg) => {
        if (cfg) {
          setSetupConfig(cfg);
        }
      })
      .catch(() => {});
  }, []);

  // Notify parent and sync data-file / title
  useEffect(() => {
    onVideoLoaded?.(isLoaded);
    setTitle(isLoaded ? probeInfo.name : "Tween");
    const win = document.querySelector(".win") as HTMLElement | null;
    if (win) {
      win.dataset.file = isLoaded ? "loaded" : "none";
    }
    return () => {
      if (win) win.dataset.file = undefined;
    };
  }, [isLoaded, probeInfo?.name, setTitle, onVideoLoaded]);

  // Poster frame preview & player state
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const [codecLimited, setCodecLimited] = useState<boolean>(false);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stepFrameRef = useRef<number>(0);

  const [view, setView] = useState<"orig" | "res">(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const v = p.get("view");
      if (v === "orig" || v === "res") return v;
    }
    return "res";
  });
  const origBtnRef = useRef<HTMLButtonElement | null>(null);
  const resBtnRef = useRef<HTMLButtonElement | null>(null);
  const vswRef = useRef<HTMLDivElement | null>(null);
  const vpillRef = useRef<HTMLElement | null>(null);
  const isViewClickRef = useRef<boolean>(false);

  const syncViewPill = useCallback((instant = false) => {
    const sw = vswRef.current;
    const pill = vpillRef.current;
    if (!sw || !pill) return;

    const btn = (view === "orig" ? origBtnRef.current : resBtnRef.current) ||
      (sw.querySelector("button.on") as HTMLElement | null);
    if (!btn || btn.offsetWidth === 0) return;

    const left = btn.offsetLeft;
    const width = btn.offsetWidth;

    if (instant) {
      pill.style.transition = "none";
    }
    pill.style.top = "0px";
    pill.style.bottom = "0px";
    pill.style.width = `${width}px`;
    pill.style.transform = `translateX(${left}px)`;

    if (instant) {
      void pill.offsetWidth;
      pill.style.transition = "";
    }
  }, [view]);

  useLayoutEffect(() => {
    const isClick = isViewClickRef.current;
    isViewClickRef.current = false;
    syncViewPill(!isClick);
    const id = requestAnimationFrame(() => syncViewPill(true));
    return () => cancelAnimationFrame(id);
  }, [syncViewPill, view, isLoaded, sourceFps]);

  useEffect(() => {
    const el = vswRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncViewPill(true));
    ro.observe(el);
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => syncViewPill(true));
    }
    const onResize = () => syncViewPill(true);
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [syncViewPill]);

  const videoSrc = useMemo(() => {
    if (!probeInfo?.file) return "";
    try {
      return convertFileSrc(probeInfo.file);
    } catch {
      return probeInfo.file;
    }
  }, [probeInfo?.file]);

  // Output folder: starts empty or with defaults until a video is probed or user picks one
  const [outputFolder, setOutputFolder] = useState<string>(() => {
    return loadSettingsDefaults().outputFolder || "";
  });

  // Settings persistence
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    return loadSettingsDefaults().model || localStorage.getItem("tween_last_model") || "rife-v4.26";
  });

  const [selectedEncoder, setSelectedEncoder] = useState<string>(() => {
    return localStorage.getItem("tween_last_encoder") || "";
  });

  const [quality, setQuality] = useState<number>(() => {
    const defs = loadSettingsDefaults();
    if (defs.quality) return defs.quality;
    const saved = localStorage.getItem("tween_last_quality");
    return saved ? parseInt(saved, 10) : 18;
  });

  const [keepAudio, setKeepAudio] = useState<boolean>(() => {
    return loadSettingsDefaults().keepAudio ?? true;
  });

  const [sceneDetect, setSceneDetect] = useState<boolean>(() => {
    return loadSettingsDefaults().sceneDetect ?? true;
  });

  // Frame rate strip state
  const MAXF = MAX_FPS;
  const minCustomFps = computeMinCustomFps(sourceFps);

  const [selectedChoice, setSelectedChoice] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const ch = p.get("choice");
      if (ch) {
        return ch.replace(/([0-9]+)[xX]/g, "$1×");
      }
      if (p.get("custom") === "edit" || p.get("custom") === "applied") {
        return "Custom";
      }
    }
    const saved = localStorage.getItem("tween_last_fps_choice");
    return saved || "2×";
  });

  const [customFps, setCustomFps] = useState<number | null>(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const cv = p.get("customval");
      if (cv) return parseInt(cv, 10);
      if (p.get("custom") === "applied") return 90;
    }
    const saved = localStorage.getItem("tween_last_custom_fps");
    return saved ? parseInt(saved, 10) : null;
  });

  const [isEditingCustom, setIsEditingCustom] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      return p.get("custom") === "edit";
    }
    return false;
  });
  const [prevChoice, setPrevChoice] = useState<string>("2×");
  const [customInputStr, setCustomInputStr] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const cv = p.get("customval");
      if (cv) return cv;
      if (p.get("custom") === "edit" || p.get("custom") === "applied") return "90";
    }
    return "";
  });
  const [inputErr, setInputErr] = useState<string | null>(null);

  const frailRef = useRef<HTMLElement | null>(null);
  const fsegRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLElement | null>(null);
  const isUserClickRef = useRef<boolean>(false);
  const rvRef = useRef<HTMLDivElement | null>(null);
  const fpsToRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Options adapt to the real source fps
  const fpsRows = useMemo<FpsRow[]>(() => computeFpsRows(sourceFps, customFps), [sourceFps, customFps]);

  // Keep selection valid as rows adapt
  useEffect(() => {
    if (!sourceFps) return;
    const validRow = fpsRows.find((r) => r.key === selectedChoice && !r.disabled);
    if (!validRow) {
      const fallback = fpsRows.find((r) => !r.disabled && !r.isCustom) || fpsRows[0];
      if (fallback) {
        setSelectedChoice(fallback.key);
      }
    }
  }, [fpsRows, selectedChoice, sourceFps]);

  // Compute active target FPS
  const targetFps = useMemo(() => {
    if (!sourceFps) return null;
    const activeRow = fpsRows.find((r) => r.key === selectedChoice);
    if (!activeRow) return sourceFps * 2;
    if (activeRow.isCustom) {
      return customFps !== null ? customFps : (90 > sourceFps ? 90 : minCustomFps);
    }
    return activeRow.fps;
  }, [selectedChoice, fpsRows, sourceFps, customFps, minCustomFps]);

  // Final target fps or custom input determines font size so counter fits strip
  const counterFontSize = useMemo(() => {
    if (isEditingCustom) {
      return getFpsFontSize(customInputStr);
    }
    return getFpsFontSize(targetFps);
  }, [isEditingCustom, customInputStr, targetFps]);

  // Animated counting number for Target FPS
  const [displayFps, setDisplayFps] = useState<number | null>(targetFps);
  const animRef = useRef<number>(0);
  const prevFpsRef = useRef<number | null>(targetFps);

  useEffect(() => {
    if (isEditingCustom) return;
    const from = prevFpsRef.current;
    const to = targetFps;
    prevFpsRef.current = to;

    if (to === null) {
      setDisplayFps(null);
      return;
    }

    if (from === null || from === to) {
      setDisplayFps(to);
      return;
    }

    const t0 = performance.now();
    const d = 480;

    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / d);
      const val = stepFpsAnimation(from, to, p);
      setDisplayFps(val);
      if (p < 1) {
        animRef.current = requestAnimationFrame(tick);
      } else {
        setDisplayFps(to);
      }
    };

    cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animRef.current);
      setDisplayFps(to);
    };
  }, [targetFps, isEditingCustom]);

  // Validation helper for Custom input
  const checkVal = useCallback(
    (str: string) => checkCustomVal(str, sourceFps),
    [sourceFps]
  );

  // Custom edit actions
  const enterEdit = useCallback(
    (initVal?: number, instant?: boolean) => {
      if (isEditingCustom) return;
      setPrevChoice(selectedChoice);
      setSelectedChoice("Custom");
      setIsEditingCustom(true);

      const minF = sourceFps ? Math.floor(sourceFps) + 1 : 1;
      let start = initVal;
      if (start === undefined && customFps !== null) {
        start = customFps;
      }
      if (start === undefined) {
        start = 90 > (sourceFps || 0) ? 90 : Math.min(MAXF, Math.max(minF, Math.round((sourceFps || 24) * 1.5)));
      }

      setCustomInputStr(String(start));
      const c = checkVal(String(start));
      setInputErr(c.err || null);

      if (instant) {
        setDisplayFps(start);
      }

      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
        }
      });
    },
    [isEditingCustom, selectedChoice, sourceFps, customFps, checkVal]
  );

  const cancelEdit = useCallback(() => {
    if (!isEditingCustom) return;
    setIsEditingCustom(false);
    setInputErr(null);
    setSelectedChoice(prevChoice);
  }, [isEditingCustom, prevChoice]);

  const commitEdit = useCallback(() => {
    if (!isEditingCustom) return;
    const c = checkVal(customInputStr);
    // Enter applies at once. If invalid, corrected to nearest valid value and applied directly.
    const clamped = clampCustomVal(c.v, sourceFps, customFps);

    setCustomFps(clamped);
    setCustomInputStr(String(clamped));
    setIsEditingCustom(false);
    setInputErr(null);
    setSelectedChoice("Custom");
    setDisplayFps(clamped);

    localStorage.setItem("tween_last_fps_choice", "Custom");
    localStorage.setItem("tween_last_custom_fps", String(clamped));

    if (inputRef.current) {
      inputRef.current.blur();
    }

    // Small spring bounce on #fpsTo
    if (fpsToRef.current) {
      try {
        const cs = getComputedStyle(document.documentElement);
        const dur = parseFloat(cs.getPropertyValue("--spring-d")) || 400;
        const easing = cs.getPropertyValue("--spring").trim() || "ease-out";
        fpsToRef.current.animate([{ transform: "scale(0.93)" }, { transform: "none" }], {
          duration: dur,
          easing,
        });
      } catch {}
    }
  }, [isEditingCustom, checkVal, customInputStr, sourceFps, customFps]);

  const stepCustom = useCallback(
    (delta: number) => {
      const c = checkVal(customInputStr);
      const minF = sourceFps ? Math.floor(sourceFps) + 1 : 1;
      const base = c.v === undefined ? minF : c.v;
      const next = Math.min(MAXF, Math.max(minF, base + delta));
      setCustomInputStr(String(next));
      const res = checkVal(String(next));
      setInputErr(res.err || null);
    },
    [checkVal, customInputStr, sourceFps]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const clean = e.target.value.replace(/\D/g, "").slice(0, 3);
      setCustomInputStr(clean);
      const res = checkVal(clean);
      setInputErr(res.err || null);
    },
    [checkVal]
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelEdit();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const dir = e.key === "ArrowUp" ? 1 : -1;
        stepCustom(dir * (e.shiftKey ? 10 : 1));
      }
    },
    [commitEdit, cancelEdit, stepCustom]
  );

  const handleInputPointerDown = useCallback(
    (e: React.PointerEvent<HTMLInputElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const el = inputRef.current;
      if (!el) return;
      el.setPointerCapture(e.pointerId);

      const y0 = e.clientY;
      const c = checkVal(customInputStr);
      const minF = sourceFps ? Math.floor(sourceFps) + 1 : 1;
      const v0 = c.v === undefined ? minF : c.v;
      let moved = false;

      const onMove = (ev: PointerEvent) => {
        const dy = y0 - ev.clientY;
        if (Math.abs(dy) > 3) moved = true;
        if (moved) {
          const next = Math.min(MAXF, Math.max(minF, v0 + Math.round(dy / 4)));
          setCustomInputStr(String(next));
          const res = checkVal(String(next));
          setInputErr(res.err || null);
        }
      };

      const onUp = () => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        if (!moved) {
          el.focus();
        }
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    },
    [checkVal, customInputStr, sourceFps]
  );

  // Click outside cancels custom edit, like Esc
  useEffect(() => {
    if (!isEditingCustom) return;
    const handleDocPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (rvRef.current?.contains(target)) return;
      const customBtn = buttonRefs.current["Custom"];
      if (customBtn?.contains(target)) return;
      cancelEdit();
    };
    document.addEventListener("pointerdown", handleDocPointerDown, true);
    return () => document.removeEventListener("pointerdown", handleDocPointerDown, true);
  }, [isEditingCustom, cancelEdit]);

  // Mock / preview query parameter support: ?custom=edit|applied&customval=90
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const cm = params.get("custom");
    const cv = params.get("customval");
    const customValNum = cv ? parseInt(cv, 10) : undefined;

    if (cm === "edit") {
      enterEdit(customValNum, true);
    } else if (cm === "applied") {
      enterEdit(customValNum, true);
      const minF = sourceFps ? Math.floor(sourceFps) + 1 : 1;
      const v = customValNum !== undefined ? Math.min(MAXF, Math.max(minF, customValNum)) : 90;
      setCustomFps(v);
      setCustomInputStr(String(v));
      setIsEditingCustom(false);
      setInputErr(null);
      setSelectedChoice("Custom");
      setDisplayFps(v);
      localStorage.setItem("tween_last_fps_choice", "Custom");
      localStorage.setItem("tween_last_custom_fps", String(v));
    }
  }, [enterEdit, sourceFps]);

  // Pill highlight for vertical rail
  const syncRailPill = useCallback((instant = false) => {
    const seg = fsegRef.current;
    const pill = pillRef.current;
    if (!seg || !pill) return;

    const btn = (buttonRefs.current[selectedChoice] ||
      seg.querySelector("button.on")) as HTMLElement | null;
    if (!btn || btn.offsetHeight === 0) return;

    const top = btn.offsetTop;
    const height = btn.offsetHeight;
    const left = btn.offsetLeft;
    const width = btn.offsetWidth;

    if (instant) {
      pill.style.transition = "none";
    }
    pill.style.top = "0px";
    pill.style.left = `${left}px`;
    pill.style.width = `${width}px`;
    pill.style.height = `${height}px`;
    pill.style.transform = `translateY(${top}px)`;

    if (instant) {
      void pill.offsetHeight;
      pill.style.transition = "";
    }
  }, [selectedChoice]);

  useLayoutEffect(() => {
    const isClick = isUserClickRef.current;
    isUserClickRef.current = false;
    syncRailPill(!isClick);
    const id = requestAnimationFrame(() => syncRailPill(true));
    return () => cancelAnimationFrame(id);
  }, [syncRailPill, fpsRows, selectedChoice, isEditingCustom]);

  useEffect(() => {
    const el = fsegRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      syncRailPill(true);
    });
    ro.observe(el);
    if (frailRef.current) {
      ro.observe(frailRef.current);
    }
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => syncRailPill(true));
    }
    const onResize = () => syncRailPill(true);
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [syncRailPill]);

  const currentGainFrames = useMemo(() => {
    if (!sourceFps) return null;
    if (isEditingCustom) {
      const c = checkVal(customInputStr);
      if (!c.err && c.v !== undefined) {
        return Math.max(0, Math.round(c.v - sourceFps));
      }
      return null;
    }
    if (targetFps !== null) {
      return Math.max(0, Math.round(targetFps - sourceFps));
    }
    return null;
  }, [isEditingCustom, customInputStr, checkVal, sourceFps, targetFps]);

  // Trim editor state
  const [inT, setInT] = useState<number>(0);
  const [outT, setOutT] = useState<number>(0);
  const [playhead, setPlayhead] = useState<number>(0);
  const laneRef = useRef<HTMLDivElement | null>(null);

  // Keep trim in sync with duration changes
  useEffect(() => {
    if (duration > 0) {
      setInT(0);
      setOutT(duration);
      setPlayhead(0);
    } else {
      setInT(0);
      setOutT(0);
      setPlayhead(0);
    }
  }, [duration]);

  const MIN_TRIM = 0.5;

  const handleSetIn = useCallback(() => {
    if (duration > 0) {
      setInT(Math.min(playhead, outT - MIN_TRIM));
    }
  }, [playhead, outT, duration]);

  const handleSetOut = useCallback(() => {
    if (duration > 0) {
      setOutT(Math.max(playhead, inT + MIN_TRIM));
    }
  }, [playhead, inT, duration]);

  const handleResetTrim = useCallback(() => {
    if (duration > 0) {
      setInT(0);
      setOutT(duration);
    }
  }, [duration]);

  // Handle Start
  const handleStart = useCallback(() => {
    if (!isLoaded || !probeInfo) return;
    localStorage.setItem("tween_last_model", selectedModel);
    localStorage.setItem("tween_last_encoder", selectedEncoder);
    localStorage.setItem("tween_last_quality", String(quality));
    localStorage.setItem("tween_last_fps_choice", selectedChoice);
    if (selectedChoice === "Custom" && customFps !== null) {
      localStorage.setItem("tween_last_custom_fps", String(customFps));
    }

    const tFps = targetFps || (sourceFps ? sourceFps * 2 : 48);
    const dotIdx = probeInfo.name.lastIndexOf(".");
    const baseName = dotIdx > 0 ? probeInfo.name.slice(0, dotIdx) : probeInfo.name;
    const ext = dotIdx > 0 ? probeInfo.name.slice(dotIdx) : ".mp4";
    const outFileName = `${baseName}_${Math.round(tFps)}fps${ext}`;
    const normalizedFolder = outputFolder ? outputFolder.replace(/[\\/]+$/, "") : "";
    const outPath = normalizedFolder ? `${normalizedFolder}/${outFileName}` : outFileName;

    const targetMode =
      selectedChoice === "Custom" || !selectedChoice.includes("×")
        ? "fps"
        : "multiplier";
    const targetVal =
      targetMode === "fps"
        ? tFps
        : selectedChoice === "3×"
        ? 3
        : selectedChoice === "4×"
        ? 4
        : 2;

    const jobRequest: JobRequest = {
      info: probeInfo,
      target: {
        mode: targetMode,
        value: targetVal,
      },
      model: selectedModel,
      encoder: selectedEncoder || setupConfig?.encoders?.[0] || "libx264",
      quality: quality,
      keepAudio: keepAudio,
      sceneDetect: sceneDetect,
      output: outPath,
      trim: inT > 0 || (outT > 0 && outT < duration) ? { start: inT, end: outT } : undefined,
    };

    if (onStartJob) {
      onStartJob(jobRequest);
    } else {
      onNavigate?.("processing");
    }
  }, [
    isLoaded,
    probeInfo,
    selectedModel,
    selectedEncoder,
    quality,
    selectedChoice,
    customFps,
    targetFps,
    sourceFps,
    outputFolder,
    setupConfig,
    keepAudio,
    sceneDetect,
    inT,
    outT,
    duration,
    onStartJob,
    onNavigate,
  ]);

  // Codec error / playability fallback
  const handleVideoError = useCallback(() => {
    console.warn("HTML video element error; falling back to poster and frame stepping.");
    setCodecLimited(true);
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const cur = v.currentTime;
    if (outT > inT && cur >= outT) {
      v.currentTime = inT;
      setPlayhead(inT);
      return;
    }
    if (cur < inT && outT > inT) {
      v.currentTime = inT;
      setPlayhead(inT);
      return;
    }
    setPlayhead(cur);
  }, [inT, outT]);

  const handleEnded = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = inT;
    setPlayhead(inT);
    v.play().catch(() => {});
  }, [inT]);

  const stepFrame = useCallback(
    (time: number) => {
      if (!probeInfo?.file) return;
      const reqId = ++stepFrameRef.current;
      invoke<string>("extract_frame", { path: probeInfo.file, time })
        .then((url) => {
          if (reqId === stepFrameRef.current && url) {
            setPosterUrl(url);
          }
        })
        .catch((err) => {
          console.error("Frame stepping failed:", err);
        });
    },
    [probeInfo?.file]
  );

  const seekTo = useCallback(
    (pos: number) => {
      const minT = 0;
      const maxT = duration;
      const target = Math.max(minT, Math.min(maxT, pos));
      setPlayhead(target);
      const v = videoRef.current;
      if (v && !codecLimited) {
        v.currentTime = target;
      } else if (codecLimited && probeInfo?.file) {
        stepFrame(target);
      }
    },
    [duration, codecLimited, probeInfo?.file, stepFrame]
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || codecLimited) return;
    if (v.paused) {
      if (outT > inT && (v.currentTime >= outT || v.currentTime < inT)) {
        v.currentTime = inT;
        setPlayhead(inT);
      }
      v.play().catch((err) => {
        console.warn("Video play failed:", err);
      });
    } else {
      v.pause();
    }
  }, [codecLimited, inT, outT]);

  const stepByFrames = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      if (v && !v.paused) return; // Only step when paused
      const fps = sourceFps && sourceFps > 0 ? sourceFps : 30;
      const frameDuration = 1 / fps;
      setPlayhead((cur) => {
        const minT = inT;
        const maxT = outT > inT ? outT : duration;
        const nextT = Math.max(minT, Math.min(maxT, cur + delta * frameDuration));
        if (v && !codecLimited) {
          v.currentTime = nextT;
        } else if (codecLimited && probeInfo?.file) {
          stepFrame(nextT);
        }
        return nextT;
      });
    },
    [sourceFps, inT, outT, duration, codecLimited, probeInfo?.file, stepFrame]
  );

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(".vsw")) return;
      togglePlay();
    },
    [togglePlay]
  );

  // Keyboard shortcuts: Space toggles play/pause, Left/Right steps 1 frame when paused
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepByFrames(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepByFrames(1);
      } else if (e.key === "i" || e.key === "I") {
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
  }, [togglePlay, stepByFrames, handleSetIn, handleSetOut, handleStart]);

  // Video loader function
  const loadVideo = useCallback(async (filePath: string) => {
    setStageError(null);
    setCodecLimited(false);
    try {
      const info = await invoke<ProbeInfo>("probe_video", { path: filePath });
      setProbeInfo(info);

      // Apply defaults from settings
      const defs = loadSettingsDefaults();
      if (defs.outputFolder) {
        setOutputFolder(defs.outputFolder);
      } else {
        const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
        if (lastSlash > 0) {
          setOutputFolder(filePath.slice(0, lastSlash));
        } else {
          setOutputFolder(filePath);
        }
      }
      if (defs.model) {
        setSelectedModel(defs.model);
      }
      if (typeof defs.quality === "number") {
        setQuality(defs.quality);
      }
      if (typeof defs.keepAudio === "boolean") {
        setKeepAudio(defs.keepAudio);
      }
      if (typeof defs.sceneDetect === "boolean") {
        setSceneDetect(defs.sceneDetect);
      }

      // Check codec playability preemptively
      try {
        const testVideo = document.createElement("video");
        const c = info.codec.toLowerCase();
        let mime = "";
        if (c.includes("h264") || c.includes("avc")) {
          mime = 'video/mp4; codecs="avc1.42E01E"';
        } else if (c.includes("hevc") || c.includes("h265")) {
          mime = 'video/mp4; codecs="hvc1"';
        } else if (c.includes("vp9")) {
          mime = 'video/webm; codecs="vp9"';
        } else if (c.includes("av1")) {
          mime = 'video/mp4; codecs="av01.0.08M.08"';
        } else if (c.includes("prores")) {
          setCodecLimited(true);
        }
        if (mime && testVideo.canPlayType(mime) === "") {
          setCodecLimited(true);
        }
      } catch {
        // Ignore canPlayType error
      }

      // Extract poster frame (time 0.0)
      try {
        const frameDataUrl = await invoke<string>("extract_frame", {
          path: filePath,
          time: 0.0,
        });
        if (frameDataUrl) {
          setPosterUrl(frameDataUrl);
        }
      } catch (err) {
        console.error("Failed to extract poster frame:", err);
        setPosterUrl(null);
      }
    } catch (err) {
      console.error("Failed to probe video:", err);
      setStageError(String(err));
      setProbeInfo(null);
    }
  }, []);

  // Thumbnail extraction effect
  useEffect(() => {
    if (!probeInfo?.file) {
      setThumbnails([]);
      return;
    }
    const filePath = probeInfo.file;
    if (THUMBNAIL_CACHE.has(filePath)) {
      setThumbnails(THUMBNAIL_CACHE.get(filePath)!);
      return;
    }

    setThumbnails([]);
    const laneEl = laneRef.current;
    const laneWidth = laneEl ? laneEl.clientWidth : 800;
    const aspect =
      probeInfo.width > 0 && probeInfo.height > 0
        ? probeInfo.width / probeInfo.height
        : 16 / 9;
    const thumbWidth = Math.max(30, Math.round(56 * aspect));
    const count = Math.max(8, Math.min(60, Math.round(laneWidth / thumbWidth)));

    let cancelled = false;
    invoke<string[]>("extract_thumbnails", {
      path: filePath,
      count,
      height: 56,
    })
      .then((thumbs) => {
        if (cancelled) return;
        THUMBNAIL_CACHE.set(filePath, thumbs);
        setThumbnails(thumbs);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to extract thumbnails:", err);
        setThumbnails([]);
      });

    return () => {
      cancelled = true;
    };
  }, [probeInfo?.file, probeInfo?.width, probeInfo?.height]);

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
        defaultPath: outputFolder || undefined,
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
          defaultPath: outputFolder || undefined,
        });
        if (typeof res === "string") {
          setOutputFolder(res);
        }
      } catch (e2) {
        console.error("Choose folder failed:", e2);
      }
    }
  }, [outputFolder]);

  // Models list read from setupConfig
  const availableModels = useMemo(() => {
    if (!setupConfig?.models || setupConfig.models.length === 0) {
      return KNOWN_MODELS;
    }
    const filtered = KNOWN_MODELS.filter((m) => setupConfig.models?.includes(m.id));
    return filtered.length > 0 ? filtered : KNOWN_MODELS;
  }, [setupConfig?.models]);

  // Ensure selected model is one of the available models
  useEffect(() => {
    if (availableModels.length > 0 && !availableModels.some((m) => m.id === selectedModel)) {
      setSelectedModel(availableModels[0].id);
    }
  }, [availableModels, selectedModel]);

  // Available encoders list read from setupConfig
  const availableEncoders = useMemo(() => {
    if (!setupConfig?.encoders || setupConfig.encoders.length === 0) {
      return [];
    }
    return setupConfig.encoders;
  }, [setupConfig?.encoders]);

  // Sync selected encoder with availableEncoders
  useEffect(() => {
    if (availableEncoders.length > 0) {
      if (!selectedEncoder || !availableEncoders.includes(selectedEncoder)) {
        setSelectedEncoder(availableEncoders[0]);
      }
    }
  }, [availableEncoders, selectedEncoder]);

  const activeEncoderName = selectedEncoder
    ? ENCODER_NAMES[selectedEncoder] || selectedEncoder
    : "—";

  const handleCycleEncoder = useCallback(() => {
    if (availableEncoders.length === 0) return;
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
  const trimDuration = isLoaded ? Math.max(0.1, outT - inT) : 0;
  const trimFrames = isLoaded && sourceFps ? Math.round(trimDuration * sourceFps) : 0;
  const estFrames = isLoaded && sourceFps && targetFps ? Math.round(trimFrames * (targetFps / sourceFps)) : 0;

  const estTime = useMemo(() => {
    if (!isLoaded || !estFrames) return "—";
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
  }, [isLoaded, estFrames, setupConfig?.gpu?.ms, probeInfo?.width, probeInfo?.height]);

  const estSizeMB = useMemo(() => {
    if (!isLoaded || !targetFps) return "—";
    return String(Math.max(1, Math.round((trimDuration * 1.24 * targetFps) / 48)));
  }, [isLoaded, trimDuration, targetFps]);

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

  // Folder name display
  const folderName = useMemo(() => {
    if (!outputFolder) return "—";
    const parts = outputFolder.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || "—";
  }, [outputFolder]);

  // Ruler tick items for timeline
  const rulerTicks = useMemo(() => {
    if (!isLoaded || duration <= 0) return [];
    const step = duration > 120 ? 30 : duration > 60 ? 10 : 6;
    const ticks: { pos: number; label: string }[] = [];
    for (let s = 0; s <= duration; s += step) {
      ticks.push({
        pos: (s / duration) * 100,
        label: formatDuration(s),
      });
    }
    return ticks;
  }, [isLoaded, duration]);


  // Lane pointer handlers for trim
  const handleLanePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isLoaded || duration <= 0) return;
    if ((e.target as HTMLElement).closest(".hdl")) return;
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pos = Math.min(duration, Math.max(0, ((e.clientX - rect.left) / rect.width) * duration));
    seekTo(pos);

    const onPointerMove = (ev: PointerEvent) => {
      const curPos = Math.min(duration, Math.max(0, ((ev.clientX - rect.left) / rect.width) * duration));
      seekTo(curPos);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const handleInHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isLoaded || duration <= 0) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect) return;

    const onPointerMove = (ev: PointerEvent) => {
      const pos = Math.min(outT - MIN_TRIM, Math.max(0, ((ev.clientX - rect.left) / rect.width) * duration));
      setInT(pos);
      setPlayhead((ph) => {
        const nextPh = Math.max(ph, pos);
        if (videoRef.current && !codecLimited) {
          videoRef.current.currentTime = nextPh;
        }
        return nextPh;
      });
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const handleOutHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isLoaded || duration <= 0) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect) return;

    const onPointerMove = (ev: PointerEvent) => {
      const pos = Math.max(inT + MIN_TRIM, Math.min(duration, ((ev.clientX - rect.left) / rect.width) * duration));
      setOutT(pos);
      setPlayhead((ph) => {
        const nextPh = Math.min(ph, pos);
        if (videoRef.current && !codecLimited) {
          videoRef.current.currentTime = nextPh;
        }
        return nextPh;
      });
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
          {stageError ? (
            <div className="canvas nv" id="canvas">
              <div className="stage-error">
                <span>Failed to load video</span>
                <small>{stageError}</small>
              </div>
            </div>
          ) : isLoaded ? (
            <div
              className="canvas nv"
              id="canvas"
              data-view={view}
              onClick={handleCanvasClick}
              style={{ cursor: "pointer" }}
            >
              {isMock ? (
                <>
                  <div className="scene orig mock" />
                  <div className="scene res mock" id="res" />
                </>
              ) : (
                <div className="scene">
                  {codecLimited ? (
                    posterUrl ? (
                      <img
                        src={posterUrl}
                        alt="Source frame"
                        style={{ width: "100%", height: "100%", objectFit: "contain" }}
                      />
                    ) : null
                  ) : videoSrc ? (
                    <video
                      ref={videoRef}
                      src={videoSrc}
                      poster={posterUrl || undefined}
                      muted
                      playsInline
                      loop
                      onTimeUpdate={handleTimeUpdate}
                      onEnded={handleEnded}
                      onError={handleVideoError}
                      style={{ width: "100%", height: "100%", objectFit: "contain" }}
                    />
                  ) : null}
                </div>
              )}

              {codecLimited && (
                <div
                  className="quiet-warn preview-warning"
                  style={{
                    position: "absolute",
                    top: "12px",
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: "#0b0b0bd9",
                    border: "1px solid var(--line2)",
                    padding: "4px 10px",
                    borderRadius: "4px",
                    zIndex: 6,
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                  }}
                >
                  Preview limited for this format; the output is not affected
                </div>
              )}

              <div className="vsw v-ready v-done" id="vsw" ref={vswRef} role="tablist">
                <i className="vpill" id="vpill" ref={vpillRef} />
                <button
                  ref={origBtnRef}
                  type="button"
                  data-v="orig"
                  className={view === "orig" ? "on" : ""}
                  onClick={(e) => {
                    e.stopPropagation();
                    isViewClickRef.current = true;
                    setView("orig");
                  }}
                >
                  Original {sourceFps ? <small>{Math.round(sourceFps)} fps</small> : null}
                </button>
                <button
                  ref={resBtnRef}
                  type="button"
                  data-v="res"
                  className={view === "res" ? "on" : ""}
                  onClick={(e) => {
                    e.stopPropagation();
                    isViewClickRef.current = true;
                    setView("res");
                  }}
                >
                  Preview after processing
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
                const filePath = (file as any)?.path;
                if (filePath) {
                  loadVideo(filePath);
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
                <b id="tIn">{isLoaded ? formatTrimTime(inT) : "—"}</b>
              </span>
              <span className="rd">
                <span>Out</span>
                <b id="tOut">{isLoaded ? formatTrimTime(outT) : "—"}</b>
              </span>
              <span className="rd len">
                <span>Length</span>
                <b id="tLen">{isLoaded ? formatTrimTime(trimDuration) : "—"}</b>
              </span>
              <span className="rd">
                <span>Frames</span>
                <b id="tFr">{isLoaded ? trimFrames.toLocaleString() : "—"}</b>
              </span>
            </div>
            <div className="tbs">
              <button
                type="button"
                className="tbn"
                id="trIn"
                onClick={handleSetIn}
                disabled={!isLoaded}
              >
                Set in <kbd>I</kbd>
              </button>
              <button
                type="button"
                className="tbn"
                id="trOut"
                onClick={handleSetOut}
                disabled={!isLoaded}
              >
                Set out <kbd>O</kbd>
              </button>
              <button
                type="button"
                className="tbn mute"
                id="trReset"
                onClick={handleResetTrim}
                disabled={!isLoaded}
              >
                Reset
              </button>
            </div>
          </div>

          <div
            className="lane"
            id="lane"
            ref={laneRef}
            onPointerDown={isLoaded ? handleLanePointerDown : undefined}
          >
            {isLoaded && (
              <>
                <div className="film" id="film">
                  {isMock ? (
                    Array.from({ length: 150 }).map((_, i) => <i key={i} />)
                  ) : (
                    thumbnails.map((thumb, idx) => (
                      <img
                        key={idx}
                        src={thumb}
                        alt=""
                        draggable={false}
                      />
                    ))
                  )}
                </div>
                <div className="shade" id="shL" style={{ width: `${(inT / duration) * 100}%` }} />
                <div
                  className="shade"
                  id="shR"
                  style={{ width: `${Math.max(0, 100 - (outT / duration) * 100)}%` }}
                />
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
              </>
            )}
          </div>

          <div className="rul" id="rul">
            {isLoaded &&
              rulerTicks.map((tick, i) => (
                <span key={i} style={{ left: `${tick.pos}%` }}>
                  {tick.label}
                </span>
              ))}
          </div>
        </div>
      </section>

      {/* Frame Rate Strip (Column 2) */}
      <aside
        ref={frailRef}
        className={`frail nv ${isEditingCustom ? "editing" : ""}`}
        data-file={isLoaded ? "loaded" : "none"}
      >
        <span className="lbl">Frame rate</span>
        <div
          ref={rvRef}
          className={`rv ${isEditingCustom ? "edit" : ""} ${inputErr ? "bad" : ""}`}
        >
          <div className="fr0">
            <span id="fpsFrom">
              {isLoaded && sourceFps ? formatFps(sourceFps) : "—"}
            </span>{" "}
            <i>→</i>
          </div>
          <div className="fr1" id="fpsTo" ref={fpsToRef} style={{ fontSize: `${counterFontSize}px` }}>
            {isLoaded && displayFps !== null ? formatFps(displayFps) : "—"}
          </div>
          <input
            ref={inputRef}
            className="fr1 fin"
            id="fpsIn"
            inputMode="numeric"
            maxLength={3}
            autoComplete="off"
            spellCheck={false}
            aria-label="Custom frame rate"
            value={customInputStr}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onPointerDown={handleInputPointerDown}
            style={{ fontSize: `${counterFontSize}px` }}
          />
          <small>fps</small>
          <div className="stp" id="fpsStp">
            <button
              type="button"
              className="up"
              data-d="1"
              aria-label="Increase"
              onPointerDown={(e) => e.preventDefault()}
              onClick={(e) => {
                stepCustom(e.shiftKey ? 10 : 1);
                inputRef.current?.focus();
              }}
            />
            <button
              type="button"
              className="dn"
              data-d="-1"
              aria-label="Decrease"
              onPointerDown={(e) => e.preventDefault()}
              onClick={(e) => {
                stepCustom(e.shiftKey ? -10 : -1);
                inputRef.current?.focus();
              }}
            />
          </div>
          <div className={`fhint ${inputErr ? "bad" : ""}`} id="fpsHint">
            <span className="fhint-l1">Enter apply · Esc cancel</span>
            <span className="fhint-l2">
              {inputErr || `${minCustomFps}–${MAXF}`}
            </span>
          </div>
        </div>

        <div className="fseg v" id="fseg" ref={fsegRef}>
          <i className="pill" id="pill" ref={pillRef} />
          {fpsRows.map((r) => {
            const isSelected = selectedChoice === r.key;
            return (
              <button
                key={r.key}
                ref={(el) => {
                  buttonRefs.current[r.key] = el;
                }}
                type="button"
                className={`${isSelected ? "on" : ""} ${r.disabled ? "dis" : ""}`}
                aria-disabled={r.disabled ? "true" : undefined}
                title={r.title}
                onClick={() => {
                  if (r.disabled) return;
                  if (r.isCustom) {
                    if (!isEditingCustom) enterEdit();
                  } else {
                    if (isEditingCustom) cancelEdit();
                    isUserClickRef.current = true;
                    setSelectedChoice(r.key);
                    localStorage.setItem("tween_last_fps_choice", r.key);
                  }
                }}
              >
                <b>{r.label}</b>
                <span>{r.sublabel}</span>
              </button>
            );
          })}
        </div>

        <div className="gainv">
          <b id="gainT">
            {isLoaded && sourceFps && currentGainFrames !== null ? (
              <>
                +{currentGainFrames} frames
                <br />
                every second
              </>
            ) : (
              "—"
            )}
          </b>
        </div>
      </aside>

      {/* Inspector / Settings (Column 3) */}
      <aside className="insp" id="insp" data-file={isLoaded ? "loaded" : "none"}>
        <div className="iscroll">
          {/* Warnings */}
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
            <div
              className="row"
              onClick={availableEncoders.length > 0 ? handleCycleEncoder : undefined}
              style={{ cursor: availableEncoders.length > 0 ? "pointer" : "default" }}
            >
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
                <small id="outPath">{outputFolder || "No folder chosen"}</small>
              </div>
              <span>Choose</span>
            </button>
          </div>
        </div>

        {/* Footer with Estimates & Button */}
        <div className="ifoot">
          <div className="est nv">
            <span>
              ~ <b id="estT">{isLoaded ? estTime : "—"}</b>
            </span>
            <span>
              <b id="estF">{isLoaded ? estFrames.toLocaleString() : "—"}</b> frames
            </span>
            <span>
              ~ <b id="estS">{isLoaded ? `${estSizeMB}` : "—"}</b> MB
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
