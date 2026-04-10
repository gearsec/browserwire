import React from "react";
import { DiscoveryPanel } from "./panels/DiscoveryPanel";

interface RightPanelProps {
  open: boolean;
  exploring: boolean;
  llmConfigured: boolean;
  onStartExploring: () => Promise<any>;
  onStopExploring: (note?: string) => Promise<any>;
  onGoToSettings: () => void;
}

export function RightPanel({
  open,
  exploring,
  llmConfigured,
  onStartExploring,
  onStopExploring,
  onGoToSettings,
}: RightPanelProps) {
  if (!open) return null;

  return (
    <div className="w-80 bg-background border-l border-border flex flex-col shrink-0 overflow-hidden">
      <DiscoveryPanel
        exploring={exploring}
        llmConfigured={llmConfigured}
        onStartExploring={onStartExploring}
        onStopExploring={onStopExploring}
        onGoToSettings={onGoToSettings}
      />
    </div>
  );
}
