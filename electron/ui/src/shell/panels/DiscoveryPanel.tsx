import React from "react";
import { Loader2, Check, AlertCircle } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Separator } from "../../components/ui/separator";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import { ScrollArea } from "../../components/ui/scroll-area";

interface BatchInfo {
  batchId: string;
  status: "pending" | "processing" | "complete" | "error";
  error?: string;
}

interface DiscoveryPanelProps {
  exploring: boolean;
  sessionStatus: string;
  batches: Map<string, BatchInfo>;
  llmConfigured: boolean;
  onStartExploring: () => Promise<any>;
  onStopExploring: (note?: string) => Promise<any>;
  onGoToSettings: () => void;
}

function BatchStatusLine({ batch }: { batch: BatchInfo }) {
  if (batch.status === "pending" || batch.status === "processing") {
    return (
      <Alert>
        <Loader2 className="size-4 animate-spin" />
        <AlertTitle>Analyzing captured pages…</AlertTitle>
      </Alert>
    );
  }
  if (batch.status === "complete") {
    return (
      <Alert variant="success">
        <Check className="size-4" />
        <AlertTitle>Analysis complete</AlertTitle>
      </Alert>
    );
  }
  if (batch.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>Analysis failed</AlertTitle>
        {batch.error && <AlertDescription>{batch.error}</AlertDescription>}
      </Alert>
    );
  }
  return null;
}

export function DiscoveryPanel({
  exploring,
  sessionStatus,
  batches,
  llmConfigured,
  onStartExploring,
  onStopExploring,
  onGoToSettings,
}: DiscoveryPanelProps) {
  const batchList = [...batches.values()];
  const isProcessing = sessionStatus === "processing";
  const isFinalized = sessionStatus === "finalized" || sessionStatus === "complete";

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
            ) : isProcessing ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Loader2 className="size-4 animate-spin" />
                  Processing recording...
                </div>
                <p className="text-xs text-muted-foreground">
                  Analyzing events and generating snapshots. This may take a moment.
                </p>
              </div>
            ) : isFinalized ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                  <Check className="size-4" />
                  Processing complete
                </div>
                <p className="text-xs text-muted-foreground">
                  Session has been processed. Check the History tab to view results.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Click Start to begin recording your interactions with this website.
              </p>
            )}

            {exploring ? (
              <Button
                data-tour="start-exploring"
                className="w-full"
                variant="destructive"
                onClick={() => onStopExploring()}
              >
                Stop Exploring
              </Button>
            ) : isProcessing ? null : (
              <Button
                data-tour="start-exploring"
                className="w-full"
                onClick={onStartExploring}
              >
                Start Exploring
              </Button>
            )}
          </>
        )}

        {/* ── Background batch activity ── */}
        {batchList.length > 0 && (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              {batchList.map((b) => (
                <BatchStatusLine key={b.batchId} batch={b} />
              ))}
              {batchList.some((b) => b.status === "pending" || b.status === "processing") && (
                <p className="text-xs text-muted-foreground">
                  This may take a few minutes depending on the number of pages captured.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  );
}
