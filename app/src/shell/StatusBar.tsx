import React from "react";
import type { Screen } from "./types";

export interface StatusBarProps {
  screen: Screen;
  gpu?: string;
  engine?: string;
  status?: string;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  screen,
  gpu,
  engine,
  status,
}) => {
  if (screen === "onboarding") {
    return null;
  }

  const statusLabel =
    status ??
    (screen === "processing"
      ? "Processing"
      : screen === "done"
      ? "Finished"
      : "Ready");

  return (
    <footer className="sb" id="statusBar">
      <span id="sbState">
        <i></i>
        {statusLabel}
      </span>
      {gpu ? <span>{gpu}</span> : null}
      <span className="sp" />
      {engine ? <span>{engine}</span> : null}
    </footer>
  );
};
