import React, { useState } from "react";
import type { Screen } from "../types";

export interface ReadyScreenProps {
  onNavigate?: (screen: Screen) => void;
}

export const ReadyScreen: React.FC<ReadyScreenProps> = ({ onNavigate }) => {
  const [view, setView] = useState<"orig" | "res">("res");
  const [rate, setRate] = useState<number>(48);
  const [model, setModel] = useState<string>("balanced");
  const [keepAudio, setKeepAudio] = useState<boolean>(true);

  return (
    <>
      <section className="ws">
        <div className="fh">
          <div>
            <span className="lbl">01 · Source</span>
            <h2>beach_sunset_24fps.mp4</h2>
            <div className="fmeta">
              1920×1080 · 24 fps · 0:42 · H.264 · AAC · 1,008 frames
            </div>
          </div>
        </div>

        <div className="stage">
          <div className="canvas">
            <div className="scene" />
            <div className="vsw">
              <button
                type="button"
                className={view === "orig" ? "on" : ""}
                onClick={() => setView("orig")}
              >
                Original <small>24 fps</small>
              </button>
              <button
                type="button"
                className={view === "res" ? "on" : ""}
                onClick={() => setView("res")}
              >
                Interpolated <small>{rate} fps</small>
              </button>
            </div>
          </div>
        </div>

        <div className="tr trim">
          <div className="trh">
            <div className="trl">
              <span className="lbl">Trim</span>
              <span className="rd">
                <span>In</span>
                <b>00:00.0</b>
              </span>
              <span className="rd">
                <span>Out</span>
                <b>00:42.0</b>
              </span>
              <span className="rd len">
                <span>Length</span>
                <b>00:42.0</b>
              </span>
              <span className="rd">
                <span>Frames</span>
                <b>1,008</b>
              </span>
            </div>
            <div className="tbs">
              <button type="button" className="tbn">Set in</button>
              <button type="button" className="tbn">Set out</button>
              <button type="button" className="tbn mute">Reset</button>
            </div>
          </div>

          <div className="lane">
            <div className="film">
              {Array.from({ length: 48 }).map((_, i) => (
                <i key={i} />
              ))}
            </div>
            <div className="sel" />
            <div className="hdl in" />
            <div className="hdl out" />
          </div>
        </div>
      </section>

      <aside className="frail">
        <span className="lbl">Frame rate</span>
        <div className="rv">
          <div className="fr0">24 <i>→</i></div>
          <div className="fr1">{rate}</div>
          <small>fps</small>
        </div>

        <div className="fseg v">
          {[
            { f: 48, label: "2×", sub: "48 fps" },
            { f: 72, label: "3×", sub: "72 fps" },
            { f: 96, label: "4×", sub: "96 fps" },
            { f: 60, label: "60", sub: "fps" },
            { f: 120, label: "120", sub: "fps" },
            { f: 90, label: "Custom", sub: "90 fps" },
          ].map((item) => (
            <button
              key={item.f}
              type="button"
              className={rate === item.f ? "on" : ""}
              onClick={() => setRate(item.f)}
            >
              <b>{item.label}</b>
              <span>{item.sub}</span>
            </button>
          ))}
        </div>

        <div className="gainv">
          <b>+{rate - 24} frames<br />every second</b>
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
                <em>v4</em>
              </div>
              <div
                className={`model ${model === "animation" ? "on" : ""}`}
                onClick={() => setModel("animation")}
              >
                <div className="mtx">
                  <b>Animation</b>
                  <small>Tuned for cartoons and anime</small>
                </div>
                <em>2× only</em>
              </div>
            </div>
          </div>

          <div className="grp">
            <div className="lbl">Output</div>
            <div className="row">
              <span>Encoder</span>
              <b>H.264 · NVENC</b>
            </div>
            <div className="row">
              <span>Quality</span>
              <b>CQ 18</b>
            </div>
            <div className="row">
              <span>Keep audio</span>
              <div
                className={`sw ${keepAudio ? "" : "off"}`}
                onClick={() => setKeepAudio(!keepAudio)}
              />
            </div>
          </div>

          <div className="grp">
            <div className="lbl">Save to</div>
            <div className="fold">
              <div>
                <b>Flowmotion</b>
                <small>D:\Videos\Flowmotion</small>
              </div>
              <span>Choose</span>
            </div>
          </div>
        </div>

        <div className="ifoot">
          <div className="est">
            <span>~ <b>1m 50s</b></span>
            <span><b>2,016</b> frames</span>
            <span>~ <b>52</b> MB</span>
          </div>
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
