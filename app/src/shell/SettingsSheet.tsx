import React, { useEffect, useRef, useState, useCallback } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { prefersReducedMotion, springAnim } from "../motion";
import type { SetupConfig, SetupProgressEvent, SetupResult } from "./setupTypes";
import type { SettingsDefaults, StorageInfo } from "./settingsTypes";
import {
  formatBytes,
  loadSettingsDefaults,
  saveSettingsDefaults,
} from "./settingsTypes";

export interface SettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  isJobRunning?: boolean;
  lastJobError?: string | null;
  setupConfig?: SetupConfig | null;
  onSetupUpdated?: (cfg: SetupConfig) => void;
  onDefaultsChanged?: (defaults: SettingsDefaults) => void;
}

interface ModelOption {
  id: string;
  name: string;
  desc: string;
  badge?: string;
}

const DEFAULT_MODELS: ModelOption[] = [
  {
    id: "rife-v4.26",
    name: "Smooth",
    desc: "Best quality for most clips",
    badge: "Recommended",
  },
  {
    id: "rife-v4.25-heavy",
    name: "Detail",
    desc: "Quicker, slightly softer motion",
    badge: "v4",
  },
  {
    id: "rife-v4.22-lite",
    name: "Fast",
    desc: "Tuned for speed on older GPUs",
    badge: "Fast",
  },
];

function sanitizeDiagnostics(text: string): string {
  // Strip any video filenames/paths to ensure privacy
  return text.replace(
    /[A-Za-z0-9_.\-/\\]+\.(mp4|mov|mkv|avi|webm|flv|wmv|m4v|ts|m2ts)/gi,
    "[video file]",
  );
}

export const SettingsSheet: React.FC<SettingsSheetProps> = ({
  isOpen,
  onClose,
  isJobRunning = false,
  lastJobError = null,
  setupConfig = null,
  onSetupUpdated,
  onDefaultsChanged,
}) => {
  const [activeSection, setActiveSection] = useState<string>("system");
  const [copied, setCopied] = useState<boolean>(false);
  const [cleared, setCleared] = useState<boolean>(false);
  const [appVersion, setAppVersion] = useState<string>("0.1.0");
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);

  // Defaults state
  const [defaults, setDefaults] = useState<SettingsDefaults>(() =>
    loadSettingsDefaults(),
  );

  // Notices toggle
  const [noticesOpen, setNoticesOpen] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return /notices=open/.test(window.location.search);
    }
    return false;
  });

  // System check rows state
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [allChecksPassed, setAllChecksPassed] = useState<boolean>(true);
  const [checkRows, setCheckRows] = useState<
    Record<string, { state: string; detail: string }>
  >({});

  // Animation DOM refs
  const rootRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const closingRef = useRef<number>(0);
  const [rendered, setRendered] = useState<boolean>(isOpen);

  // Fetch app version and storage info
  useEffect(() => {
    if (isTauri()) {
      invoke<string>("app_version")
        .then((ver) => setAppVersion(ver))
        .catch(() => {});
    }
  }, []);

  const refreshStorage = useCallback(() => {
    if (isTauri()) {
      invoke<StorageInfo>("storage_info")
        .then((info) => setStorageInfo(info))
        .catch((err) => console.warn("storage_info error:", err));
    } else {
      // Mock storage info for browser preview
      setStorageInfo({
        tempDir: "D:\\Flowmotion\\scratch",
        freeBytes: 214 * 1024 * 1024 * 1024,
        inUseBytes: 1.2 * 1024 * 1024 * 1024,
      });
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      refreshStorage();
      setCleared(false);
    }
  }, [isOpen, refreshStorage]);

  // Section tracking on scroll
  const handleScroll = useCallback(() => {
    const scr = scrollRef.current;
    const sheet = sheetRef.current;
    if (!scr || !sheet) return;

    let current = "system";
    const groups = sheet.querySelectorAll<HTMLElement>(".grp");
    groups.forEach((g) => {
      if (g.offsetTop - scr.scrollTop <= 40) {
        const s = g.dataset.sec;
        if (s) current = s;
      }
    });

    if (scr.scrollTop + scr.clientHeight >= scr.scrollHeight - 4) {
      current = "about";
    }
    setActiveSection(current);
  }, []);

  const scrollToSection = useCallback(
    (sec: string, instant = false) => {
      const scr = scrollRef.current;
      const sheet = sheetRef.current;
      if (!scr || !sheet) return;
      const target = sheet.querySelector<HTMLElement>(`.grp[data-sec="${sec}"]`);
      if (!target) return;

      const isRM = prefersReducedMotion();
      scr.scrollTo({
        top: Math.max(0, target.offsetTop - 1),
        behavior: instant || isRM ? "auto" : "smooth",
      });
      setActiveSection(sec);
    },
    [],
  );

  // Open / Close spring animation
  useEffect(() => {
    const isRM = prefersReducedMotion();
    const sheet = sheetRef.current;
    const ov = overlayRef.current;
    const root = rootRef.current;

    if (isOpen) {
      setRendered(true);
      closingRef.current++;
      if (root) root.hidden = false;

      // Handle preview URL section parameter if present
      if (typeof window !== "undefined") {
        const sec = new URLSearchParams(window.location.search).get("section");
        if (sec) {
          setTimeout(() => scrollToSection(sec, true), 10);
        }
      }

      if (isRM || !sheet || !ov) return;

      ov.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 260,
        easing: "ease-out",
      });
      springAnim(
        sheet,
        [{ transform: "translateX(100%)" }, { transform: "translateX(0)" }],
        0.5,
        1,
      );
    } else {
      const mine = ++closingRef.current;
      if (isRM || !sheet || !ov || !root) {
        setRendered(false);
        if (root) root.hidden = true;
        return;
      }

      ov.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 200,
        easing: "ease-in",
        fill: "forwards",
      });
      const anim = springAnim(
        sheet,
        [{ transform: "translateX(0)" }, { transform: "translateX(100%)" }],
        0.4,
        1,
      );

      const dur = Math.min(
        420,
        (anim.effect?.getTiming().duration as number) || 300,
      );
      setTimeout(() => {
        if (mine === closingRef.current) {
          setRendered(false);
          if (root) root.hidden = true;
          sheet.getAnimations().forEach((a) => a.cancel());
          ov.getAnimations().forEach((a) => a.cancel());
        }
      }, dur);
    }
  }, [isOpen, scrollToSection]);

  // Keyboard shortcut: Esc closes sheet
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, onClose]);

  // Live setup-progress listener when re-running checks
  useEffect(() => {
    if (!isChecking || !isTauri()) return;

    let unsub: (() => void) | undefined;
    listen<SetupProgressEvent>("setup-progress", (event) => {
      const data = event.payload;
      setCheckRows((prev) => ({
        ...prev,
        [data.id]: {
          state: data.state,
          detail: data.detail || "",
        },
      }));
    }).then((fn) => {
      unsub = fn;
    });

    return () => {
      unsub?.();
    };
  }, [isChecking]);

  // Run checks again
  const handleRunChecks = async () => {
    if (isChecking) return;
    setIsChecking(true);
    setAllChecksPassed(false);

    // Set checking state
    const ids = ["system", "gpu", "ffmpeg", "engine", "accel", "encoder"];
    setCheckRows(
      ids.reduce<Record<string, { state: string; detail: string }>>(
        (acc, id) => {
          acc[id] = { state: "checking", detail: "Checking…" };
          return acc;
        },
        {},
      ),
    );

    if (isTauri()) {
      try {
        const res = await invoke<SetupResult>("setup_run", { install: true });
        if (res.cfg) {
          onSetupUpdated?.(res.cfg);
        }
        setAllChecksPassed(res.ok);
      } catch (err) {
        console.error("setup_run failed:", err);
        setAllChecksPassed(false);
      } finally {
        setIsChecking(false);
        refreshStorage();
      }
      return;
    }

    // Dev mock mode simulation
    const isRM = prefersReducedMotion();
    if (isRM) {
      setIsChecking(false);
      setAllChecksPassed(true);
      return;
    }

    ids.forEach((id, i) => {
      setTimeout(() => {
        setCheckRows((prev) => ({
          ...prev,
          [id]: { state: "run", detail: "Verifying…" },
        }));
      }, 150 + i * 250);

      setTimeout(() => {
        setCheckRows((prev) => ({
          ...prev,
          [id]: { state: "ok", detail: "" },
        }));
        if (i === ids.length - 1) {
          setIsChecking(false);
          setAllChecksPassed(true);
        }
      }, 150 + i * 250 + 200);
    });
  };

  // Real or mock row details
  const osText =
    checkRows.system?.detail ||
    `${
      setupConfig?.platform === "win32"
        ? "Windows 11"
        : setupConfig?.platform || "Windows 11"
    } · ${
      typeof navigator !== "undefined"
        ? `${navigator.hardwareConcurrency || 8} threads`
        : "8 threads"
    } · ${formatBytes(storageInfo?.freeBytes || setupConfig?.freeBytes)} free`;

  const gpuName =
    setupConfig?.gpu?.name ||
    setupConfig?.osGpus?.[0]?.name ||
    "RTX 4050 Laptop";
  const driverText = setupConfig?.osGpus?.[0]?.driver
    ? `driver ${setupConfig.osGpus[0].driver}`
    : "driver 566.36";
  const gpuText =
    checkRows.gpu?.detail || `${gpuName} · 6 GB · ${driverText}`;

  const ffmpegText =
    checkRows.ffmpeg?.detail ||
    (setupConfig?.ffmpeg
      ? `${setupConfig.ffmpeg.includes("bundled") ? "Bundled" : "System"} · 9.0.2`
      : "9.0.2 · bundled");

  const modelNames =
    setupConfig?.models && setupConfig.models.length > 0
      ? setupConfig.models
          .map((m) => {
            if (m.includes("4.26")) return "Smooth";
            if (m.includes("4.25")) return "Detail";
            if (m.includes("4.22")) return "Fast";
            return m;
          })
          .join(", ")
      : "Smooth, Detail, Fast";
  const engineText =
    checkRows.engine?.detail || `RIFE v4.6 · ${modelNames}`;

  const accelText =
    checkRows.accel?.detail ||
    (setupConfig?.mode === "cpu"
      ? "CPU mode · slow"
      : `Vulkan 1.3 · ${gpuName}`);

  const encoderText =
    checkRows.encoder?.detail ||
    (setupConfig?.encoders?.length
      ? setupConfig.encoders
          .map((e) => e.toUpperCase().replace("_", " "))
          .join(" / ")
      : "NVENC H.264 / H.265");

  // Copy diagnostics
  const handleCopyDiagnostics = async () => {
    const report = [
      `Tween ${appVersion}`,
      `OS: ${osText}`,
      `Graphics: ${gpuText}`,
      `FFmpeg: ${ffmpegText} (${setupConfig?.ffmpeg || "bundled"})`,
      `Engine: ${engineText} (${setupConfig?.rifeDir || "engine/rife"})`,
      `Mode: ${accelText}`,
      `Encoders: ${encoderText}`,
      `Free disk: ${formatBytes(storageInfo?.freeBytes || setupConfig?.freeBytes)}`,
      lastJobError ? `Last job error: ${sanitizeDiagnostics(lastJobError)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(report);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      console.warn("Failed to copy diagnostics:", err);
    }
  };

  // Defaults actions
  const handleSetModel = (modelId: string) => {
    const updated = { ...defaults, model: modelId };
    setDefaults(updated);
    saveSettingsDefaults(updated);
    onDefaultsChanged?.(updated);
  };

  const handleSetQuality = (q: number) => {
    const updated = { ...defaults, quality: q };
    setDefaults(updated);
    saveSettingsDefaults(updated);
    onDefaultsChanged?.(updated);
  };

  const handlePickDefaultFolder = async () => {
    if (isTauri()) {
      try {
        const picked = await invoke<string | null>("pick_output_folder", {
          defaultPath: defaults.outputFolder || undefined,
        });
        if (picked) {
          const updated = { ...defaults, outputFolder: picked };
          setDefaults(updated);
          saveSettingsDefaults(updated);
          onDefaultsChanged?.(updated);
        }
      } catch (err) {
        console.warn("pick_output_folder error:", err);
      }
    } else {
      // Mock toggle
      const mockList = [
        "D:\\Videos\\Flowmotion",
        "D:\\Video Creation\\Exports",
        "",
      ];
      const idx = mockList.indexOf(defaults.outputFolder);
      const nextFolder = mockList[(idx + 1) % mockList.length];
      const updated = { ...defaults, outputFolder: nextFolder };
      setDefaults(updated);
      saveSettingsDefaults(updated);
      onDefaultsChanged?.(updated);
    }
  };

  const handleToggleAudio = () => {
    const updated = { ...defaults, keepAudio: !defaults.keepAudio };
    setDefaults(updated);
    saveSettingsDefaults(updated);
    onDefaultsChanged?.(updated);
  };

  const handleToggleSceneDetect = () => {
    const updated = { ...defaults, sceneDetect: !defaults.sceneDetect };
    setDefaults(updated);
    saveSettingsDefaults(updated);
    onDefaultsChanged?.(updated);
  };

  // Clear temp files
  const handleClearTemp = async () => {
    if (cleared || isJobRunning) return;
    if (isTauri()) {
      try {
        await invoke("clear_temp");
        setCleared(true);
        refreshStorage();
      } catch (err) {
        console.error("clear_temp failed:", err);
      }
    } else {
      setCleared(true);
      if (storageInfo) {
        setStorageInfo({ ...storageInfo, inUseBytes: 0 });
      }
    }
  };

  // Open safe URL
  const handleOpenAdarzh = async () => {
    const url = "https://adarzh.tech";
    if (isTauri()) {
      try {
        await invoke("open_url", { url });
        return;
      } catch (err) {
        console.warn("open_url error:", err);
      }
    }
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const folderBasename = defaults.outputFolder
    ? defaults.outputFolder.split(/[\\/]/).filter(Boolean).pop() || "Folder"
    : "Flowmotion";

  const getRowState = (id: string) => {
    if (checkRows[id]?.state) return checkRows[id].state;
    return allChecksPassed ? "ok" : "warn";
  };

  return (
    <div
      className="setroot"
      id="setroot"
      ref={rootRef}
      hidden={!rendered && !isOpen}
    >
      <div className="setov" id="setov" ref={overlayRef} onClick={onClose} />
      <aside
        className="sheet"
        id="sheet"
        ref={sheetRef}
        role="dialog"
        aria-label="Settings"
      >
        <div className="sh-head">
          <span className="lbl">Settings</span>
          <span
            className="sh-x"
            id="setX"
            role="button"
            tabIndex={0}
            aria-label="Close settings"
            onClick={onClose}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClose();
              }
            }}
          >
            <svg viewBox="0 0 12 12">
              <path d="M1 1l10 10M11 1L1 11" />
            </svg>
          </span>
        </div>

        <div className="sh-nav" id="shNav">
          <button
            type="button"
            className={activeSection === "system" ? "on" : ""}
            data-sec="system"
            onClick={() => scrollToSection("system")}
          >
            System
          </button>
          <button
            type="button"
            className={activeSection === "defaults" ? "on" : ""}
            data-sec="defaults"
            onClick={() => scrollToSection("defaults")}
          >
            Defaults
          </button>
          <button
            type="button"
            className={activeSection === "storage" ? "on" : ""}
            data-sec="storage"
            onClick={() => scrollToSection("storage")}
          >
            Storage
          </button>
          <button
            type="button"
            className={activeSection === "about" ? "on" : ""}
            data-sec="about"
            onClick={() => scrollToSection("about")}
          >
            About
          </button>
        </div>

        <div
          className="sh-scroll"
          id="shScroll"
          ref={scrollRef}
          onScroll={handleScroll}
        >
          {/* Section: System */}
          <section className="grp" data-sec="system">
            <div className="lbl">
              System
              <em id="shChk">
                {isChecking
                  ? "Checking"
                  : allChecksPassed
                  ? "All checks passed"
                  : "Checks warning"}
              </em>
            </div>
            <div className="sck" id="sck">
              <div className={`ck ${getRowState("system")}`}>
                <i className="ic" />
                <b>System</b>
                <span>{osText}</span>
              </div>
              <div className={`ck ${getRowState("gpu")}`}>
                <i className="ic" />
                <b>Graphics</b>
                <span>{gpuText}</span>
              </div>
              <div className={`ck ${getRowState("ffmpeg")}`}>
                <i className="ic" />
                <b>FFmpeg</b>
                <span>{ffmpegText}</span>
              </div>
              <div className={`ck ${getRowState("engine")}`}>
                <i className="ic" />
                <b>Engine</b>
                <span>{engineText}</span>
              </div>
              <div className={`ck ${getRowState("accel")}`}>
                <i className="ic" />
                <b>GPU acceleration</b>
                <span>{accelText}</span>
              </div>
              <div className={`ck ${getRowState("encoder")}`}>
                <i className="ic" />
                <b>Encoders</b>
                <span>{encoderText}</span>
              </div>
            </div>
            <div className="sh-btns">
              <button
                type="button"
                className="chipb"
                id="shRun"
                onClick={handleRunChecks}
                disabled={isChecking}
              >
                Run checks again
              </button>
              <button
                type="button"
                className={`chipb ${copied ? "ok" : ""}`}
                id="shCopy"
                onClick={handleCopyDiagnostics}
              >
                {copied ? "Copied" : "Copy diagnostics"}
              </button>
            </div>
          </section>

          {/* Section: Defaults */}
          <section className="grp" data-sec="defaults">
            <div className="lbl">Defaults</div>
            <div className="sh-f">
              <span>Default model</span>
              <div className="opt" id="shModel">
                {DEFAULT_MODELS.map((m) => {
                  const isSel = defaults.model === m.id;
                  return (
                    <div
                      key={m.id}
                      className={`model ${isSel ? "on" : ""}`}
                      onClick={() => handleSetModel(m.id)}
                    >
                      <i className="rd" />
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

            <div className="sh-f">
              <span>Default quality</span>
              <div className="seg" id="shQ">
                <button
                  type="button"
                  className={defaults.quality === 23 ? "on" : ""}
                  onClick={() => handleSetQuality(23)}
                >
                  CQ 23
                </button>
                <button
                  type="button"
                  className={defaults.quality === 18 ? "on" : ""}
                  onClick={() => handleSetQuality(18)}
                >
                  CQ 18
                </button>
                <button
                  type="button"
                  className={defaults.quality === 14 ? "on" : ""}
                  onClick={() => handleSetQuality(14)}
                >
                  CQ 14
                </button>
              </div>
            </div>

            <div className="sh-f">
              <span>Default output folder</span>
              <button
                type="button"
                className="pickb"
                onClick={handlePickDefaultFolder}
              >
                <div>
                  <b>{folderBasename}</b>
                  <small>
                    {defaults.outputFolder || "D:\\Videos\\Flowmotion"}
                  </small>
                </div>
                <span>Choose</span>
              </button>
            </div>

            <div className="row">
              <span>Keep audio</span>
              <div
                className={`sw ${defaults.keepAudio ? "" : "off"}`}
                id="shAud"
                onClick={handleToggleAudio}
              />
            </div>

            <div className="row">
              <span>Scene-cut fix</span>
              <div
                className={`sw ${defaults.sceneDetect ? "" : "off"}`}
                id="shScn"
                onClick={handleToggleSceneDetect}
              />
            </div>
          </section>

          {/* Section: Storage */}
          <section className="grp" data-sec="storage">
            <div className="lbl">Storage</div>
            <div className="row">
              <span>Temp folder</span>
              <b>{storageInfo?.tempDir || "D:\\Flowmotion\\scratch"}</b>
            </div>
            <div className="row">
              <span>Free space</span>
              <b>
                {storageInfo
                  ? formatBytes(storageInfo.freeBytes)
                  : "214 GB"}
              </b>
            </div>
            <div className="row">
              <span>In use</span>
              <b id="shUse">
                {cleared
                  ? "0 B"
                  : storageInfo
                  ? formatBytes(storageInfo.inUseBytes)
                  : "1.2 GB"}
              </b>
            </div>
            <div className="sh-btns">
              <button
                type="button"
                className={`chipb ${cleared ? "ok" : ""}`}
                id="shClr"
                onClick={handleClearTemp}
                disabled={cleared || isJobRunning}
              >
                {cleared ? "Cleared" : "Clear temporary files"}
              </button>
            </div>
          </section>

          {/* Section: About */}
          <section className="grp" data-sec="about">
            <div className="lbl">About</div>
            <div className="ab-name">Tween</div>
            <div className="row">
              <span>Version</span>
              <b>{appVersion}</b>
            </div>
            <div className="row">
              <span>Created by adarzh</span>
              <a
                className="lnk"
                href="https://adarzh.tech"
                onClick={(e) => {
                  e.preventDefault();
                  handleOpenAdarzh();
                }}
              >
                adarzh.tech
              </a>
            </div>
            <div className="row">
              <span>Legal</span>
              <button
                className="lnk"
                id="shNot"
                type="button"
                aria-expanded={noticesOpen}
                onClick={() => setNoticesOpen(!noticesOpen)}
              >
                Third-party notices
              </button>
            </div>
            <div
              className={`notices ${noticesOpen ? "open" : ""}`}
              id="shNotices"
            >
              <div>
                <div className="nl">
                  <b>RIFE</b>
                  <span>MIT</span>
                </div>
                <div className="nl">
                  <b>ncnn</b>
                  <span>BSD-3-Clause</span>
                </div>
                <div className="nl">
                  <b>FFmpeg</b>
                  <span>GPL · downloaded build</span>
                </div>
                <div className="nl">
                  <b>Geist</b>
                  <span>SIL OFL 1.1</span>
                </div>
              </div>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
};
