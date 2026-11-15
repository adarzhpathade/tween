import React from "react";
import type { Screen } from "../types";

export interface DoneScreenProps {
  fileName?: string;
  outputPath?: string;
  fileSize?: string;
  resolution?: string;
  sourceFps?: number;
  targetFps?: number;
  totalFrames?: number;
  modelName?: string;
  elapsedTime?: string;
  averageSpeed?: number;
  onShowInFolder?: () => void;
  onNavigate?: (screen: Screen) => void;
}

export const DoneScreen: React.FC<DoneScreenProps> = ({
  fileName,
  outputPath,
  fileSize,
  resolution,
  sourceFps,
  targetFps,
  totalFrames,
  modelName,
  elapsedTime,
  averageSpeed,
  onShowInFolder,
  onNavigate,
}) => {
  return (
    <>
      <section className="ws">
        <div className="fh">
          <div>
            <span className="lbl">03 · Finished</span>
            <h2>{fileName ?? "Interpolation complete"}</h2>
            {outputPath ? <div className="fmeta">Saved to {outputPath}</div> : null}
          </div>
        </div>

        <div className="stage">
          <div className="canvas">
            <div className="scene" />
          </div>
        </div>
      </section>

      <aside className="rbar">
        <div className="rcell rbig">
          <span className="lbl">Result</span>
          <div className="rok">
            <b>Finished</b>
          </div>
          {elapsedTime ? (
            <em>
              in {elapsedTime}
              {averageSpeed != null ? ` · ${averageSpeed} fps average` : ""}
            </em>
          ) : null}
        </div>

        <div className="rcell">
          <span className="lbl">File</span>
          <b className="rfn">{fileName ?? "—"}</b>
          <div className="rrow">
            <span>Size</span>
            <b>{fileSize ?? "—"}</b>
          </div>
          <div className="rrow">
            <span>Resolution</span>
            <b>{resolution ?? "—"}</b>
          </div>
        </div>

        <div className="rcell">
          <span className="lbl">Frame rate</span>
          <div className="rfps">
            <span>{sourceFps ?? "—"}</span>
            <i>→</i>
            <span className="to">{targetFps ?? "—"}</span>
            <small>fps</small>
          </div>
          <div className="rrow">
            <span>Frames</span>
            <b>{totalFrames != null ? totalFrames.toLocaleString() : "—"}</b>
          </div>
        </div>

        <div className="rcell">
          <span className="lbl">Saved to</span>
          <b className="rpath">{outputPath ?? "—"}</b>
          {modelName ? (
            <div className="rrow">
              <span>Model</span>
              <b>{modelName}</b>
            </div>
          ) : null}
        </div>

        <div className="rcell ract">
          <button
            type="button"
            className="btn solid"
            onClick={onShowInFolder}
          >
            Show in folder
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => onNavigate?.("ready")}
          >
            Interpolate another
          </button>
        </div>
      </aside>
    </>
  );
};
