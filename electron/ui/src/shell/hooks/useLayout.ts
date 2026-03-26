import { useState, useCallback, useEffect } from "react";

export type Mode = "discovery" | "execution" | "history" | "settings";

export interface LayoutState {
  activeMode: Mode;
  rightPanelOpen: boolean;
}

export function useLayout() {
  const [activeMode, setActiveMode] = useState<Mode>("discovery");
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  const switchMode = useCallback((mode: Mode) => {
    if (mode === "discovery" && mode === activeMode && rightPanelOpen) {
      // Clicking the active discovery icon collapses the panel
      setRightPanelOpen(false);
    } else {
      setActiveMode(mode);
      if (mode === "discovery") {
        setRightPanelOpen(true);
      }
    }
  }, [activeMode, rightPanelOpen]);

  // Report layout changes to main process for BrowserView bounds
  useEffect(() => {
    window.browserwire.reportLayout({
      activeMode,
      rightPanelOpen,
    });
  }, [activeMode, rightPanelOpen]);

  // Listen for switch-mode IPC from main process (e.g. Cmd+, for Settings)
  useEffect(() => {
    const cleanup = window.browserwire.onSwitchMode((mode: string) => {
      if (mode === "discovery" || mode === "execution" || mode === "history" || mode === "settings") {
        setActiveMode(mode);
        if (mode === "discovery") {
          setRightPanelOpen(true);
        }
      }
    });
    return cleanup;
  }, []);

  return {
    activeMode,
    rightPanelOpen,
    switchMode,
  };
}
