import React, { useState } from "react";
import { Compass, Play, Settings } from "lucide-react";
import { cn } from "../lib/utils";
import type { Mode } from "./hooks/useLayout";

interface ActivityBarProps {
  activeMode: Mode;
  rightPanelOpen: boolean;
  onSwitchMode: (mode: Mode) => void;
}

const TOP_ITEMS: { mode: Mode; icon: typeof Compass; label: string }[] = [
  { mode: "discovery", icon: Compass, label: "Discovery" },
  { mode: "execution", icon: Play, label: "API Explorer" },
];

export function ActivityBar({ activeMode, rightPanelOpen, onSwitchMode }: ActivityBarProps) {
  const [hovered, setHovered] = useState(false);

  const isActive = (mode: Mode) =>
    mode === activeMode && (mode !== "discovery" || rightPanelOpen);

  return (
    <>
      {/* Invisible spacer — always 48px, reserves layout space */}
      <div className="w-12 shrink-0" />

      {/* Actual bar — positioned absolutely so it overlays content on expand */}
      <div
        data-tour="activity-bar"
        className={cn(
          "absolute top-0 left-0 bottom-0 z-40 bg-background border-r border-border flex flex-col py-2 gap-1 shrink-0 transition-[width] duration-200 ease-in-out overflow-hidden",
          hovered ? "w-40" : "w-12"
        )}
        onMouseEnter={() => { setHovered(true); window.browserwire.reportNavbarHover(true); }}
        onMouseLeave={() => { setHovered(false); window.browserwire.reportNavbarHover(false); }}
      >
        {TOP_ITEMS.map(({ mode, icon: Icon, label }) => (
          <button
            key={mode}
            data-tour={`${mode}-mode`}
            onClick={() => onSwitchMode(mode)}
            className={cn(
              "mx-1 h-10 flex items-center gap-3 rounded-md transition-colors px-2.5",
              isActive(mode)
                ? "text-foreground bg-muted border-l-2 border-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            )}
          >
            <Icon className="size-5 shrink-0" />
            <span
              className={cn(
                "text-sm font-medium whitespace-nowrap transition-opacity duration-200",
                hovered ? "opacity-100" : "opacity-0"
              )}
            >
              {label}
            </span>
          </button>
        ))}

        <div className="flex-1" />

        {/* Settings pinned to bottom */}
        <button
          data-tour="settings-mode"
          onClick={() => onSwitchMode("settings")}
          className={cn(
            "mx-1 h-10 flex items-center gap-3 rounded-md transition-colors px-2.5",
            isActive("settings")
              ? "text-foreground bg-muted border-l-2 border-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          )}
        >
          <Settings className="size-5 shrink-0" />
          <span
            className={cn(
              "text-sm font-medium whitespace-nowrap transition-opacity duration-200",
              hovered ? "opacity-100" : "opacity-0"
            )}
          >
            Settings
          </span>
        </button>
      </div>
    </>
  );
}
