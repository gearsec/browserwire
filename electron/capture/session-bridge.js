/**
 * session-bridge.js — Orchestrates the capture pipeline for Electron.
 *
 * On startExploring: injects rrweb recorder, starts event recorder.
 * On stopExploring: drains the rrweb event stream from the page, assembles the
 * session recording, and saves it to disk.
 *
 * The session recording is the source of truth:
 * {
 *   sessionId, origin, startedAt, stoppedAt,
 *   events: rrwebEvent[],      // continuous rrweb event stream (all sources, no filtering)
 * }
 *
 * Snapshots are NOT created during capture — the backend's segmenter
 * (core/recording/segment.js) derives them post-hoc from the event stream.
 */

import { injectCapture, removeCapture } from "./dom-capture.js";
import { EventRecorder } from "./event-recorder.js";

/**
 * Create a session bridge that orchestrates capture and session recording.
 *
 * @param {{ sessionManager: import('../../core/session-manager.js').SessionManager, getBrowserView: () => Electron.BrowserView, sendToUI: (channel: string, data: any) => void }} deps
 */
export const createSessionBridge = ({ sessionManager, getBrowserView, sendToUI }) => {
  let activeSessionId = null;
  let activeOrigin = null;
  let activeStartedAt = null;
  let eventRecorder = null;
  let navListener = null;
  let willNavListener = null;

  /**
   * Start exploring the current page.
   */
  const startExploring = async () => {
    const browserView = getBrowserView();
    if (!browserView) throw new Error("No browser view available");

    const webContents = browserView.webContents;
    const url = webContents.getURL();

    if (!url || url === "about:blank") {
      throw new Error("Navigate to a page first");
    }

    // Create session
    const sessionId = crypto.randomUUID();
    activeSessionId = sessionId;
    activeStartedAt = new Date().toISOString();

    try {
      activeOrigin = new URL(url).origin;
    } catch {
      activeOrigin = url;
    }

    // Reload the page so the first snapshot captures a clean page load
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        webContents.removeListener("did-finish-load", onLoad);
        reject(new Error("Page reload timeout"));
      }, 15000);
      const onLoad = () => {
        clearTimeout(timeout);
        resolve();
      };
      webContents.once("did-finish-load", onLoad);
      webContents.reload();
    });

    // Intercept new window/tab creation — force navigation in the same webContents
    webContents.setWindowOpenHandler(({ url }) => {
      webContents.loadURL(url);
      return { action: "deny" };
    });

    // Create and start the event recorder
    eventRecorder = new EventRecorder({ webContents });
    eventRecorder.start();

    // Inject rrweb recorder
    await injectCapture(webContents);

    // Before navigation: drain events from the page before the context is destroyed
    if (willNavListener) {
      webContents.removeListener("will-navigate", willNavListener);
    }
    willNavListener = () => {
      if (!activeSessionId || !eventRecorder) return;
      eventRecorder.drainEvents().catch(() => {});
    };
    webContents.on("will-navigate", willNavListener);

    // After navigation: re-inject scripts into the new page context
    if (navListener) {
      webContents.removeListener("did-navigate", navListener);
    }
    navListener = async () => {
      if (!activeSessionId) return;
      try {
        await injectCapture(webContents);
      } catch (err) {
        console.warn("[browserwire-electron] re-inject after navigation failed:", err.message);
      }
    };
    webContents.on("did-navigate", navListener);

    sendToUI("browserwire:session-status", {
      sessionId,
      status: "exploring",
    });

    sendToUI("browserwire:log", `Session started: ${sessionId}`);

    return { sessionId, url };
  };

  /**
   * Stop exploring: drain rrweb events, assemble session recording, save to disk.
   */
  const stopExploring = async (note) => {
    if (!activeSessionId) throw new Error("No active session");

    const sessionId = activeSessionId;
    const browserView = getBrowserView();
    const webContents = browserView?.webContents;

    // Drain any remaining events from the current page
    if (eventRecorder) {
      await eventRecorder.drainEvents();
    }

    // Get the cumulative event buffer
    const events = eventRecorder ? [...eventRecorder.events] : [];

    // Stop the event recorder
    if (eventRecorder) {
      eventRecorder.stop();
      eventRecorder = null;
    }

    // Remove navigation listeners
    if (willNavListener && browserView) {
      webContents.removeListener("will-navigate", willNavListener);
    }
    willNavListener = null;
    if (navListener && browserView) {
      webContents.removeListener("did-navigate", navListener);
    }
    navListener = null;

    // Restore default window-open behavior
    if (webContents && !webContents.isDestroyed()) {
      webContents.setWindowOpenHandler(() => ({ action: "allow" }));
    }

    // Remove injected page scripts
    if (browserView) {
      await removeCapture(webContents);
    }

    // Assemble session recording — no snapshots, just raw events
    const sessionRecording = {
      sessionId,
      origin: activeOrigin,
      startedAt: activeStartedAt,
      stoppedAt: new Date().toISOString(),
      events,
    };

    console.log(
      `[browserwire-electron] session recording: ${events.length} events`
    );

    activeSessionId = null;
    activeOrigin = null;
    activeStartedAt = null;

    // Save session recording to disk (awaited — files must exist before we return)
    await sessionManager.saveRecordingToDisk(sessionRecording);

    sendToUI("browserwire:session-status", {
      sessionId,
      status: "processing",
    });

    // Process through discovery pipeline (async, don't await)
    sessionManager.processSessionRecording(sessionRecording, {
      onStatus: (status) => {
        sendToUI("browserwire:session-status", { sessionId, ...status });
        if (status.tool) {
          sendToUI("browserwire:log", `${status.tool}`);
        }
        if (status.status === "complete") {
          sendToUI("browserwire:session-status", { sessionId, status: "finalized" });
          sendToUI("browserwire:log",
            `Session ${sessionId}: processing complete (${status.totalToolCalls || 0} tool calls)`
          );
        }
        if (status.status === "error") {
          sendToUI("browserwire:log", `Session error: ${status.error}`);
        }
      },
    }).catch((err) => {
      console.error("[browserwire-electron] session processing failed:", err.message);
      sendToUI("browserwire:log", `Session error: ${err.message}`);
      sendToUI("browserwire:session-status", { sessionId, status: "finalized" });
    });
  };

  return { startExploring, stopExploring };
};
