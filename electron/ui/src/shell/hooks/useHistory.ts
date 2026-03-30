import { useState, useCallback, useEffect, useRef } from "react";

export interface SessionSummary {
  sessionId: string;
  origin: string;
  startedAt: string;
  stoppedAt: string;
  eventCount: number;
  snapshotCount: number;
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

export function useHistory() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<any[] | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [retraining, setRetraining] = useState(false);
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
        // Retraining finished — clear flag if it was for the selected session
        setRetraining(false);
        return;
      }

      if (status.status === "processing" || status.status === "complete" || status.status === "error") {
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
  }, []);

  const retrainSession = useCallback(async (sessionId: string) => {
    setRetraining(true);
    try {
      await window.browserwire.retrainSession(sessionId);
    } catch (err) {
      console.error("Retrain failed:", err);
      setRetraining(false);
    }
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedSessionId(null);
    setEvents(null);
  }, []);

  const selectedSession = sessions.find((s) => s.sessionId === selectedSessionId) || null;

  return {
    sessions,
    loading,
    selectedSession,
    selectedSessionId,
    events,
    eventsLoading,
    retraining,
    progressMap,
    getProgress,
    retrainSession,
    loadSessions,
    selectSession,
    clearSelection,
    initialLoadDone,
  };
}
