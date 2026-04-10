import React from "react";
import { BookOpen } from "lucide-react";

interface StatusBarProps {
  port: number;
  portOk: boolean;
}

export function StatusBar({ port, portOk }: StatusBarProps) {
  return (
    <div className="h-6 bg-background border-t border-border flex items-center px-3 shrink-0 text-xs">
      <span className="inline-flex items-center gap-1.5">
        <span
          className={`size-1.5 rounded-full ${portOk ? "bg-primary" : "bg-destructive"}`}
        />
        <span className={portOk ? "text-foreground" : "text-muted-foreground"}>
          Port {port}
        </span>
      </span>

      <div className="flex-1" />

      <button
        onClick={() => window.browserwire.openDocs()}
        className="text-muted-foreground hover:text-foreground transition-colors"
        title="Open docs"
      >
        <BookOpen className="size-3.5" />
      </button>
    </div>
  );
}
