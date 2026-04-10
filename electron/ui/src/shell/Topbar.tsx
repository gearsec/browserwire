import React, { useState, useCallback } from "react";
import { ArrowLeft, ArrowRight, RotateCw, Loader2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

interface TopbarProps {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export function Topbar({ url, canGoBack, canGoForward, loading }: TopbarProps) {
  const [inputValue, setInputValue] = useState("");
  const [focused, setFocused] = useState(false);

  const displayValue = focused ? inputValue : url;

  const handleFocus = useCallback(() => {
    setInputValue(url);
    setFocused(true);
  }, [url]);

  const handleBlur = useCallback(() => {
    setFocused(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        const val = inputValue.trim();
        if (val) {
          window.browserwire.navigate(val);
          setFocused(false);
        }
      }
    },
    [inputValue]
  );

  return (
    <div
      className="h-12 bg-background border-b border-border flex items-center px-3 gap-2 shrink-0"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <Button
        variant="outline"
        size="icon"
        disabled={!canGoBack}
        onClick={() => window.browserwire.goBack()}
      >
        <ArrowLeft />
      </Button>

      <Button
        variant="outline"
        size="icon"
        disabled={!canGoForward}
        onClick={() => window.browserwire.goForward()}
      >
        <ArrowRight />
      </Button>

      <Button
        variant="outline"
        size="icon"
        onClick={() => window.browserwire.reload()}
      >
        <RotateCw />
      </Button>

      <Input
        className="flex-1"
        placeholder="Enter URL..."
        value={displayValue}
        onChange={(e) => setInputValue(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />

      {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
    </div>
  );
}
