import React from "react";
import type { Screen } from "../types";

export interface ProcessingScreenProps {
  onNavigate?: (screen: Screen) => void;
}

export const ProcessingScreen: React.FC<ProcessingScreenProps> = ({
  onNavigate,
}) => {
  return (
    <>
      <section className="ws">
        <div className="fh">
          <div>
            <span className="lbl">02 · Processing</span>
            <h2>beach_sunset_24fps.mp4</h2>
            <div className="fmeta">
              Interpolating 24 → 48 fps · Balanced · H.264 NVENC
            </div>
          </div>
          <button
            type="button"
            className="btn pcancel"
            onClick={() => onNavigate?.("ready")}
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
              <span>42</span>
              <small>%</small>
            </div>
            <em>1,058 / 2,016 frames</em>
          </div>

          <div className="pbc">
            <span className="lbl">Stage</span>
            <div className="pb-stg">
              <div className="pbs ok">
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
                <b>0:41</b>
              </div>
              <div>
                <span>Left</span>
                <b>0:57</b>
              </div>
              <div>
                <span>Speed</span>
                <b>38 fps</b>
              </div>
            </div>
          </div>

          <div className="pbc">
            <span className="lbl">GPU</span>
            <div className="pbv2">
              <b>92%</b>
              <small>RTX 4050</small>
            </div>
            <div className="pbm">
              <i style={{ width: "92%" }} />
            </div>
            <em>4.1 / 6 GB</em>
          </div>

          <div className="pbc">
            <span className="lbl">CPU</span>
            <div className="pbv2">
              <b>34%</b>
              <small>8 threads</small>
            </div>
            <div className="pbm">
              <i style={{ width: "34%" }} />
            </div>
            <em>RAM 6.2 / 16 GB</em>
          </div>
        </div>
      </aside>
    </>
  );
};
