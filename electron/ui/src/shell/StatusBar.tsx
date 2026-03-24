import React from "react";
import { HelpCircle } from "lucide-react";

interface StatusBarProps {
  port: number;
  portOk: boolean;
  onStartTour?: () => void;
}

export function StatusBar({ port, portOk, onStartTour }: StatusBarProps) {
  return (
    <div data-tour="status-bar" className="h-6 bg-background border-t border-border flex items-center px-3 shrink-0 text-xs">
      <span className="inline-flex items-center gap-1.5">
        <span
          className={`size-1.5 rounded-full ${portOk ? "bg-success" : "bg-destructive"}`}
        />
        <span className={portOk ? "text-foreground" : "text-muted-foreground"}>
          Port {port}
        </span>
      </span>

      <div className="flex-1" />

      {onStartTour && (
        <button
          onClick={onStartTour}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Replay tour"
        >
          <HelpCircle className="size-3.5" />
        </button>
      )}
    </div>
  );
}
