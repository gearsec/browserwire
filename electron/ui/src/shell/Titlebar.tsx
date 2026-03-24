import React from "react";

export function Titlebar() {
  return (
    <div
      className="h-[38px] bg-background border-b border-border flex items-center px-20 shrink-0"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <span className="text-sm font-semibold text-muted-foreground select-none">
        BrowserWire
      </span>
    </div>
  );
}
