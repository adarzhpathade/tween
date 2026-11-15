import React, { useEffect, useState, useRef } from "react";
import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type { Screen, ProbeInfo, JobRequest, JobProgressEvent, SystemStats } from "../types";

export interface ProcessingScreenProps {
  probeInfo?: ProbeInfo | null;
  jobRequest?: JobRequest | null;
  jobProgress?: JobProgressEvent | null;
  gpuName?: string;
  onCancel?: () => void;
  onNavigate?: (screen: Screen) => void;
}

function fmtDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtBytesGb(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function formatCodec(codec: string): string {
  const upper = codec.toUpperCase();
  if (upper === "H264" || upper === "AVC1") return "H.264";
  if (upper === "HEVC" || upper === "H265") return "H.265";
  return upper;
}

export const ProcessingScreen: React.FC<ProcessingScreenProps> = ({
  probeInfo,
  jobRequest,
  jobProgress,
  gpuName,
  onCancel,
  onNavigate,
}) => {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const lastPreviewUpdateRef = useRef<number>(0);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const startTimeRef = useRef<number>(Date.now());

  // Elapsed timer: 1 update per second
  useEffect(() => {
    startTimeRef.current = Date.now();
    const timer = setInterval(() => {
      setElapsedSec((Date.now() - startTimeRef.current) / 1000);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // System stats sampler: samples once a second via backend command
  useEffect(() => {
    if (!isTauri()) return;

    let active = true;
    const sample = async () => {
      try {
        const res = await invoke<SystemStats>("sample_system_stats");
        if (active) {
          setStats(res);
        }
      } catch (err) {
        console.warn("Failed to sample system stats:", err);
      }
    };

    sample();
    const interval = setInterval(sample, 1000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  // Preview throttling: update at most ~2 times per second (>= 500ms between updates)
  useEffect(() => {
    if (!jobProgress?.preview) return;

    const now = performance.now();
    if (now - lastPreviewUpdateRef.current >= 500) {
      lastPreviewUpdateRef.current = now;
      try {
        const converted = convertFileSrc(jobProgress.preview);
        setPreviewUrl(`${converted}?t=${now}`);
      } catch {
        setPreviewUrl(jobProgress.preview);
      }
    }
  }, [jobProgress?.preview]);

  // Cancel handler: confirm-free, calls onCancel, returns to Ready with settings kept
  const handleCancel = () => {
    onCancel?.();
    onNavigate?.("ready");
  };

  // Esc key shortcut to cancel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, onNavigate]);

  // Current stage calculation
  const stage = jobProgress?.stage || "interpolate";
  const stageIndex = stage === "analyse" ? 0 : stage === "interpolate" ? 1 : 2;

  // Progress percentage calculation across stages
  const rawPct = jobProgress?.pct;
  let overallPercent: number;
  if (rawPct != null) {
    if (stage === "analyse") {
      overallPercent = Math.min(10, Math.round(rawPct * 10));
    } else if (stage === "interpolate") {
      overallPercent = Math.min(85, Math.round(10 + rawPct * 75));
    } else if (stage === "encode") {
      overallPercent = Math.min(99, Math.round(85 + rawPct * 14));
    } else {
      overallPercent = 100;
    }
  } else if (!jobProgress) {
    // Fallback for mock review (?state=proc)
    overallPercent = 42;
  } else {
    overallPercent = stageIndex === 0 ? 5 : stageIndex === 1 ? 50 : 90;
  }

  // Display values
  const fileName = probeInfo?.name || jobRequest?.info.name || "beach_sunset_24fps.mp4";
  const fmeta = probeInfo
    ? `${probeInfo.width}×${probeInfo.height} · ${Math.round(probeInfo.fps)} fps · ${fmtDuration(probeInfo.duration)} · ${formatCodec(probeInfo.codec)}${probeInfo.hasAudio ? " · AAC" : ""} · ${probeInfo.frames.toLocaleString()} frames`
    : "1920×1080 · 24 fps · 0:42 · H.264 · AAC · 1,008 frames";

  const framesProcessed = jobProgress?.done;
  const framesTotal = jobProgress?.total;
  const framesText =
    framesProcessed != null && framesTotal != null
      ? `${framesProcessed.toLocaleString()} / ${framesTotal.toLocaleString()} frames`
      : probeInfo
      ? `${probeInfo.frames.toLocaleString()} frames`
      : !jobProgress
      ? "1,058 / 2,016 frames"
      : "Preparing frames…";

  const elapsedText = !jobProgress && elapsedSec < 2 ? "0:41" : fmtDuration(elapsedSec);
  const leftText =
    jobProgress?.eta != null
      ? fmtDuration(jobProgress.eta)
      : !jobProgress
      ? "0:57"
      : "—";
  const speedText =
    jobProgress?.speed != null
      ? `${Math.round(jobProgress.speed)} fps`
      : !jobProgress
      ? "38 fps"
      : "—";

  // Real GPU data
  const hasRealGpu = stats?.gpuUsage != null;
  const gpuUsageVal = stats?.gpuUsage != null ? Math.round(stats.gpuUsage) : 0;
  const gpuLabel = gpuName || (stats?.gpuMemoryTotal ? "GPU" : "RTX 4050");
  const gpuMemText =
    stats?.gpuMemoryUsed != null && stats?.gpuMemoryTotal != null
      ? `${fmtBytesGb(stats.gpuMemoryUsed)} / ${fmtBytesGb(stats.gpuMemoryTotal)} GB`
      : stats?.gpuMemoryUsed != null
      ? `${fmtBytesGb(stats.gpuMemoryUsed)} GB`
      : null;

  // Real CPU data
  const hasRealCpu = stats?.cpuUsage != null;
  const cpuUsageVal = stats?.cpuUsage != null ? Math.round(stats.cpuUsage) : 0;
  const cpuThreadsText = stats?.cpuThreads ? `${stats.cpuThreads} threads` : undefined;
  const ramText =
    stats?.ramUsed != null && stats?.ramTotal != null
      ? `RAM ${fmtBytesGb(stats.ramUsed)} / ${fmtBytesGb(stats.ramTotal)} GB`
      : null;

  return (
    <>
      <section className="ws">
        <div className="fh">
          <div>
            <span className="lbl" id="fhLbl">01 · Source</span>
            <h2 id="fhName">{fileName}</h2>
            <div className="fmeta" id="fhMeta">{fmeta}</div>
            {jobProgress?.note ? (
              <div
                className="fmeta"
                style={{ color: "var(--dim)", marginTop: "4px" }}
              >
                {jobProgress.note}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="btn pcancel"
            id="pCancel"
            onClick={handleCancel}
          >
            Cancel <kbd>Esc</kbd>
          </button>
        </div>

        <div className="stage">
          <div className="canvas" id="canvas">
            <div className="scene">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Live interpolation preview"
                  style={{ width: "100%", height: "100%", objectFit: "contain" }}
                />
              ) : null}
            </div>
            <span className="live-tag">Live</span>
          </div>
        </div>
      </section>

      <aside className="pbar" id="pbar">
        <div className="pbcells">
          <div className="pbc big">
            <span className="lbl">Progress</span>
            <div className="pbv">
              <span id="pPct">{overallPercent}</span>
              <small>%</small>
            </div>
            <em id="pFr">{framesText}</em>
          </div>

          <div className="pbc">
            <span className="lbl">Stage</span>
            <div className="pb-stg">
              <div className={`pbs ${stageIndex > 0 ? "ok" : stageIndex === 0 ? "now" : ""}`}>
                <b>01</b>Analyse
              </div>
              <div className={`pbs ${stageIndex > 1 ? "ok" : stageIndex === 1 ? "now" : ""}`}>
                <b>02</b>Interpolate
              </div>
              <div className={`pbs ${stageIndex > 2 ? "ok" : stageIndex === 2 ? "now" : ""}`}>
                <b>03</b>Encode
              </div>
            </div>
          </div>

          <div className="pbc">
            <span className="lbl">Time</span>
            <div className="pb-tm">
              <div>
                <span>Elapsed</span>
                <b id="pEl">{elapsedText}</b>
              </div>
              <div>
                <span>Left</span>
                <b id="pLeft">{leftText}</b>
              </div>
              <div>
                <span>Speed</span>
                <b id="pSp">{speedText}</b>
              </div>
            </div>
          </div>

          {/* GPU cell: hidden if value is unavailable. Never show made-up numbers. */}
          {hasRealGpu ? (
            <div className="pbc u">
              <span className="lbl">GPU</span>
              <div className="pbv2">
                <b id="gU">{gpuUsageVal}%</b>
                {gpuLabel ? <small>{gpuLabel}</small> : null}
              </div>
              <div className="pbm">
                <i
                  id="gB"
                  style={{ width: `${Math.min(100, Math.max(0, gpuUsageVal))}%` }}
                />
              </div>
              {gpuMemText ? <em id="gE">{gpuMemText}</em> : null}
            </div>
          ) : null}

          {/* CPU cell: hidden if value is unavailable. Never show made-up numbers. */}
          {hasRealCpu ? (
            <div className="pbc u">
              <span className="lbl">CPU</span>
              <div className="pbv2">
                <b id="cU">{cpuUsageVal}%</b>
                {cpuThreadsText ? <small>{cpuThreadsText}</small> : null}
              </div>
              <div className="pbm">
                <i
                  id="cB"
                  style={{ width: `${Math.min(100, Math.max(0, cpuUsageVal))}%` }}
                />
              </div>
              {ramText ? <em id="cE">{ramText}</em> : null}
            </div>
          ) : null}
        </div>
      </aside>
    </>
  );
};
