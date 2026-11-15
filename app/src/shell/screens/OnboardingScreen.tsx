import React, { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { prefersReducedMotion, springAnim } from "../../motion";
import type { Screen } from "../types";
import type { SetupConfig, SetupProgressEvent, SetupResult } from "../setupTypes";

export interface OnboardingScreenProps {
  onNavigate?: (screen: Screen) => void;
  initialStep?: number;
  initialAllow?: boolean;
  simulateMissing?: boolean;
}

interface SetupItemCard {
  id: string;
  label: string;
  state: "idle" | "checking" | "installing" | "ok" | "warn" | "error" | "missing" | string;
  detail: string;
  progress?: number | null;
  link?: string | null;
}

const DEFAULT_ITEMS: SetupItemCard[] = [
  { id: "system", label: "System", state: "idle", detail: "—" },
  { id: "gpu", label: "Graphics", state: "idle", detail: "—" },
  { id: "ffmpeg", label: "FFmpeg", state: "idle", detail: "—" },
  { id: "engine", label: "Interpolation engine", state: "idle", detail: "—" },
  { id: "accel", label: "GPU acceleration", state: "idle", detail: "—" },
  { id: "encoder", label: "Video encoder", state: "idle", detail: "—" },
];

const META = ["Welcome", "System check", "Access"] as const;
const NEXT = ["Get started", "Continue", "Finish"] as const;
const PRIV = [
  "Runs on your GPU. Your videos never leave this device.",
  "Checked locally. Nothing is uploaded.",
  "You can change these any time in Settings.",
] as const;

export const OnboardingScreen: React.FC<OnboardingScreenProps> = ({
  onNavigate,
  initialStep = 0,
  initialAllow = false,
  simulateMissing = false,
}) => {
  const [step, setStep] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const s = p.get("step");
      if (s !== null && !isNaN(Number(s))) {
        return Math.min(2, Math.max(0, Number(s)));
      }
    }
    return Math.min(2, Math.max(0, initialStep));
  });

  const [cards, setCards] = useState<SetupItemCard[]>(() => DEFAULT_ITEMS);
  const [setupOk, setSetupOk] = useState<boolean>(false);
  const [setupConfig, setSetupConfig] = useState<SetupConfig | null>(null);
  const [computeDevice, setComputeDevice] = useState<"gpu" | "cpu">("gpu");

  // Page 3 permissions state
  const [readAllowed, setReadAllowed] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return /allow=1/.test(window.location.search) || initialAllow;
    }
    return initialAllow;
  });
  const [outputFolder, setOutputFolder] = useState<string>("D:\\Videos\\Flowmotion");
  const [scratchFolder, setScratchFolder] = useState<string>("D:\\Flowmotion\\scratch");
  const [shellMenu, setShellMenu] = useState<boolean>(true);

  // Animation and DOM refs
  const welcomeRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const fpsRef = useRef<HTMLElement | null>(null);
  const barRefs = useRef<(HTMLElement | null)[]>([]);
  const pipRef = useRef<HTMLElement | null>(null);
  const ln1Ref = useRef<HTMLSpanElement | null>(null);
  const ln2Ref = useRef<HTMLSpanElement | null>(null);
  const pg1Ref = useRef<HTMLElement | null>(null);
  const pg2Ref = useRef<HTMLElement | null>(null);

  // Active run identifier for animation loop cancelling
  const runIdRef = useRef<number>(0);

  // Sync initialStep if it changes externally
  useEffect(() => {
    if (initialStep !== undefined && initialStep !== step) {
      setStep(Math.min(2, Math.max(0, initialStep)));
    }
  }, [initialStep]);

  // Page 1 Welcome Motion
  useEffect(() => {
    if (step !== 0) {
      runIdRef.current++;
      if (playheadRef.current) {
        playheadRef.current.style.opacity = "0";
      }
      return;
    }

    const isRM =
      prefersReducedMotion() ||
      (typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).has("step"));

    const mine = ++runIdRef.current;
    if (fpsRef.current) fpsRef.current.textContent = "24";

    const ruler = rulerRef.current;
    const playhead = playheadRef.current;
    const fps = fpsRef.current;
    const oddBars = barRefs.current.filter((_, i) => i % 2 !== 0 && _ !== null);

    // Cancel existing animations on odd bars
    oddBars.forEach((g) => {
      g?.getAnimations().forEach((a) => a.cancel());
      if (g) g.style.opacity = isRM ? "0" : "";
    });

    if (isRM) {
      return;
    }

    // Intro spring animations
    if (ln1Ref.current) {
      springAnim(
        ln1Ref.current,
        [{ transform: "translateY(105%)" }, { transform: "translateY(0)" }],
        0.7,
        0.82,
        { delay: 120 },
      );
    }
    if (ln2Ref.current) {
      springAnim(
        ln2Ref.current,
        [{ transform: "translateY(105%)" }, { transform: "translateY(0)" }],
        0.7,
        0.82,
        { delay: 230 },
      );
    }

    const w = welcomeRef.current;
    if (w) {
      const top = w.querySelector<HTMLElement>(".h-top");
      const sub = w.querySelector<HTMLElement>(".sub");
      const rlHead = w.querySelector<HTMLElement>(".rl-head");
      const foot = w.querySelector<HTMLElement>(".w-foot");
      if (top) {
        springAnim(
          top,
          [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }],
          0.6,
          0.9,
          { delay: 0 },
        );
      }
      if (sub) {
        springAnim(
          sub,
          [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }],
          0.6,
          0.9,
          { delay: 380 },
        );
      }
      if (rlHead) {
        springAnim(
          rlHead,
          [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }],
          0.6,
          0.9,
          { delay: 520 },
        );
      }
      if (foot) {
        springAnim(
          foot,
          [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }],
          0.6,
          0.9,
          { delay: 700 },
        );
      }
    }

    // Even bars scale up
    barRefs.current.forEach((b, i) => {
      if (b && i % 2 === 0) {
        springAnim(
          b,
          [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
          0.55,
          0.55,
          { delay: 500 + i * 18 },
        );
      }
    });

    if (pipRef.current) {
      springAnim(
        pipRef.current,
        [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        0.6,
        0.9,
        { delay: 900 },
      );
    }

    // Start sweep loop
    let rafId = 0;
    const startLoopTimeout = window.setTimeout(() => {
      if (mine !== runIdRef.current || !ruler || !playhead || !fps) return;

      const T = 5200;
      let phase: "sweep" | "hold" | "reset" = "sweep";
      let t0 = performance.now();
      let holdUntil = 0;
      const shown = new Set<number>();

      const setFpsValue = (v: string) => {
        if (fps.textContent === v) return;
        fps.textContent = v;
        springAnim(
          fps,
          [{ transform: "translateY(60%)", opacity: 0 }, { transform: "none", opacity: 1 }],
          0.4,
          0.7,
        );
      };

      const frame = (now: number) => {
        if (mine !== runIdRef.current) {
          playhead.style.opacity = "0";
          return;
        }

        if (phase === "sweep") {
          const p = Math.min(1, (now - t0) / T);
          const x = p * ruler.clientWidth;
          playhead.style.opacity = "1";
          playhead.style.transform = `translateX(${x}px)`;

          oddBars.forEach((g, idx) => {
            if (g && !shown.has(idx) && g.offsetLeft + 1 <= x) {
              shown.add(idx);
              g.getAnimations().forEach((a) => a.cancel());
              springAnim(
                g,
                [{ opacity: 0, transform: "scaleY(0)" }, { opacity: 0.8, transform: "scaleY(1)" }],
                0.42,
                0.5,
              );
            }
          });

          if (shown.size > 0) {
            setFpsValue("48");
          }

          if (p >= 1) {
            phase = "hold";
            holdUntil = now + 1800;
            playhead.style.opacity = "0";
          }
        } else if (phase === "hold") {
          if (now >= holdUntil) {
            phase = "reset";
            holdUntil = now + 650;
            setFpsValue("24");
            oddBars.forEach((g) => {
              if (g) {
                g.animate([{ opacity: 0.8 }, { opacity: 0 }], {
                  duration: 420,
                  fill: "forwards",
                });
              }
            });
          }
        } else if (now >= holdUntil) {
          oddBars.forEach((g) => {
            if (g) {
              g.getAnimations().forEach((a) => a.cancel());
              g.style.opacity = "";
            }
          });
          shown.clear();
          phase = "sweep";
          t0 = now;
        }

        rafId = requestAnimationFrame(frame);
      };

      rafId = requestAnimationFrame(frame);
    }, 500 + 41 * 18 + 500);

    return () => {
      runIdRef.current++;
      clearTimeout(startLoopTimeout);
      cancelAnimationFrame(rafId);
      if (playheadRef.current) {
        playheadRef.current.style.opacity = "0";
      }
    };
  }, [step]);

  // Cursor magnetism on ruler
  const magRef = useRef<{ s: number; v: number }[]>(
    Array.from({ length: 41 }, () => ({ s: 1, v: 0 })),
  );
  const mxRef = useRef<number | null>(null);
  const magRafRef = useRef<number>(0);

  const handleRulerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!rulerRef.current) return;
    const rect = rulerRef.current.getBoundingClientRect();
    mxRef.current = e.clientX - rect.left;
    kickMag();
  };

  const handleRulerPointerLeave = () => {
    mxRef.current = null;
    kickMag();
  };

  const kickMag = () => {
    if (!magRafRef.current && !prefersReducedMotion()) {
      magRafRef.current = requestAnimationFrame(stepMag);
    }
  };

  const stepMag = () => {
    let moving = false;
    const mx = mxRef.current;
    barRefs.current.forEach((b, i) => {
      if (!b) return;
      const tg =
        mx === null ? 1 : 1 + 0.5 * Math.exp(-(((b.offsetLeft + 1 - mx) / 60) ** 2));
      const s = magRef.current[i];
      s.v += (-260 * (s.s - tg) - 26 * s.v) / 60;
      s.s += s.v / 60;
      if (Math.abs(s.s - tg) > 0.002 || Math.abs(s.v) > 0.01) {
        moving = true;
      }
      b.style.transform = `scaleY(${s.s.toFixed(3)})`;
    });
    magRafRef.current = moving ? requestAnimationFrame(stepMag) : 0;
  };

  // Step entry spring animations
  useEffect(() => {
    if (step === 0 || prefersReducedMotion()) return;
    const pg = step === 1 ? pg1Ref.current : pg2Ref.current;
    if (!pg) return;
    const children = Array.from(pg.children) as HTMLElement[];
    children.forEach((c, i) => {
      springAnim(
        c,
        [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }],
        0.55,
        0.88,
        { delay: 80 + i * 70 },
      );
    });
  }, [step]);

  // Page 2: Run setup checks
  const runSetupChecks = async () => {
    setSetupOk(false);

    // Initialise cards in checking state with neutral placeholder
    setCards((prev) =>
      prev.map((c) => ({
        ...c,
        state: "checking",
        detail: c.id === "accel" ? "Running a test frame" : "Waiting",
        progress: null,
      })),
    );

    if (isTauri()) {
      try {
        const res = await invoke<SetupResult>("setup_run", { install: true });
        setSetupOk(res.ok);
        setSetupConfig(res.cfg);
      } catch (err) {
        console.error("setup_run failed:", err);
        setSetupOk(false);
      }
      return;
    }

    // Only in development when explicitly requested via ?mock=1 in URL
    if (
      import.meta.env.DEV &&
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("mock") === "1"
    ) {
      simulateDevMockChecks();
    }
  };

  // Listen to live Tauri progress events on Page 2
  useEffect(() => {
    if (step !== 1 || !isTauri()) return;

    let unlisten: (() => void) | undefined;
    listen<SetupProgressEvent>("setup-progress", (event) => {
      const data = event.payload;
      setCards((prev) => {
        const idx = prev.findIndex((c) => c.id === data.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            label: data.label || next[idx].label,
            state: data.state,
            detail: data.detail,
            progress: data.progress,
            link: data.link,
          };
          return next;
        }
        return [
          ...prev,
          {
            id: data.id,
            label: data.label,
            state: data.state,
            detail: data.detail,
            progress: data.progress,
            link: data.link,
          },
        ];
      });
    }).then((fn) => {
      unlisten = fn;
    });

    runSetupChecks();

    return () => {
      if (unlisten) unlisten();
    };
  }, [step]);

  // Dev mock simulation for browser testing (?mock=1)
  const simulateDevMockChecks = () => {
    const isRM = prefersReducedMotion();
    const isMissing =
      simulateMissing ||
      (typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("missing") === "1");
    const missingIds = isMissing ? ["ffmpeg", "engine"] : [];

    const mockDetails: Record<string, { label: string; detail: string; state: string }> = {
      system: { label: "System", detail: "Dev Mock · 64 GB free", state: "ok" },
      gpu: { label: "Graphics", detail: "Detected graphics device", state: "ok" },
      ffmpeg: {
        label: "FFmpeg",
        detail: missingIds.includes("ffmpeg")
          ? "Not found · 85 MB to download"
          : "Bundled",
        state: missingIds.includes("ffmpeg") ? "missing" : "ok",
      },
      engine: {
        label: "Interpolation engine",
        detail: missingIds.includes("engine")
          ? "Not found · 448 MB to download"
          : "RIFE",
        state: missingIds.includes("engine") ? "missing" : "ok",
      },
      accel: { label: "GPU acceleration", detail: "Compute ready", state: "ok" },
      encoder: { label: "Video encoder", detail: "Hardware encoder", state: "ok" },
    };

    if (isRM) {
      setCards((prev) =>
        prev.map((c) => {
          const info = mockDetails[c.id];
          return info ? { ...c, ...info } : c;
        }),
      );
      setSetupOk(missingIds.length === 0);
      return;
    }

    DEFAULT_ITEMS.forEach((item, i) => {
      window.setTimeout(() => {
        setCards((prev) =>
          prev.map((c) => (c.id === item.id ? { ...c, state: "checking" } : c)),
        );
      }, 200 + i * 300);

      window.setTimeout(() => {
        const info = mockDetails[item.id];
        setCards((prev) =>
          prev.map((c) => (c.id === item.id ? { ...c, ...info } : c)),
        );
        if (i === DEFAULT_ITEMS.length - 1) {
          setSetupOk(missingIds.length === 0);
        }
      }, 200 + i * 300 + 250);
    });
  };

  // Simulate download for missing items in dev mock mode
  const handleDownloadCard = (id: string) => {
    if (!import.meta.env.DEV) return;
    setCards((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, state: "installing", progress: 0 } : c,
      ),
    );

    let p = 0;
    const interval = window.setInterval(() => {
      p += 25;
      if (p >= 100) {
        clearInterval(interval);
        setCards((prev) =>
          prev.map((c) => {
            if (c.id === id) {
              const detail = id === "ffmpeg" ? "Bundled" : "RIFE";
              return { ...c, state: "ok", detail, progress: null };
            }
            return c;
          }),
        );
      } else {
        setCards((prev) =>
          prev.map((c) =>
            c.id === id ? { ...c, progress: p / 100 } : c,
          ),
        );
      }
    }, 120);
  };

  const handleDownloadAll = () => {
    if (!import.meta.env.DEV) return;
    cards.forEach((c) => {
      if (c.state === "missing") {
        handleDownloadCard(c.id);
      }
    });
  };

  // Check if all cards have passed (ok or warn)
  const passedCount = cards.filter(
    (c) => c.state === "ok" || c.state === "warn",
  ).length;
  const missingCount = cards.filter(
    (c) => c.state === "missing" || c.state === "installing",
  ).length;
  const errorCount = cards.filter((c) => c.state === "error").length;
  const hasMissing = cards.some((c) => c.state === "missing");
  const hasError = cards.some((c) => c.state === "error");

  // Keep Continue enabled once real setup returns ok: true or all passed
  useEffect(() => {
    if (passedCount === 6) {
      setSetupOk(true);
    }
  }, [passedCount]);

  const handleOpenUrl = async (url: string) => {
    if (isTauri()) {
      try {
        await invoke("open_url", { url });
        return;
      } catch (err) {
        console.error("open_url command failed:", err);
      }
    }
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const handleRetry = () => {
    runSetupChecks();
  };

  const handleNext = () => {
    if (step < 2) {
      setStep(step + 1);
    } else {
      handleFinish();
    }
  };

  const handleBack = () => {
    if (step > 0) {
      setStep(step - 1);
    }
  };

  const handleSkip = () => {
    handleFinish();
  };

  const handleFinish = () => {
    const isRM = prefersReducedMotion();
    if (isRM || !welcomeRef.current) {
      onNavigate?.("ready");
      return;
    }
    springAnim(
      welcomeRef.current,
      [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.985)" }],
      0.45,
      1,
    );
    window.setTimeout(() => {
      onNavigate?.("ready");
    }, 380);
  };

  const handleBrowseOutput = () => {
    const list = [
      "D:\\Videos\\Flowmotion",
      "D:\\Video Creation\\Exports",
      "C:\\Users\\You\\Downloads",
    ];
    const currIdx = list.indexOf(outputFolder);
    const nextIdx = (currIdx + 1) % list.length;
    setOutputFolder(list[nextIdx]);
  };

  const handleBrowseScratch = () => {
    const list = [
      "D:\\Flowmotion\\scratch",
      "C:\\Users\\You\\AppData\\Local\\Temp\\tween",
      "E:\\Scratch",
    ];
    const currIdx = list.indexOf(scratchFolder);
    const nextIdx = (currIdx + 1) % list.length;
    setScratchFolder(list[nextIdx]);
  };

  // Next button disable logic matching mock
  const isNextDisabled =
    (step === 1 && !setupOk && passedCount < 6) ||
    (step === 2 && !readAllowed);

  // Compute card details based on selected compute device
  const displayCards = cards.map((c) => {
    if (c.id === "gpu" && computeDevice === "cpu") {
      return { ...c, detail: "CPU fallback · slow" };
    }
    return c;
  });

  const detectedGpu =
    setupConfig?.gpu?.name ||
    setupConfig?.osGpus?.[0]?.name;
  const gpuDisplayName = detectedGpu || "your graphics card";

  return (
    <div className="ws">
      <div className="stage" style={{ padding: 0, placeItems: "stretch", background: "var(--bg)" }}>
        <div
          className="home welcome"
          ref={welcomeRef}
          data-step={step}
        >
          {/* Top Bar */}
          <div className="h-top">
            <span className="lbl">{META[step]}</span>
            <button
              type="button"
              className="skip"
              onClick={handleSkip}
            >
              Skip
            </button>
          </div>

          {/* Three Onboarding Pages */}
          <div className="w-pages">
            {/* Page 1: Welcome */}
            <section className="pg w-mid" data-p="0">
              <div className="hd">
                <h1>
                  <span className="ln"><span ref={ln1Ref}>Between</span></span>
                  <span className="ln"><span ref={ln2Ref}>every frame.</span></span>
                </h1>
                <p className="sub">
                  Flowmotion adds the frames your footage never had, so 24 or 30 fps video plays as smooth as 60.
                </p>
              </div>

              <div className="vz">
                <div className="rl-head">
                  <span className="lbl">Timeline</span>
                  <span className="fpsx">
                    <b ref={fpsRef}>24</b> fps
                  </span>
                </div>
                <div
                  className="ruler"
                  ref={rulerRef}
                  onPointerMove={handleRulerPointerMove}
                  onPointerLeave={handleRulerPointerLeave}
                >
                  {Array.from({ length: 41 }, (_, i) => (
                    <i
                      key={i}
                      ref={(el) => { barRefs.current[i] = el; }}
                      className={i % 2 !== 0 ? "g" : "o"}
                    />
                  ))}
                  <div className="playhead" ref={playheadRef} />
                </div>
              </div>
            </section>

            {/* Page 2: System check */}
            <section className="pg" data-p="1" ref={pg1Ref}>
              <div className="hd">
                <h1 className="h1s">Checking your machine.</h1>
                <p className="sub">
                  We look for a Vulkan GPU, FFmpeg and free disk space. Nothing leaves your device.
                </p>
              </div>

              <div className="vz">
                <div className="rl-head">
                  <span className="lbl">System check</span>
                  <div className="hr">
                    {hasMissing && (
                      <button
                        type="button"
                        className="chipb solidb"
                        onClick={handleDownloadAll}
                      >
                        Download all · 533 MB
                      </button>
                    )}
                    <span className="lbl">Compute with</span>
                    <div className="seg">
                      <button
                        type="button"
                        className={computeDevice === "gpu" ? "on" : ""}
                        onClick={() => setComputeDevice("gpu")}
                      >
                        {detectedGpu ? `${gpuDisplayName} · GPU` : "GPU"}
                      </button>
                      <button
                        type="button"
                        className={computeDevice === "cpu" ? "on" : ""}
                        onClick={() => setComputeDevice("cpu")}
                      >
                        CPU · slow
                      </button>
                    </div>
                    <span className="fpsx">
                      <b>
                        {passedCount}/6 passed
                        {hasMissing ? ` · ${missingCount} missing` : hasError ? ` · ${errorCount} failed` : ""}
                      </b>
                    </span>
                  </div>
                </div>

                <div className="cks">
                  {displayCards.map((c) => {
                    let stateClass = "";
                    if (c.state === "checking") stateClass = "run";
                    else if (c.state === "installing") stateClass = "dling";
                    else if (c.state === "ok") stateClass = "ok";
                    else if (c.state === "warn") stateClass = "warn";
                    else if (c.state === "error") stateClass = "error";
                    else if (c.state === "missing") stateClass = "miss";

                    return (
                      <div key={c.id} className={`ck ${stateClass}`}>
                        <i className="ic" />
                        <b>{c.label}</b>
                        <span>{c.detail}</span>

                        {/* Installing / progress bar */}
                        {c.state === "installing" && (
                          <div className="dl">
                            <i className="bar">
                              <b
                                style={{
                                  width: `${Math.round((c.progress ?? 0) * 100)}%`,
                                }}
                              />
                            </i>
                            <span className="pc">
                              {Math.round((c.progress ?? 0) * 100)}%
                              {c.id === "ffmpeg"
                                ? " · 85 MB"
                                : c.id === "engine"
                                ? " · 448 MB"
                                : ""}
                            </span>
                          </div>
                        )}

                        {/* Missing card action */}
                        {c.state === "missing" && (
                          <div className="dl">
                            <span className="msg">
                              Not found · {c.id === "ffmpeg" ? "85 MB" : "448 MB"} to download
                            </span>
                            <button
                              type="button"
                              className="chipb"
                              onClick={() => handleDownloadCard(c.id)}
                            >
                              Download
                            </button>
                          </div>
                        )}

                        {/* Error card retry action */}
                        {c.state === "error" && (
                          <div className="dl">
                            <button
                              type="button"
                              className="chipb"
                              onClick={handleRetry}
                            >
                              Retry
                            </button>
                          </div>
                        )}

                        {/* External link action (driver updates) */}
                        {c.link && (
                          <div className="dl">
                            <button
                              type="button"
                              className="chipb"
                              onClick={() => handleOpenUrl(c.link!)}
                            >
                              Update driver
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* Page 3: Access / Permissions */}
            <section className="pg" data-p="2" ref={pg2Ref}>
              <div className="hd">
                <h1 className="h1s">Set up access.</h1>
                <p className="sub">
                  Choose what Flowmotion may read and where it writes. You can change this later.
                </p>
              </div>

              <div className="vz">
                <div className="rl-head">
                  <span className="lbl">Permissions</span>
                  <span className="fpsx">
                    <b>{readAllowed ? "Read granted" : "Read not granted"}</b>
                  </span>
                </div>

                <div className="acg">
                  <div className="ac">
                    <div>
                      <b>Read your videos</b>
                      <span>Videos · Downloads</span>
                    </div>
                    <button
                      type="button"
                      className={`chipb ${readAllowed ? "on" : ""}`}
                      onClick={() => setReadAllowed((prev) => !prev)}
                    >
                      {readAllowed ? "Allowed" : "Allow access"}
                    </button>
                  </div>

                  <div className="ac">
                    <div>
                      <b>Output folder</b>
                      <span>{outputFolder}</span>
                    </div>
                    <button
                      type="button"
                      className="chipb"
                      onClick={handleBrowseOutput}
                    >
                      Browse
                    </button>
                  </div>

                  <div className="ac">
                    <div>
                      <b>Scratch folder</b>
                      <span>{scratchFolder}</span>
                    </div>
                    <button
                      type="button"
                      className="chipb"
                      onClick={handleBrowseScratch}
                    >
                      Browse
                    </button>
                  </div>

                  <div className="ac">
                    <div>
                      <b>Right-click menu</b>
                      <span>“Interpolate with Flowmotion”</span>
                    </div>
                    <div
                      className={`sw ${shellMenu ? "" : "off"}`}
                      onClick={() => setShellMenu((prev) => !prev)}
                    />
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* Footer */}
          <div className="w-foot">
            <div className="steps">
              <span className="lbl">{`0${step + 1} / 03`}</span>
              <div className="pips">
                <i className={step >= 0 ? "on" : ""} ref={pipRef} />
                <i className={step >= 1 ? "on" : ""} />
                <i className={step >= 2 ? "on" : ""} />
              </div>
            </div>

            <span className="priv">{PRIV[step]}</span>

            <button
              type="button"
              className="btn ghost back"
              onClick={handleBack}
            >
              Back
            </button>

            <button
              type="button"
              className="btn solid cta"
              disabled={isNextDisabled}
              onClick={handleNext}
            >
              {NEXT[step]} <span>→</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
