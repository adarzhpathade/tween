import React from "react";
import type { Screen } from "../types";

export interface ProcessingScreenProps {
  fileName?: string;
  stageInfo?: string;
  progressPercent?: number;
  framesProcessed?: number;
  totalFrames?: number;
  speedFps?: number;
  elapsedTime?: string;
  remainingTime?: string;
  gpuUsage?: number;
  cpuUsage?: number;
  onNavigate?: (screen: Screen) => void;
  onCancel?: () => void;
}

export const ProcessingScreen: React.FC<ProcessingScreenProps> = ({
  fileName,
  stageInfo,
  progressPercent,
  framesProcessed,
  totalFrames,
  speedFps,
  elapsedTime,
  remainingTime,
  gpuUsage,
  cpuUsage,
  onNavigate,
  onCancel,
}) => {
  const handleCancel = () => {
    onCancel?.();
    onNavigate?.("ready");
  };

  return (
    <>
      <section className="ws">
        <div className="fh">
          <div>
            <span className="lbl">02 · Processing</span>
            <h2>{fileName ?? "Processing video…"}</h2>
            {stageInfo ? <div className="fmeta">{stageInfo}</div> : null}
          </div>
          <button
            type="button"
            className="btn pcancel"
            onClick={handleCancel}
          >
            Cancel <kbd>Esc</kbd>
          </button>
        </div>

        <div className="stage">
          <div className="canvas">
            <div className="scene" />
            <span className="live-tag">Live</span>
          </div>
        </div>
      </section>

      <aside className="pbar">
        <div className="pbcells">
          <div className="pbc big">
            <span className="lbl">Progress</span>
            <div className="pbv">
              <span>{progressPercent != null ? Math.round(progressPercent) : "—"}</span>
              {progressPercent != null ? <small>%</small> : null}
            </div>
            <em>
              {framesProcessed != null && totalFrames != null
                ? `${framesProcessed.toLocaleString()} / ${totalFrames.toLocaleString()} frames`
                : "—"}
            </em>
          </div>

          <div className="pbc">
            <span className="lbl">Stage</span>
            <div className="pb-stg">
              <div className="pbs">
                <b>01</b>Extract
              </div>
              <div className="pbs now">
                <b>02</b>Interpolate
              </div>
              <div className="pbs">
                <b>03</b>Encode
              </div>
            </div>
          </div>

          <div className="pbc">
            <span className="lbl">Time</span>
            <div className="pb-tm">
              <div>
                <span>Elapsed</span>
                <b>{elapsedTime ?? "—"}</b>
              </div>
              <div>
                <span>Left</span>
                <b>{remainingTime ?? "—"}</b>
              </div>
              <div>
                <span>Speed</span>
                <b>{speedFps != null ? `${speedFps} fps` : "—"}</b>
              </div>
            </div>
          </div>

          <div className="pbc">
            <span className="lbl">GPU</span>
            <div className="pbv2">
              <b>{gpuUsage != null ? `${Math.round(gpuUsage)}%` : "—"}</b>
            </div>
            {gpuUsage != null ? (
              <div className="pbm">
                <i style={{ width: `${Math.min(100, Math.max(0, gpuUsage))}%` }} />
              </div>
            ) : null}
          </div>

          <div className="pbc">
            <span className="lbl">CPU</span>
            <div className="pbv2">
              <b>{cpuUsage != null ? `${Math.round(cpuUsage)}%` : "—"}</b>
            </div>
            {cpuUsage != null ? (
              <div className="pbm">
                <i style={{ width: `${Math.min(100, Math.max(0, cpuUsage))}%` }} />
              </div>
            ) : null}
          </div>
        </div>
      </aside>
    </>
  );
};
