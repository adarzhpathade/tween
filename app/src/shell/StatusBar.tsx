import React from "react";
import type { Screen } from "./types";

export interface StatusBarProps {
  screen: Screen;
  gpu?: string;
  engine?: string;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  screen,
  gpu = "RTX 4050 Laptop · Vulkan",
  engine = "RIFE v4.6",
}) => {
  if (screen === "onboarding") {
    return null;
  }

  const statusLabel =
    screen === "processing"
      ? "Interpolating…"
      : screen === "done"
      ? "Finished"
      : "Ready";

  return (
    <footer className="sb" id="statusBar">
      <span id="sbState">
        <i></i>
        {statusLabel}
      </span>
      <span>{gpu}</span>
      <span className="sp" />
      <span>{engine}</span>
    </footer>
  );
};
