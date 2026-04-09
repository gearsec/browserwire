import React from "react";
import { DiscoveryPanel } from "./panels/DiscoveryPanel";

interface BatchInfo {
  batchId: string;
  status: "pending" | "processing" | "complete" | "error";
  error?: string;
}

interface RightPanelProps {
  open: boolean;
  exploring: boolean;
  sessionStatus: string;
  batches: Map<string, BatchInfo>;
  llmConfigured: boolean;
  onStartExploring: () => Promise<any>;
  onStopExploring: (note?: string) => Promise<any>;
  onGoToSettings: () => void;
}

export function RightPanel({
  open,
  exploring,
  sessionStatus,
  batches,
  llmConfigured,
  onStartExploring,
  onStopExploring,
  onGoToSettings,
}: RightPanelProps) {
  if (!open) return null;

  return (
    <div data-tour="discovery-panel" className="w-80 bg-background border-l border-border flex flex-col shrink-0 overflow-hidden">
      <DiscoveryPanel
        exploring={exploring}
        sessionStatus={sessionStatus}
        batches={batches}
        llmConfigured={llmConfigured}
        onStartExploring={onStartExploring}
        onStopExploring={onStopExploring}
        onGoToSettings={onGoToSettings}
      />
    </div>
  );
}
