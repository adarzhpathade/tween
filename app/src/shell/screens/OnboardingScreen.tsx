import React from "react";
import type { Screen } from "../types";

export interface OnboardingScreenProps {
  onNavigate?: (screen: Screen) => void;
}

export const OnboardingScreen: React.FC<OnboardingScreenProps> = ({
  onNavigate,
}) => {
  return (
    <div className="ws">
      <div className="stage" style={{ padding: 0, placeItems: "stretch", background: "var(--bg)" }}>
        <div className="home welcome">
          <div className="h-top">
            <span className="lbl">Welcome</span>
            <button
              type="button"
              className="skip"
              onClick={() => onNavigate?.("ready")}
            >
              Skip
            </button>
          </div>

          <div className="w-pages">
            <section className="pg">
              <div className="hd">
                <h1>
                  <span>Between</span>
                  <br />
                  <span>every frame.</span>
                </h1>
                <p className="sub">
                  Flowmotion adds the frames your footage never had, so 24 or 30 fps video plays as smooth as 60.
                </p>
              </div>

              <div className="vz">
                <div className="rl-head">
                  <span className="lbl">Timeline</span>
                </div>
                <div className="ruler">
                  {Array.from({ length: 41 }, (_, i) => (
                    <i key={i} className={i % 2 !== 0 ? "g" : "o"} />
                  ))}
                  <div className="playhead" style={{ left: "30%", opacity: 1 }} />
                </div>
              </div>
            </section>
          </div>

          <div className="w-foot">
            <div className="steps">
              <span className="lbl">01 / 03</span>
            </div>
            <span className="priv">
              Runs on your GPU. Your videos never leave this device.
            </span>
            <button
              type="button"
              className="btn solid cta"
              onClick={() => onNavigate?.("ready")}
            >
              Get started <span>→</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
