export type Screen = "onboarding" | "ready" | "processing" | "done";

export interface ScreenContextValue {
  screen: Screen;
  setScreen: (screen: Screen) => void;
  title: string;
  setTitle: (title: string) => void;
}

export const SCREEN_TITLES: Record<Screen, string> = {
  onboarding: "Welcome",
  ready: "beach_sunset_24fps.mp4",
  processing: "Processing",
  done: "beach_sunset_48fps.mp4",
};
