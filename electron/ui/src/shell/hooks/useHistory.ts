import { useState, useCallback } from "react";

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

export function useHistory() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<any[] | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [retraining, setRetraining] = useState(false);

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
    } finally {
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
    retrainSession,
    loadSessions,
    selectSession,
    clearSelection,
  };
}
