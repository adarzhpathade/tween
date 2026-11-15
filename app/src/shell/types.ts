export type Screen = "onboarding" | "ready" | "processing" | "done";

export interface ScreenContextValue {
  screen: Screen;
  setScreen: (screen: Screen) => void;
  title: string;
  setTitle: (title: string) => void;
}

export const SCREEN_TITLES: Record<Screen, string> = {
  onboarding: "Welcome",
  ready: "Tween",
  processing: "Processing",
  done: "Finished",
};
