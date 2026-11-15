import React, { createContext, useContext, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
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

const ScreenContext = createContext<ScreenContextValue | null>(null);

export function useScreen(): ScreenContextValue {
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
    }
    return initialScreen;
  });

  const [title, setTitle] = useState<string>(() => SCREEN_TITLES[screen]);

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
    <ScreenContext.Provider value={{ screen, setScreen, title, setTitle }}>
      {children}
    </ScreenContext.Provider>
  );
};

export const ScreenRouter: React.FC = () => {
  const { screen, setScreen, title } = useScreen();

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
        return <OnboardingScreen onNavigate={setScreen} />;
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
      <TitleBar title={title} brand="flowmotion" />
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
      </div>
    </div>
  );
};
