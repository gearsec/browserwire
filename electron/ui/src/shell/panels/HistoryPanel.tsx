import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, Globe, Clock, Layers, Radio, RotateCcw, Check, AlertCircle, Loader2 } from "lucide-react";
import rrwebPlayer from "rrweb-player";
import "rrweb-player/dist/style.css";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Progress } from "../../components/ui/progress";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Separator } from "../../components/ui/separator";
import { useHistory, type SessionSummary, type TrainingProgress } from "../hooks/useHistory";

const TOOL_LABELS: Record<string, string> = {
  "view_screenshot": "Viewing screenshot",
  "get_accessibility_tree": "Reading accessibility tree",
  "get_page_regions": "Analyzing page regions",
  "inspect_element": "Inspecting element",
  "find_interactive": "Finding interactive elements",
  "get_transition_events": "Analyzing transitions",
  "get_state_machine": "Reading state machine",
  "test_code": "Testing code",
  "submit_state": "Submitting state",
  "submit_view": "Submitting view",
  "submit_action": "Submitting action",
  "done": "Finishing analysis",
};

function humanizeTool(tool: string): string {
  // Strip agent prefix (e.g. "state-agent:view_screenshot" -> "view_screenshot")
  const name = tool.includes(":") ? tool.split(":").pop()! : tool;
  return TOOL_LABELS[name] || name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function formatDuration(start: string, stop: string) {
  try {
    const ms = new Date(stop).getTime() - new Date(start).getTime();
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  } catch {
    return "";
  }
}

function TrainingTimeline({ progress }: { progress: TrainingProgress }) {
  const { status, currentSnapshot, totalSnapshots, currentTool, error, totalToolCalls } = progress;
  const total = totalSnapshots || 1;
  const progressValue = status === "complete" ? 100 : Math.round(((currentSnapshot - 1) / total) * 100);

  if (status === "complete") {
    return (
      <Alert variant="success">
        <Check className="size-4" />
        <AlertDescription>
          Training complete{totalToolCalls ? ` — ${totalToolCalls} tool calls` : ""}
        </AlertDescription>
      </Alert>
    );
  }

  if (status === "error") {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertDescription>
          Training failed{error ? `: ${error}` : ""}
        </AlertDescription>
      </Alert>
    );
  }

  // Processing — show progress bar with snapshot info
  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin text-primary" />
            <span className="text-sm font-medium">Training in progress</span>
          </div>
          <Badge variant="secondary" className="text-xs">
            Snapshot {currentSnapshot || 1} of {total}
          </Badge>
        </div>
        <Progress value={progressValue} />
        {currentTool && (
          <p className="text-xs text-muted-foreground">
            {humanizeTool(currentTool)}...
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SessionCard({
  session,
  progress,
  onSelect,
}: {
  session: SessionSummary;
  progress: TrainingProgress | null;
  onSelect: () => void;
}) {
  const isTraining = progress && (progress.status === "processing");

  return (
    <Card
      className="cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={onSelect}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <Globe className="size-4 text-muted-foreground shrink-0" />
              <span className="text-sm font-medium truncate">{session.origin}</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="size-3" />
                {formatDate(session.startedAt)}
              </span>
              <span>{formatDuration(session.startedAt, session.stoppedAt)}</span>
            </div>
          </div>
          <div className="flex gap-1.5 shrink-0">
            {isTraining ? (
              <Badge variant="default" className="text-xs gap-1">
                <span className="size-1.5 rounded-full bg-primary-foreground animate-pulse" />
                Training
              </Badge>
            ) : (
              <>
                <Badge variant="secondary" className="text-xs">
                  <Layers className="size-3 mr-1" />
                  {session.snapshotCount}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  <Radio className="size-3 mr-1" />
                  {session.eventCount}
                </Badge>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SessionList({
  sessions,
  loading,
  getProgress,
  onSelect,
}: {
  sessions: SessionSummary[];
  loading: boolean;
  getProgress: (sessionId: string) => TrainingProgress | null;
  onSelect: (sessionId: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
        Loading sessions...
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-sm gap-2">
        <Layers className="size-8 opacity-50" />
        <span>No session recordings yet</span>
        <span className="text-xs">Start exploring a site to create a recording</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sessions.map((session) => (
        <SessionCard
          key={session.sessionId}
          session={session}
          progress={getProgress(session.sessionId)}
          onSelect={() => onSelect(session.sessionId)}
        />
      ))}
    </div>
  );
}

function ReplayView({
  session,
  events,
  eventsLoading,
  retraining,
  progress,
  onBack,
  onRetrain,
}: {
  session: SessionSummary;
  events: any[] | null;
  eventsLoading: boolean;
  retraining: boolean;
  progress: TrainingProgress | null;
  onBack: () => void;
  onRetrain: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const [activeSnapshotIndex, setActiveSnapshotIndex] = useState<number | null>(null);

  const seekToSnapshot = (snapIndex: number) => {
    const player = playerRef.current;
    if (!player || !events || events.length === 0) return;

    const snap = session.snapshots[snapIndex];
    if (!snap || snap.eventIndex < 0 || snap.eventIndex >= events.length) return;

    // Compute time offset from the start of the recording
    const startTimestamp = events[0].timestamp;
    const targetTimestamp = events[snap.eventIndex].timestamp;
    const offsetMs = targetTimestamp - startTimestamp;

    console.log(`[browserwire] seeking to snapshot ${snapIndex}: eventIndex=${snap.eventIndex}, offsetMs=${offsetMs}, url=${snap.url}`);

    // Play briefly then pause at the target — this forces the replayer to
    // rebuild the DOM at the target time and render the updated iframe.
    // A bare goto(offset, false) can leave the display stale.
    player.goto(offsetMs, true);
    requestAnimationFrame(() => {
      player.pause();
    });
    setActiveSnapshotIndex(snapIndex);
  };

  useEffect(() => {
    if (!events || !containerRef.current || events.length === 0) return;

    // Clear previous player
    if (containerRef.current) {
      containerRef.current.innerHTML = "";
    }

    const player = new rrwebPlayer({
      target: containerRef.current!,
      props: {
        events,
        showController: true,
        autoPlay: false,
        speed: 1,
        skipInactive: true,
        mouseTail: false,
      },
    });
    playerRef.current = player;

    return () => {
      if (playerRef.current) {
        try {
          playerRef.current.$destroy();
        } catch { /* ignore */ }
        playerRef.current = null;
      }
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, [events]);

  const showTimeline = progress && (progress.status === "processing" || progress.status === "complete" || progress.status === "error");

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-border">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{session.origin}</div>
          <div className="text-xs text-muted-foreground">
            {formatDate(session.startedAt)} · {session.snapshotCount} snapshots · {session.eventCount} events
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={retraining || (progress != null && progress.status === "processing")}
          onClick={onRetrain}
        >
          <RotateCcw className={`size-4 mr-1.5 ${retraining ? "animate-spin" : ""}`} />
          {retraining ? "Retraining..." : progress?.status === "processing" ? "Training..." : "Retrain"}
        </Button>
      </div>

      {/* Training progress timeline */}
      {showTimeline && (
        <div className="px-4 py-3 border-b border-border">
          <TrainingTimeline progress={progress} />
        </div>
      )}

      {/* Snapshot markers — clickable to seek */}
      {session.snapshots.length > 0 && (
        <div className="border-b border-border px-4 py-2">
          <div className="text-xs font-medium text-muted-foreground mb-1.5">Snapshots</div>
          <div className="flex gap-1.5 flex-wrap">
            {session.snapshots.map((snap, i) => (
              <Badge
                key={snap.snapshotId}
                variant={activeSnapshotIndex === i ? "default" : "outline"}
                className="text-xs cursor-pointer hover:bg-muted"
                title={snap.url}
                onClick={() => seekToSnapshot(i)}
              >
                {i + 1}. {snap.title || snap.url}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Player */}
      <div className="flex-1 flex items-center justify-center bg-muted/30 overflow-auto p-4">
        {eventsLoading ? (
          <div className="text-muted-foreground text-sm">Loading recording...</div>
        ) : events && events.length > 0 ? (
          <div ref={containerRef} className="w-full h-full" />
        ) : (
          <div className="text-muted-foreground text-sm">No events in this recording</div>
        )}
      </div>
    </div>
  );
}

export function HistoryPanel({
  autoSelectSessionId,
  onAutoSelectConsumed,
}: {
  autoSelectSessionId?: string | null;
  onAutoSelectConsumed?: () => void;
} = {}) {
  const history = useHistory();
  const autoSelectHandled = useRef(false);

  // Load sessions on mount
  useEffect(() => {
    history.loadSessions();
  }, []);

  // Auto-select session when navigated from Stop Exploring
  useEffect(() => {
    if (autoSelectSessionId && !autoSelectHandled.current && !history.loading) {
      autoSelectHandled.current = true;
      // Reload sessions to include the just-stopped session, then select it
      history.loadSessions().then(() => {
        history.selectSession(autoSelectSessionId);
      });
      onAutoSelectConsumed?.();
    }
  }, [autoSelectSessionId, history.loading]);

  if (history.selectedSession && history.selectedSessionId) {
    return (
      <ReplayView
        session={history.selectedSession}
        events={history.events}
        eventsLoading={history.eventsLoading}
        retraining={history.retraining}
        progress={history.getProgress(history.selectedSessionId)}
        onBack={history.clearSelection}
        onRetrain={() => history.retrainSession(history.selectedSessionId!)}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-border">
        <h2 className="text-lg font-semibold">Session History</h2>
        <p className="text-sm text-muted-foreground">
          Browse and replay past exploration sessions
        </p>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-4">
          <SessionList
            sessions={history.sessions}
            loading={history.loading}
            getProgress={history.getProgress}
            onSelect={history.selectSession}
          />
        </div>
      </ScrollArea>
    </div>
  );
}
