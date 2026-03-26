/**
 * session-bridge.js — Orchestrates the capture pipeline for Electron.
 *
 * On startExploring: injects rrweb recorder + page signals, starts settle cycle.
 * On stopExploring: drains the rrweb event stream from the page, assembles the
 * session recording, and saves it to disk.
 *
 * The session recording is the source of truth:
 * {
 *   sessionId, origin, startedAt, stoppedAt,
 *   events: rrwebEvent[],      // continuous rrweb event stream
 *   snapshots: [               // state boundary markers
 *     { snapshotId, eventIndex, screenshot, url, title }
 *   ]
 * }
 */

import { injectCapture, removeCapture } from "./dom-capture.js";
import { SettleCycleManager } from "./settle-cycle.js";

/**
 * Create a session bridge that orchestrates capture and session recording.
 *
 * @param {{ sessionManager: import('../../core/session-manager.js').SessionManager, getBrowserView: () => Electron.BrowserView, sendToUI: (channel: string, data: any) => void }} deps
 */
export const createSessionBridge = ({ sessionManager, getBrowserView, sendToUI }) => {
  let activeSessionId = null;
  let activeOrigin = null;
  let activeStartedAt = null;
  let pendingSnapshots = [];
  let settleCycle = null;
  let navListener = null;

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
    pendingSnapshots = [];

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

    // Create and start the settle cycle manager BEFORE injecting page scripts,
    // so the console-message listener is ready when PAGE_SIGNAL_SCRIPT fires
    // its initial signal.
    settleCycle = new SettleCycleManager({
      webContents,
      onSnapshot: (snap) => {
        if (!activeSessionId) return;

        pendingSnapshots.push(snap);

        // Update UI with snapshot count
        sendToUI("browserwire:session-status", {
          sessionId: activeSessionId,
          snapshotCount: pendingSnapshots.length,
        });

        sendToUI("browserwire:log",
          `Snapshot #${pendingSnapshots.length}: ${snap.url}`
        );
      },
    });
    settleCycle.start();

    // Now inject rrweb recorder + page signal script.
    // The settle cycle listener is already active, so the initial signal will be caught.
    await injectCapture(webContents);

    // Re-inject scripts on full navigation (new page context)
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
      snapshotCount: 0,
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

    // Stop the settle cycle manager
    if (settleCycle) {
      settleCycle.stop();
      settleCycle = null;
    }

    // Remove navigation listener
    if (navListener && browserView) {
      webContents.removeListener("did-navigate", navListener);
    }
    navListener = null;

    // Drain rrweb events from the page
    let events = [];
    if (webContents) {
      try {
        const eventsJson = await webContents.executeJavaScript(`
          JSON.stringify(window.__bw_events || []);
        `);
        events = JSON.parse(eventsJson);
      } catch (err) {
        console.warn("[browserwire-electron] failed to drain rrweb events:", err.message);
      }
    }

    // Remove injected page scripts
    if (browserView) {
      await removeCapture(webContents);
    }

    // Assemble session recording — the source of truth
    const sessionRecording = {
      sessionId,
      origin: activeOrigin,
      startedAt: activeStartedAt,
      stoppedAt: new Date().toISOString(),
      events,
      snapshots: pendingSnapshots,
    };

    activeSessionId = null;
    activeOrigin = null;
    activeStartedAt = null;
    pendingSnapshots = [];

    sendToUI("browserwire:session-status", {
      sessionId,
      status: "processing",
      snapshotCount: sessionRecording.snapshots.length,
    });

    // Save session recording via core session manager
    try {
      const sessionDir = await sessionManager.saveRecording(sessionRecording);
      sendToUI("browserwire:log",
        `Session ${sessionId}: ${events.length} events, ${sessionRecording.snapshots.length} snapshots → ${sessionDir}`
      );
    } catch (err) {
      console.error("[browserwire-electron] failed to save session recording:", err.message);
      sendToUI("browserwire:log", `Session error: ${err.message}`);
    }

    sendToUI("browserwire:session-status", {
      sessionId,
      status: "finalized",
    });
  };

  return { startExploring, stopExploring };
};
