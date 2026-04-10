import React from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import { ScrollArea } from "../../components/ui/scroll-area";

interface DiscoveryPanelProps {
  exploring: boolean;
  llmConfigured: boolean;
  onStartExploring: () => Promise<any>;
  onStopExploring: (note?: string) => Promise<any>;
  onGoToSettings: () => void;
}

export function DiscoveryPanel({
  exploring,
  llmConfigured,
  onStartExploring,
  onStopExploring,
  onGoToSettings,
}: DiscoveryPanelProps) {
  return (
    <ScrollArea className="flex-1">
      <div className="p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Discovery
        </h2>

        {!llmConfigured && !exploring ? (
          <>
            <Alert>
              <AlertCircle className="size-4" />
              <AlertTitle>LLM not configured</AlertTitle>
              <AlertDescription>
                An LLM provider is required to analyze discovered pages. Configure one in Settings to get started.
              </AlertDescription>
            </Alert>
            <Button className="w-full" onClick={onGoToSettings}>
              Go to Settings
            </Button>
          </>
        ) : (
          <>
            {exploring ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className="size-2 rounded-full bg-primary animate-pulse" />
                  Recording
                </div>
                <p className="text-xs text-muted-foreground">
                  Click around the site to discover pages and interactions.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Click Start to begin recording your interactions with this website.
              </p>
            )}

            {exploring ? (
              <Button
                
                className="w-full"
                variant="destructive"
                onClick={() => onStopExploring()}
              >
                Stop Exploring
              </Button>
            ) : (
              <Button
                
                className="w-full"
                onClick={onStartExploring}
              >
                Start Exploring
              </Button>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  );
}
