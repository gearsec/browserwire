import { useState, useEffect, useCallback } from "react";

interface NavigationState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface BatchInfo {
  batchId: string;
  status: "pending" | "processing" | "complete" | "error";
  error?: string;
}

export interface BrowserWireState {
  url: string;
  navState: NavigationState;
  loading: boolean;
  exploring: boolean;
  sessionStatus: string;
  batches: Map<string, BatchInfo>;
  llmConfigured: boolean;
  llmProvider: string;
  port: number;
  portOk: boolean;
}

export function useBrowserWire() {
  const [url, setUrl] = useState("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [sessionStatus, setSessionStatus] = useState("");
  const [batches, setBatches] = useState<Map<string, BatchInfo>>(new Map());
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [llmProvider, setLlmProvider] = useState("");
  const [port, setPort] = useState(8787);
  const [portOk, setPortOk] = useState(true);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);

  // IPC subscriptions
  useEffect(() => {
    const cleanups: (() => void)[] = [];

    cleanups.push(
      window.browserwire.onUrlChanged((u) => setUrl(u))
    );

    cleanups.push(
      window.browserwire.onNavigationState((state) => {
        setUrl(state.url || "");
        setCanGoBack(state.canGoBack);
        setCanGoForward(state.canGoForward);
      })
    );

    cleanups.push(
      window.browserwire.onLoadingChanged((l) => setLoading(l))
    );

    cleanups.push(
      window.browserwire.onSessionStatus((status) => {
        if (status.status) {
          setSessionStatus(status.status);
        }
        if (status.sessionId) {
          setLastSessionId(status.sessionId);
        }
      })
    );

    cleanups.push(
      window.browserwire.onBatchStatus((status) => {
        if (status.batchId) {
          setBatches((prev) => {
            const next = new Map(prev);
            next.set(status.batchId, status);
            return next;
          });
        }
      })
    );

    cleanups.push(
      window.browserwire.onConfigChanged((data) => {
        setLlmConfigured(data.llmConfigured);
        setLlmProvider(data.provider);
        if (data.port != null) setPort(data.port);
        if (data.portOk != null) setPortOk(data.portOk);
      })
    );

    // Load initial status
    window.browserwire.getSettings().then((settings) => {
      setLlmConfigured(settings.llmConfigured);
      setLlmProvider(settings.provider);
      if (settings.port != null) setPort(settings.port);
      if (settings.portOk != null) setPortOk(settings.portOk);
    }).catch(() => {});

    return () => cleanups.forEach((fn) => fn());
  }, []);

  const startExploring = useCallback(async () => {
    try {
      const result = await window.browserwire.startExploring();
      if (result.ok) {
        setExploring(true);
        setSessionStatus("exploring");
      }
      return result;
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }, []);

  const stopExploring = useCallback(async (note?: string) => {
    try {
      const result = await window.browserwire.stopExploring(note || undefined);
      setExploring(false);
      setSessionStatus(result.ok ? "processing" : "");
      return result;
    } catch (err: any) {
      setExploring(false);
      setSessionStatus("");
      return { ok: false, error: err.message };
    }
  }, []);

  return {
    url,
    canGoBack,
    canGoForward,
    loading,
    exploring,
    sessionStatus,
    batches,
    llmConfigured,
    llmProvider,
    port,
    portOk,
    lastSessionId,
    startExploring,
    stopExploring,
  };
}
