import React, { useState, useRef, useEffect, useCallback } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Screen, ProbeInfo, JobRequest, JobFinished } from "../types";

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

  const handleCanvasClick = () => {
    const orig = origVideoRef.current;
    const res = resVideoRef.current;
    if (!orig || !res) return;

    if (orig.paused) {
      orig.play().catch(() => {});
      res.play().catch(() => {});
    } else {
      orig.pause();
      res.pause();
    }
  };

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

  // Data formatting
  const sourceFps = probeInfo?.fps || jobRequest?.info.fps || 24;
  let targetFps: number;
  if (jobRequest?.target) {
    if (jobRequest.target.mode === "multiplier") {
      targetFps = Math.round(sourceFps * (Number(jobRequest.target.value) || 2));
    } else {
      targetFps = Math.round(Number(jobRequest.target.value) || 48);
    }
  } else {
    targetFps = 48;
  }

  const outFileName = resFile
    ? resFile.split(/[\\/]/).pop() || "beach_sunset_48fps.mp4"
    : "beach_sunset_48fps.mp4";

  const savedFolderPath = resFile
    ? resFile.replace(/[\\/][^\\/]+$/, "")
    : "D:\\Videos\\Flowmotion";

  const sizeText =
    jobFinished?.outSize != null
      ? fmtBytesMb(jobFinished.outSize)
      : probeInfo?.size != null
      ? fmtBytesMb(probeInfo.size)
      : "38 MB";

  const resolutionText = probeInfo
    ? `${probeInfo.width}×${probeInfo.height}`
    : "1920×1080";

  const sourceFrames = probeInfo?.frames || jobRequest?.info.frames || 1008;
  const outFrames =
    jobFinished?.frames || (targetFps && sourceFps ? Math.round(sourceFrames * (targetFps / sourceFps)) : 2016);

  const durationSec = probeInfo?.duration || 42;
  const fmeta = probeInfo
    ? `${probeInfo.width}×${probeInfo.height} · ${Math.round(probeInfo.fps)} fps · ${fmtDuration(durationSec)} · ${formatCodec(probeInfo.codec)}${probeInfo.hasAudio ? " · AAC" : ""} · ${sourceFrames.toLocaleString()} frames`
    : "1920×1080 · 24 fps · 0:42 · H.264 · AAC · 1,008 frames";

  const timeTakenStr = jobFinished?.seconds != null ? fmtDuration(jobFinished.seconds) : "0:58";
  const avgSpeed =
    jobFinished?.seconds != null && jobFinished.seconds > 0
      ? Math.round(outFrames / jobFinished.seconds)
      : 38;

  const displayModel = modelName || jobRequest?.model || "Balanced";

  return (
    <>
      <section className="ws">
        <div className="fh">
          <div>
            <span className="lbl" id="fhLbl">01 · Source</span>
            <h2 id="fhName">{probeInfo?.name || "beach_sunset_24fps.mp4"}</h2>
            <div className="fmeta" id="fhMeta">{fmeta}</div>
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
            <div className="scene orig">
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

            <div className="scene res" id="res">
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
                Original <small>{Math.round(sourceFps)} fps</small>
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
                Interpolated <small id="tagTo">{Math.round(targetFps)} fps</small>
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
            <em>
              in {timeTakenStr} · {avgSpeed} fps average
            </em>
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
            <span>{Math.round(sourceFps)}</span>
            <i>→</i>
            <span className="to">{Math.round(targetFps)}</span>
            <small>fps</small>
          </div>
          <div className="rrow">
            <span>Frames</span>
            <b>
              {sourceFrames.toLocaleString()} → {outFrames.toLocaleString()}
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
