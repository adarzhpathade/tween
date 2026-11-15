import React, { createContext, useContext, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Screen, ScreenContextValue } from "./types";
import { SCREEN_TITLES } from "./types";
import { MainGrid } from "./MainGrid";
import { TitleBar } from "./TitleBar";
import { StatusBar } from "./StatusBar";
import { OnboardingScreen } from "./screens/OnboardingScreen";
import { ReadyScreen } from "./screens/ReadyScreen";
import { ProcessingScreen } from "./screens/ProcessingScreen";
import { DoneScreen } from "./screens/DoneScreen";
import { springEase } from "../motion";
import type { SetupConfig } from "./setupTypes";

interface ScreenContextExtendedValue extends ScreenContextValue {
  onboardingStep?: number;
  setOnboardingStep: (step: number) => void;
  simulateMissing: boolean;
  setSimulateMissing: (sim: boolean | ((prev: boolean) => boolean)) => void;
  allowGranted: boolean;
}

const ScreenContext = createContext<ScreenContextExtendedValue | null>(null);

export function useScreen(): ScreenContextExtendedValue {
  const ctx = useContext(ScreenContext);
  if (!ctx) {
    throw new Error("useScreen must be used within a ScreenProvider");
  }
  return ctx;
}

export interface ScreenProviderProps {
  initialScreen?: Screen;
  children: React.ReactNode;
}

export const ScreenProvider: React.FC<ScreenProviderProps> = ({
  initialScreen = "onboarding",
  children,
}) => {
  const [onboardingStep, setOnboardingStep] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const s = p.get("step");
      if (s !== null && !isNaN(Number(s))) {
        return Math.min(2, Math.max(0, Number(s)));
      }
    }
    return 0;
  });

  const [allowGranted] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return /allow=1/.test(window.location.search);
    }
    return false;
  });

  const [simulateMissing, setSimulateMissing] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return /missing=1/.test(window.location.search);
    }
    return false;
  });

  const [screen, setScreen] = useState<Screen>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const stateParam = params.get("state");
      if (
        stateParam === "onboarding" ||
        stateParam === "ready" ||
        stateParam === "processing" ||
        stateParam === "done"
      ) {
        return stateParam;
      }
      if (stateParam === "empty") return "onboarding";
      if (stateParam === "proc") return "processing";
      if (params.has("step")) return "onboarding";
    }
    return initialScreen;
  });

  const [title, setTitle] = useState<string>(() => SCREEN_TITLES[screen]);

  // On later launches: if setup_config returns saved config, skip onboarding.
  // If saved paths no longer exist, show page 2 again.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const hasExplicit = params.has("state") || params.has("step");
    if (hasExplicit) return;

    if (isTauri()) {
      invoke<SetupConfig | null>("setup_config")
        .then((cfg) => {
          if (cfg) {
            if (cfg.pathsExist === false) {
              // Saved paths no longer exist: show page 2 again
              setScreen("onboarding");
              setOnboardingStep(1);
            } else {
              // Saved config exists and paths are valid: skip onboarding
              setScreen("ready");
            }
          }
        })
        .catch((err) => {
          console.warn("setup_config check error:", err);
        });
    }
  }, []);

  useEffect(() => {
    setTitle(SCREEN_TITLES[screen]);
  }, [screen]);

  // Keyboard navigation shortcuts: 1-4 matching the mock
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      ) {
        return;
      }

      if (e.key === "1") setScreen("onboarding");
      else if (e.key === "2") setScreen("ready");
      else if (e.key === "3") setScreen("processing");
      else if (e.key === "4") setScreen("done");
      else if (e.key === "Escape" && screen === "processing") setScreen("ready");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [screen]);

  return (
    <ScreenContext.Provider
      value={{
        screen,
        setScreen,
        title,
        setTitle,
        onboardingStep,
        setOnboardingStep,
        simulateMissing,
        setSimulateMissing,
        allowGranted,
      }}
    >
      {children}
    </ScreenContext.Provider>
  );
};

export const ScreenRouter: React.FC = () => {
  const {
    screen,
    setScreen,
    title,
    onboardingStep,
    simulateMissing,
    setSimulateMissing,
    allowGranted,
  } = useScreen();

  // Initialize CSS spring variables once
  useEffect(() => {
    const sp = springEase(0.4, 0.62);
    document.documentElement.style.setProperty("--spring", sp.easing);
    document.documentElement.style.setProperty(
      "--spring-d",
      `${sp.duration}ms`,
    );
  }, []);

  const renderScreen = () => {
    switch (screen) {
      case "onboarding":
        return (
          <OnboardingScreen
            onNavigate={setScreen}
            initialStep={onboardingStep}
            initialAllow={allowGranted}
            simulateMissing={simulateMissing}
          />
        );
      case "ready":
        return <ReadyScreen onNavigate={setScreen} />;
      case "processing":
        return <ProcessingScreen onNavigate={setScreen} />;
      case "done":
        return <DoneScreen onNavigate={setScreen} />;
    }
  };

  return (
    <div className="win" data-state={screen}>
      <TitleBar title={title} brand="Tween" />
      <AnimatePresence mode="wait">
        <MainGrid key={screen} screen={screen}>
          {renderScreen()}
        </MainGrid>
      </AnimatePresence>
      <StatusBar screen={screen} />

      {/* Review switcher control matching mock */}
      <div className="router-switcher" role="navigation" aria-label="Screen switcher">
        <span>Screen</span>
        <button
          type="button"
          className={screen === "onboarding" ? "on" : ""}
          onClick={() => setScreen("onboarding")}
        >
          Onboarding
        </button>
        <button
          type="button"
          className={screen === "ready" ? "on" : ""}
          onClick={() => setScreen("ready")}
        >
          Ready
        </button>
        <button
          type="button"
          className={screen === "processing" ? "on" : ""}
          onClick={() => setScreen("processing")}
        >
          Processing
        </button>
        <button
          type="button"
          className={screen === "done" ? "on" : ""}
          onClick={() => setScreen("done")}
        >
          Done
        </button>
        <span
          className={`sim ${simulateMissing ? "on" : ""}`}
          style={{ cursor: "pointer", marginLeft: 8 }}
          onClick={() => setSimulateMissing((prev) => !prev)}
        >
          Simulate missing: {simulateMissing ? "on" : "off"}
        </span>
      </div>
    </div>
  );
};
