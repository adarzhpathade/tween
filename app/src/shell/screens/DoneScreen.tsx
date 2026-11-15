import React, { useState, useRef, useEffect, useCallback } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Screen, ProbeInfo, JobRequest, JobFinished } from "../types";
import { loadSettingsDefaults } from "../settingsTypes";

export interface DoneScreenProps {
  probeInfo?: ProbeInfo | null;
  jobRequest?: JobRequest | null;
  jobFinished?: JobFinished | null;
  error?: string | null;
  modelName?: string;
  onTryAgain?: () => void;
  onInterpolateAnother?: () => void;
  onShowInFolder?: () => void;
  onNavigate?: (screen: Screen) => void;
}

function fmtDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtBytesMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function formatCodec(codec: string): string {
  const upper = codec.toUpperCase();
  if (upper === "H264" || upper === "AVC1") return "H.264";
  if (upper === "HEVC" || upper === "H265") return "H.265";
  return upper;
}

export const DoneScreen: React.FC<DoneScreenProps> = ({
  probeInfo,
  jobRequest,
  jobFinished,
  error,
  modelName,
  onTryAgain,
  onInterpolateAnother,
  onShowInFolder,
  onNavigate,
}) => {
  const isMock = Boolean(
    import.meta.env.DEV &&
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("mock") === "1"
  );

  const [view, setView] = useState<"orig" | "res">("res");
  const origVideoRef = useRef<HTMLVideoElement>(null);
  const resVideoRef = useRef<HTMLVideoElement>(null);

  // Switch pill animation state
  const origBtnRef = useRef<HTMLButtonElement>(null);
  const resBtnRef = useRef<HTMLButtonElement>(null);
  const [pillStyle, setPillStyle] = useState<React.CSSProperties>({});

  const updatePill = useCallback(() => {
    const activeBtn = view === "orig" ? origBtnRef.current : resBtnRef.current;
    if (activeBtn) {
      setPillStyle({
        transform: `translateX(${activeBtn.offsetLeft}px)`,
        width: `${activeBtn.offsetWidth}px`,
      });
    }
  }, [view]);

  useEffect(() => {
    updatePill();
  }, [updatePill]);

  // Video paths
  const origFile = probeInfo?.file || jobRequest?.info.file;
  const resFile = jobFinished?.output || jobRequest?.output;

  const origSrc = origFile ? convertFileSrc(origFile) : "";
  const resSrc = resFile ? convertFileSrc(resFile) : "";

  // Synchronized playback
  useEffect(() => {
    const orig = origVideoRef.current;
    const res = resVideoRef.current;
    if (!orig || !res) return;

    orig.play().catch(() => {});
    res.play().catch(() => {});
  }, [origSrc, resSrc]);

  const handleOrigTimeUpdate = () => {
    const orig = origVideoRef.current;
    const res = resVideoRef.current;
    if (!orig || !res) return;

    if (Math.abs(orig.currentTime - res.currentTime) > 0.05) {
      res.currentTime = orig.currentTime;
    }
  };

  const handleOrigPlay = () => {
    resVideoRef.current?.play().catch(() => {});
  };

  const handleOrigPause = () => {
    resVideoRef.current?.pause();
  };

  const handleOrigSeeked = () => {
    if (origVideoRef.current && resVideoRef.current) {
      resVideoRef.current.currentTime = origVideoRef.current.currentTime;
    }
  };

  const handleCanvasClick = useCallback(() => {
    const orig = origVideoRef.current;
    const res = resVideoRef.current;
    if (!orig && !res) return;

    const anyPlaying = (orig && !orig.paused) || (res && !res.paused);
    if (anyPlaying) {
      orig?.pause();
      res?.pause();
    } else {
      orig?.play().catch(() => {});
      res?.play().catch(() => {});
    }
  }, []);

  // Space key toggles synchronized playback
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        handleCanvasClick();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCanvasClick]);

  // Actions
  const handleShowInFolder = () => {
    if (onShowInFolder) {
      onShowInFolder();
    } else if (resFile) {
      invoke("show_in_folder", { path: resFile }).catch((err) => {
        console.warn("Failed to show in folder:", err);
      });
    }
  };

  const handleInterpolateAnother = () => {
    if (onInterpolateAnother) {
      onInterpolateAnother();
    } else {
      onNavigate?.("ready");
    }
  };

  const handleTryAgain = () => {
    if (onTryAgain) {
      onTryAgain();
    } else {
      onNavigate?.("ready");
    }
  };

  // Error state
  const isError = Boolean(error || (jobFinished && !jobFinished.ok && !jobFinished.cancelled));
  const errorMessage = error || jobFinished?.error || "Interpolation failed";

  // Data formatting without fake fallbacks
  const sourceFps = probeInfo?.fps || jobRequest?.info.fps || (isMock ? 24 : null);
  let targetFps: number | null = null;
  if (jobRequest?.target) {
    if (jobRequest.target.mode === "multiplier") {
      targetFps = sourceFps ? Math.round(sourceFps * (Number(jobRequest.target.value) || 2)) : null;
    } else {
      targetFps = Math.round(Number(jobRequest.target.value) || 48);
    }
  } else if (isMock) {
    targetFps = 48;
  }

  const outFileName = resFile
    ? resFile.split(/[\\/]/).pop() || "—"
    : isMock
    ? "beach_sunset_48fps.mp4"
    : "—";

  const savedFolderPath =
    (resFile
      ? resFile.replace(/[\\/][^\\/]+$/, "")
      : jobRequest?.output
      ? jobRequest.output.replace(/[\\/][^\\/]+$/, "")
      : loadSettingsDefaults().outputFolder ||
        (isMock ? "C:\\Users\\You\\Videos\\Tween" : "—")) || "—";

  const sizeText =
    jobFinished?.outSize != null
      ? fmtBytesMb(jobFinished.outSize)
      : probeInfo?.size != null
      ? fmtBytesMb(probeInfo.size)
      : isMock
      ? "38 MB"
      : "—";

  const resolutionText = probeInfo
    ? `${probeInfo.width}×${probeInfo.height}`
    : isMock
    ? "1920×1080"
    : "—";

  const sourceFrames = probeInfo?.frames || jobRequest?.info.frames || (isMock ? 1008 : null);
  const outFrames =
    jobFinished?.frames != null
      ? jobFinished.frames
      : targetFps && sourceFps && sourceFrames
      ? Math.round(sourceFrames * (targetFps / sourceFps))
      : isMock
      ? 2016
      : null;

  const durationSec = probeInfo?.duration || (isMock ? 42 : null);
  const fmeta = probeInfo
    ? `${probeInfo.width}×${probeInfo.height} · ${Math.round(probeInfo.fps)} fps · ${durationSec != null ? fmtDuration(durationSec) : "—"} · ${formatCodec(probeInfo.codec)}${probeInfo.hasAudio ? " · AAC" : ""} · ${sourceFrames?.toLocaleString() ?? "—"} frames`
    : isMock
    ? "1920×1080 · 24 fps · 0:42 · H.264 · AAC · 1,008 frames"
    : null;

  const headerFileName = probeInfo?.name || (isMock ? "beach_sunset_24fps.mp4" : "—");

  const timeTakenStr =
    jobFinished?.seconds != null
      ? fmtDuration(jobFinished.seconds)
      : isMock
      ? "0:58"
      : null;

  const avgSpeed =
    jobFinished?.seconds != null && jobFinished.seconds > 0 && outFrames != null
      ? Math.round(outFrames / jobFinished.seconds)
      : isMock
      ? 38
      : null;

  const resultSubtitle =
    timeTakenStr != null
      ? avgSpeed != null
        ? `in ${timeTakenStr} · ${avgSpeed} fps average`
        : `in ${timeTakenStr}`
      : null;

  const displayModel = modelName || jobRequest?.model || (isMock ? "Balanced" : "—");

  return (
    <>
      <section className="ws">
        <div className="fh">
          <div>
            <span className="lbl" id="fhLbl">01 · Source</span>
            <h2 id="fhName">{headerFileName}</h2>
            {fmeta ? <div className="fmeta" id="fhMeta">{fmeta}</div> : null}
          </div>
        </div>

        <div className="stage">
          <div
            className="canvas"
            id="canvas"
            data-view={view}
            onClick={handleCanvasClick}
            style={{ cursor: "pointer" }}
          >
            <div className={`scene orig ${isMock ? "mock" : ""}`}>
              {origSrc ? (
                <video
                  ref={origVideoRef}
                  src={origSrc}
                  playsInline
                  muted
                  loop
                  onTimeUpdate={handleOrigTimeUpdate}
                  onPlay={handleOrigPlay}
                  onPause={handleOrigPause}
                  onSeeked={handleOrigSeeked}
                  style={{ width: "100%", height: "100%", objectFit: "contain" }}
                />
              ) : null}
            </div>

            <div className={`scene res ${isMock ? "mock" : ""}`} id="res">
              {resSrc ? (
                <video
                  ref={resVideoRef}
                  src={resSrc}
                  playsInline
                  muted
                  loop
                  style={{ width: "100%", height: "100%", objectFit: "contain" }}
                />
              ) : null}
            </div>

            <div className="vsw v-ready v-done" id="vsw" role="tablist">
              <i className="vpill" id="vpill" style={pillStyle} />
              <button
                ref={origBtnRef}
                type="button"
                className={view === "orig" ? "on" : ""}
                onClick={(e) => {
                  e.stopPropagation();
                  setView("orig");
                }}
              >
                Original {sourceFps ? <small>{Math.round(sourceFps)} fps</small> : null}
              </button>
              <button
                ref={resBtnRef}
                type="button"
                className={view === "res" ? "on" : ""}
                onClick={(e) => {
                  e.stopPropagation();
                  setView("res");
                }}
              >
                Interpolated {targetFps ? <small id="tagTo">{Math.round(targetFps)} fps</small> : null}
              </button>
            </div>
          </div>
        </div>
      </section>

      <aside className="rbar" id="rbar">
        {isError ? (
          <div className="rcell rbig">
            <span className="lbl">Result</span>
            <div className="rok">
              <b style={{ color: "var(--err, #ff5555)" }}>Failed</b>
            </div>
            <em style={{ color: "var(--err, #ff5555)", wordBreak: "break-all" }}>
              {errorMessage}
            </em>
          </div>
        ) : (
          <div className="rcell rbig">
            <span className="lbl">Result</span>
            <div className="rok">
              <b>Finished</b>
            </div>
            {resultSubtitle ? <em>{resultSubtitle}</em> : null}
          </div>
        )}

        <div className="rcell">
          <span className="lbl">File</span>
          <b className="rfn">{outFileName}</b>
          <div className="rrow">
            <span>Size</span>
            <b>{sizeText}</b>
          </div>
          <div className="rrow">
            <span>Resolution</span>
            <b>{resolutionText}</b>
          </div>
        </div>

        <div className="rcell">
          <span className="lbl">Frame rate</span>
          <div className="rfps">
            <span>{sourceFps ? Math.round(sourceFps) : "—"}</span>
            <i>→</i>
            <span className="to">{targetFps ? Math.round(targetFps) : "—"}</span>
            <small>fps</small>
          </div>
          <div className="rrow">
            <span>Frames</span>
            <b>
              {sourceFrames != null && outFrames != null
                ? `${sourceFrames.toLocaleString()} → ${outFrames.toLocaleString()}`
                : "—"}
            </b>
          </div>
        </div>

        <div className="rcell">
          <span className="lbl">Saved to</span>
          <b className="rpath">{savedFolderPath}</b>
          <div className="rrow">
            <span>Model</span>
            <b>{displayModel}</b>
          </div>
        </div>

        <div className="rcell ract">
          {isError ? (
            <>
              <button
                type="button"
                className="btn solid"
                onClick={handleTryAgain}
              >
                Try again
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleInterpolateAnother}
              >
                Interpolate another
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn solid"
                id="rShow"
                onClick={handleShowInFolder}
              >
                Show in folder
              </button>
              <button
                type="button"
                className="btn"
                id="rNew"
                onClick={handleInterpolateAnother}
              >
                Interpolate another
              </button>
            </>
          )}
        </div>
      </aside>
    </>
  );
};
