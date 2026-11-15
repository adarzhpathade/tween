import React from "react";
import type { Screen } from "../types";

export interface DoneScreenProps {
  onNavigate?: (screen: Screen) => void;
}

export const DoneScreen: React.FC<DoneScreenProps> = ({ onNavigate }) => {
  return (
    <>
      <section className="ws">
        <div className="fh">
          <div>
            <span className="lbl">03 · Finished</span>
            <h2>beach_sunset_24fps.mp4</h2>
            <div className="fmeta">Saved to D:\Videos\Flowmotion</div>
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
          <em>in 0:58 · 38 fps average</em>
        </div>

        <div className="rcell">
          <span className="lbl">File</span>
          <b className="rfn">beach_sunset_48fps.mp4</b>
          <div className="rrow">
            <span>Size</span>
            <b>38 MB</b>
          </div>
          <div className="rrow">
            <span>Resolution</span>
            <b>1920×1080</b>
          </div>
        </div>

        <div className="rcell">
          <span className="lbl">Frame rate</span>
          <div className="rfps">
            <span>24</span>
            <i>→</i>
            <span className="to">48</span>
            <small>fps</small>
          </div>
          <div className="rrow">
            <span>Frames</span>
            <b>1,008 → 2,016</b>
          </div>
        </div>

        <div className="rcell">
          <span className="lbl">Saved to</span>
          <b className="rpath">D:\Videos\Flowmotion</b>
          <div className="rrow">
            <span>Model</span>
            <b>Balanced</b>
          </div>
        </div>

        <div className="rcell ract">
          <button type="button" className="btn solid">
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
