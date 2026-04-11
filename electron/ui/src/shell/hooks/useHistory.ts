import { useState, useCallback, useEffect, useRef } from "react";

export interface SessionSummary {
  sessionId: string;
  origin: string;
  startedAt: string;
  stoppedAt: string;
  eventCount: number;
  snapshotCount: number;
  trainingStatus?: "training" | "error" | null;
  snapshots: {
    snapshotId: string;
    eventIndex: number;
    screenshotFile: string;
    url: string;
    title: string;
  }[];
}

export interface TrainingProgress {
  status: "processing" | "complete" | "error" | "finalized";
  currentSnapshot: number;
  totalSnapshots: number;
  currentTool: string;
  error?: string;
  totalToolCalls?: number;
}

export interface SegmentationData {
  snapshotCount: number;
  snapshots: {
    snapshotId: string;
    eventIndex: number;
    trigger: { kind: string } | null;
    stateLabel: string | null;
    stateName: string | null;
  }[];
  transitions: {
    from: string;
    to: string;
    snapshotIndex: number;
    eventRange: { start: number; end: number };
    triggerKind: string | null;
    interactionEvents: {
      eventIndex: number;
      type: string;
      interaction?: string;
      text?: string | null;
      rrwebNodeId: number;
      timestamp: number;
    }[];
  }[];
}

export function useHistory() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<any[] | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [segmentation, setSegmentation] = useState<SegmentationData | null>(null);
  const [progressMap, setProgressMap] = useState<Map<string, TrainingProgress>>(new Map());
  const initialLoadDone = useRef(false);

  // Listen to session-status IPC for training progress
  useEffect(() => {
    const cleanup = window.browserwire.onSessionStatus((status) => {
      if (!status.sessionId) return;
      const sid = status.sessionId;

      if (status.status === "finalized") {
        setProgressMap((prev) => {
          const next = new Map(prev);
          next.delete(sid);
          return next;
        });
        return;
      }

      if (status.status === "processing" || status.status === "complete" || status.status === "error") {
        // Pick up segmentation data streamed during training
        if (status.segmentation) {
          setSegmentation(status.segmentation);
        }

        setProgressMap((prev) => {
          const next = new Map(prev);
          const existing = prev.get(sid);
          next.set(sid, {
            status: status.status as TrainingProgress["status"],
            currentSnapshot: status.snapshot ?? existing?.currentSnapshot ?? 0,
            totalSnapshots: status.snapshotCount ?? existing?.totalSnapshots ?? 0,
            currentTool: status.tool ?? existing?.currentTool ?? "",
            error: status.error ?? existing?.error,
            totalToolCalls: status.totalToolCalls ?? existing?.totalToolCalls,
          });
          return next;
        });
      }
    });
    return cleanup;
  }, []);

  const getProgress = useCallback(
    (sessionId: string): TrainingProgress | null => {
      return progressMap.get(sessionId) ?? null;
    },
    [progressMap]
  );

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.browserwire.listSessions();
      setSessions(list);
      // Seed progressMap from core's disk-backed training status
      if (window.browserwire.getTrainingStatus) {
        const active = await window.browserwire.getTrainingStatus();
        if (active && Object.keys(active).length > 0) {
          setProgressMap((prev) => {
            const next = new Map(prev);
            for (const [sid, progress] of Object.entries(active) as [string, any][]) {
              next.set(sid, {
                status: progress.status === "training" ? "processing" : progress.status,
                currentSnapshot: progress.snapshot ?? 0,
                totalSnapshots: progress.snapshotCount ?? 0,
                currentTool: progress.tool ?? "",
                error: progress.error,
                totalToolCalls: progress.totalToolCalls,
              });
            }
            return next;
          });
        }
      }
    } catch (err) {
      console.error("Failed to load sessions:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectSession = useCallback(async (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setEventsLoading(true);
    setEvents(null);
    setSegmentation(null);
    try {
      const result = await window.browserwire.loadSessionEvents(sessionId);
      if (result.ok) {
        setEvents(result.events);
      } else {
        console.error("Failed to load events:", result.error);
      }
    } catch (err) {
      console.error("Failed to load session events:", err);
    } finally {
      setEventsLoading(false);
    }
    // Load segmentation separately — don't block events/player
    try {
      if (window.browserwire.loadSessionSegmentation) {
        const segResult = await window.browserwire.loadSessionSegmentation(sessionId);
        if (segResult.ok) {
          setSegmentation(segResult.segmentation);
        }
      }
    } catch { /* segmentation is optional */ }
  }, []);

  const retrainSession = useCallback(async (sessionId: string) => {
    try {
      await window.browserwire.retrainSession(sessionId);
    } catch (err) {
      console.error("Retrain failed:", err);
    }
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedSessionId(null);
    setEvents(null);
    setSegmentation(null);
  }, []);

  const selectedSession = sessions.find((s) => s.sessionId === selectedSessionId) || null;

  return {
    sessions,
    loading,
    selectedSession,
    selectedSessionId,
    events,
    eventsLoading,
    segmentation,
    progressMap,
    getProgress,
    retrainSession,
    loadSessions,
    selectSession,
    clearSelection,
    initialLoadDone,
  };
}
