import React from "react";

export function Titlebar() {
  return (
    <div
      className="h-[38px] bg-muted/50 border-b border-border flex items-center px-20 shrink-0"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <span className="text-sm font-semibold text-muted-foreground select-none tracking-wide">
        BrowserWire
      </span>
    </div>
  );
}
