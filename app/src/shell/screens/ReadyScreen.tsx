import React, { useState } from "react";
import type { Screen } from "../types";

export interface ReadyScreenProps {
  fileName?: string;
  fileMeta?: string;
  onNavigate?: (screen: Screen) => void;
  onSelectVideo?: () => void;
}

export const ReadyScreen: React.FC<ReadyScreenProps> = ({
  fileName,
  fileMeta,
  onNavigate,
  onSelectVideo,
}) => {
  const [view, setView] = useState<"orig" | "res">("res");
  const [multiplier, setMultiplier] = useState<string>("2×");
  const [model, setModel] = useState<string>("balanced");
  const [keepAudio, setKeepAudio] = useState<boolean>(true);

  return (
    <>
      <section className="ws">
        <div className="fh">
          <div>
            <span className="lbl">01 · Source</span>
            <h2>{fileName ?? "No video selected"}</h2>
            {fileMeta ? <div className="fmeta">{fileMeta}</div> : null}
          </div>
        </div>

        <div className="stage">
          {fileName ? (
            <div className="canvas">
              <div className="scene" />
              <div className="vsw">
                <button
                  type="button"
                  className={view === "orig" ? "on" : ""}
                  onClick={() => setView("orig")}
                >
                  Original
                </button>
                <button
                  type="button"
                  className={view === "res" ? "on" : ""}
                  onClick={() => setView("res")}
                >
                  Interpolated
                </button>
              </div>
            </div>
          ) : (
            <div className="dz sdz">
              <div className="dzr">
                <b className="dzt">Drop a video</b>
                <span className="dzs">or browse your computer</span>
                <button
                  type="button"
                  className="btn solid cta"
                  onClick={onSelectVideo}
                >
                  Choose video <span>→</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="tr trim">
          <div className="trh">
            <div className="trl">
              <span className="lbl">Trim</span>
              <span className="rd">
                <span>In</span>
                <b>—</b>
              </span>
              <span className="rd">
                <span>Out</span>
                <b>—</b>
              </span>
              <span className="rd len">
                <span>Length</span>
                <b>—</b>
              </span>
              <span className="rd">
                <span>Frames</span>
                <b>—</b>
              </span>
            </div>
            <div className="tbs">
              <button type="button" className="tbn">Set in</button>
              <button type="button" className="tbn">Set out</button>
              <button type="button" className="tbn mute">Reset</button>
            </div>
          </div>

          <div className="lane">
            <div className="film" />
            <div className="sel" />
            <div className="hdl in" />
            <div className="hdl out" />
          </div>
        </div>
      </section>

      <aside className="frail">
        <span className="lbl">Frame rate</span>
        <div className="rv">
          <div className="fr0">Input <i>→</i></div>
          <div className="fr1">{multiplier}</div>
          <small>Target</small>
        </div>

        <div className="fseg v">
          {[
            { label: "2×", sub: "Double" },
            { label: "3×", sub: "Triple" },
            { label: "4×", sub: "Quad" },
            { label: "60", sub: "fps" },
            { label: "120", sub: "fps" },
          ].map((item, idx) => (
            <button
              key={idx}
              type="button"
              className={multiplier === item.label ? "on" : ""}
              onClick={() => setMultiplier(item.label)}
            >
              <b>{item.label}</b>
              <span>{item.sub}</span>
            </button>
          ))}
        </div>

        <div className="gainv">
          <b>Interpolation rate</b>
        </div>
      </aside>

      <aside className="insp">
        <div className="iscroll">
          <div className="grp">
            <div className="lbl">Model</div>
            <div className="opt">
              <div
                className={`model ${model === "balanced" ? "on" : ""}`}
                onClick={() => setModel("balanced")}
              >
                <div className="mtx">
                  <b>Balanced</b>
                  <small>Best quality for most clips</small>
                </div>
                <em>Recommended</em>
              </div>
              <div
                className={`model ${model === "fast" ? "on" : ""}`}
                onClick={() => setModel("fast")}
              >
                <div className="mtx">
                  <b>Fast</b>
                  <small>Quicker, slightly softer motion</small>
                </div>
              </div>
              <div
                className={`model ${model === "animation" ? "on" : ""}`}
                onClick={() => setModel("animation")}
              >
                <div className="mtx">
                  <b>Animation</b>
                  <small>Tuned for cartoons and anime</small>
                </div>
              </div>
            </div>
          </div>

          <div className="grp">
            <div className="lbl">Output</div>
            <div className="row">
              <span>Encoder</span>
              <b>Auto</b>
            </div>
            <div className="row">
              <span>Keep audio</span>
              <div
                className={`sw ${keepAudio ? "" : "off"}`}
                onClick={() => setKeepAudio(!keepAudio)}
              />
            </div>
          </div>
        </div>

        <div className="ifoot">
          <button
            type="button"
            className="go"
            onClick={() => onNavigate?.("processing")}
          >
            <span>Interpolate</span>
            <kbd>Ctrl ↵</kbd>
          </button>
        </div>
      </aside>
    </>
  );
};
