import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { AnimatePresence } from "motion/react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Screen,
  ScreenContextValue,
  ProbeInfo,
  JobRequest,
  JobProgressEvent,
  JobFinished,
} from "./types";
import { SCREEN_TITLES } from "./types";
import { MainGrid } from "./MainGrid";
import { TitleBar } from "./TitleBar";
import { StatusBar } from "./StatusBar";
import { SettingsSheet } from "./SettingsSheet";
import { OnboardingScreen } from "./screens/OnboardingScreen";
import { ReadyScreen } from "./screens/ReadyScreen";
import { ProcessingScreen } from "./screens/ProcessingScreen";
import { DoneScreen } from "./screens/DoneScreen";
import { springEase } from "../motion";
import type { SetupConfig } from "./setupTypes";

interface ScreenContextExtendedValue extends ScreenContextValue {
  onboardingStep?: number;
  setOnboardingStep: (step: number) => void;
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

  const [screen, setScreen] = useState<Screen>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const stateParam = params.get("screen") || params.get("state");
      if (
        stateParam === "onboarding" ||
        stateParam === "ready" ||
        stateParam === "processing" ||
        stateParam === "done"
      ) {
        return stateParam;
      }
      if (stateParam === "empty") return "onboarding";
      if (stateParam === "open") return "ready";
      if (stateParam === "proc") return "processing";
      if (params.has("step")) return "onboarding";
      if (
        import.meta.env.DEV &&
        (params.has("custom") || params.has("customval") || params.has("src"))
      ) {
        return "ready";
      }
    }
    return initialScreen;
  });

  const [title, setTitle] = useState<string>(() => SCREEN_TITLES[screen]);

  // On later launches: if setup_config returns saved config, skip onboarding.
  // If saved paths no longer exist, show page 2 again.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const hasExplicit = params.has("screen") || params.has("state") || params.has("step");
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

  return (
    <ScreenContext.Provider
      value={{
        screen,
        setScreen,
        title,
        setTitle,
        onboardingStep,
        setOnboardingStep,
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
    setTitle,
    onboardingStep,
    allowGranted,
  } = useScreen();
  const isMockDev = Boolean(
    import.meta.env.DEV &&
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("mock") === "1",
  );

  const [setupCfg, setSetupCfg] = useState<any>(null);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return /settings=open/.test(window.location.search);
    }
    return false;
  });

  const handleToggleSettings = useCallback(() => {
    setSettingsOpen((prev) => !prev);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);
  const [videoLoaded, setVideoLoaded] = useState<boolean>(() => {
    if (typeof window !== "undefined" && import.meta.env.DEV) {
      const params = new URLSearchParams(window.location.search);
      if (
        params.get("mock") === "1" ||
        params.has("src") ||
        params.has("custom") ||
        params.has("customval") ||
        params.get("state") === "ready"
      ) {
        return true;
      }
    }
    return false;
  });

  // Pipeline job state
  const [activeProbe, setActiveProbe] = useState<ProbeInfo | null>(null);
  const [activeJob, setActiveJob] = useState<JobRequest | null>(null);
  const [jobProgress, setJobProgress] = useState<JobProgressEvent | null>(null);
  const [jobFinished, setJobFinished] = useState<JobFinished | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  // Listen to Tauri pipeline events
  useEffect(() => {
    if (!isTauri()) return;

    let unsubProgress: (() => void) | undefined;
    let unsubFinished: (() => void) | undefined;

    listen<JobProgressEvent>("job-progress", (evt) => {
      setJobProgress(evt.payload);
    }).then((un) => {
      unsubProgress = un;
    });

    listen<JobFinished>("job-finished", (evt) => {
      const finished = evt.payload;
      setJobFinished(finished);
      if (finished.cancelled) {
        // Cancelled: back to Ready silently
        setScreen("ready");
      } else if (finished.ok) {
        // When the job finishes the app moves to Done by itself
        setScreen("done");
      } else {
        // Errors: show the error text plainly with "Try again" (back to Ready, settings kept)
        setJobError(finished.error || "Interpolation failed");
        setScreen("done");
      }
    }).then((un) => {
      unsubFinished = un;
    });

    return () => {
      unsubProgress?.();
      unsubFinished?.();
    };
  }, [setScreen]);

  // Start job handler
  const handleStartJob = async (job: JobRequest) => {
    setActiveJob(job);
    setActiveProbe(job.info);
    setJobProgress({ stage: "analyse", pct: 0 });
    setJobFinished(null);
    setJobError(null);
    setScreen("processing");
    setTitle(job.info.name);

    if (isTauri()) {
      try {
        await invoke("start_job", { job });
      } catch (err: any) {
        console.error("start_job failed:", err);
        const msg = typeof err === "string" ? err : err?.message || String(err);
        setJobError(msg);
        setJobFinished({ ok: false, error: msg });
        setScreen("done");
      }
    }
  };

  // Cancel job handler
  const handleCancelJob = async () => {
    if (isTauri()) {
      try {
        await invoke("cancel_job");
      } catch (err) {
        console.warn("cancel_job error:", err);
      }
    }
    setScreen("ready");
  };

  // Interpolate another: back to empty Ready screen
  const handleInterpolateAnother = () => {
    setActiveJob(null);
    setActiveProbe(null);
    setJobProgress(null);
    setJobFinished(null);
    setJobError(null);
    setVideoLoaded(false);
    setScreen("ready");
  };

  // Try again: back to Ready screen with settings kept
  const handleTryAgain = () => {
    setJobProgress(null);
    setJobFinished(null);
    setJobError(null);
    setScreen("ready");
  };

  // Initialize CSS spring variables once
  useEffect(() => {
    const sp = springEase(0.4, 0.62);
    document.documentElement.style.setProperty("--spring", sp.easing);
    document.documentElement.style.setProperty(
      "--spring-d",
      `${sp.duration}ms`,
    );

    invoke<any>("setup_config")
      .then((cfg) => {
        if (cfg) setSetupCfg(cfg);
      })
      .catch(() => {});
  }, []);

  const gpuLabel = setupCfg?.gpu?.name
    ? `${setupCfg.gpu.name} · Vulkan`
    : setupCfg?.mode === "cpu"
    ? "CPU fallback · slow"
    : undefined;

  const engineLabel = setupCfg?.models?.[0]
    ? `RIFE ${setupCfg.models[0]}`
    : undefined;

  const statusLabel =
    screen === "ready"
      ? videoLoaded || isMockDev
        ? "Ready"
        : "Idle"
      : screen === "processing"
      ? "Interpolating…"
      : screen === "done"
      ? "Finished"
      : undefined;

  const displayTitle =
    screen === "onboarding"
      ? "Welcome"
      : screen === "ready"
      ? videoLoaded && activeProbe
        ? activeProbe.name
        : isMockDev
        ? "beach_sunset_24fps.mp4"
        : "Tween"
      : screen === "processing"
      ? activeProbe?.name || (isMockDev ? "beach_sunset_24fps.mp4" : "Processing")
      : screen === "done"
      ? activeProbe?.name || (isMockDev ? "beach_sunset_24fps.mp4" : "Finished")
      : title;

  const renderScreen = () => {
    switch (screen) {
      case "onboarding":
        return (
          <OnboardingScreen
            onNavigate={setScreen}
            initialStep={onboardingStep}
            initialAllow={allowGranted}
          />
        );
      case "ready":
        return (
          <ReadyScreen
            initialProbe={activeProbe}
            onNavigate={setScreen}
            onVideoLoaded={setVideoLoaded}
            onStartJob={handleStartJob}
          />
        );
      case "processing":
        return (
          <ProcessingScreen
            probeInfo={activeProbe}
            jobRequest={activeJob}
            jobProgress={jobProgress}
            gpuName={setupCfg?.gpu?.name}
            onCancel={handleCancelJob}
            onNavigate={setScreen}
          />
        );
      case "done":
        return (
          <DoneScreen
            probeInfo={activeProbe}
            jobRequest={activeJob}
            jobFinished={jobFinished}
            error={jobError}
            modelName={activeJob?.model}
            onTryAgain={handleTryAgain}
            onInterpolateAnother={handleInterpolateAnother}
            onNavigate={setScreen}
          />
        );
    }
  };

  return (
    <div
      className="win"
      data-state={screen}
      data-file={screen === "ready" ? (videoLoaded || isMockDev ? "loaded" : "none") : undefined}
    >
      <TitleBar
        title={displayTitle}
        brand="Tween"
        settingsOpen={settingsOpen}
        onToggleSettings={handleToggleSettings}
      />
      <AnimatePresence mode="wait">
        <MainGrid key={screen} screen={screen}>
          {renderScreen()}
        </MainGrid>
      </AnimatePresence>
      <StatusBar
        screen={screen}
        gpu={gpuLabel}
        engine={engineLabel}
        status={statusLabel}
      />

      {/* Settings sheet */}
      <SettingsSheet
        isOpen={settingsOpen}
        onClose={handleCloseSettings}
        isJobRunning={screen === "processing"}
        lastJobError={jobError}
        knownVideoNames={
          [
            activeProbe?.file,
            activeProbe?.name,
            activeJob?.output,
          ].filter(Boolean) as string[]
        }
        setupConfig={setupCfg}
        onSetupUpdated={setSetupCfg}
      />

      {/* Developer-only switcher behind import.meta.env.DEV && ?mock=1 */}
      {isMockDev ? (
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
      ) : null}
    </div>
  );
};
