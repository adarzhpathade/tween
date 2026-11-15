import React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface TitleBarProps {
  title?: string;
  brand?: string;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  title = "Welcome",
  brand = "flowmotion",
}) => {
  const handleMinimize = async () => {
    try {
      const win = getCurrentWindow();
      await win.minimize();
    } catch (err) {
      console.warn("Window minimize error:", err);
    }
  };

  const handleMaximize = async () => {
    try {
      const win = getCurrentWindow();
      await win.toggleMaximize();
    } catch (err) {
      console.warn("Window toggleMaximize error:", err);
    }
  };

  const handleClose = async () => {
    try {
      const win = getCurrentWindow();
      await win.close();
    } catch (err) {
      console.warn("Window close error:", err);
    }
  };

  return (
    <header className="tb" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <i></i>{brand}
      </div>
      <div className="title" id="title" data-tauri-drag-region>
        {title}
      </div>
      <div className="wc" data-tauri-drag-region="false">
        <button
          type="button"
          onClick={handleMinimize}
          aria-label="Minimize"
          title="Minimize"
        >
          <svg viewBox="0 0 12 12">
            <path d="M1 6h10" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleMaximize}
          aria-label="Maximize"
          title="Maximize"
        >
          <svg viewBox="0 0 12 12">
            <rect x="1.5" y="1.5" width="9" height="9" />
          </svg>
        </button>
        <button
          type="button"
          className="close"
          onClick={handleClose}
          aria-label="Close"
          title="Close"
        >
          <svg viewBox="0 0 12 12">
            <path d="M1 1l10 10M11 1L1 11" />
          </svg>
        </button>
      </div>
    </header>
  );
};
