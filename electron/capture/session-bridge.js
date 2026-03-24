/**
 * session-bridge.js — Orchestrates the capture pipeline for Electron.
 *
 * Connects dom-capture + SettleCycleManager + screenshot to SessionManager.
 * Replaces extension/background.js's snapshot handling for the Electron path.
 */

import { injectCapture, removeCapture } from "./dom-capture.js";
import { ElectronBrowser } from "./electron-browser.js";
import { SettleCycleManager } from "./settle-cycle.js";

/**
 * Create a session bridge that orchestrates capture and SessionManager interaction.
 *
 * @param {{ sessionManager: import('../../core/session-manager.js').SessionManager, getBrowserView: () => Electron.BrowserView, sendToUI: (channel: string, data: any) => void }} deps
 */
export const createSessionBridge = ({ sessionManager, getBrowserView, sendToUI }) => {
  let activeSessionId = null;
  let pendingSnapshots = [];
  let settleCycle = null;
  let navListener = null;

  // Set the browser factory on the session manager to use ElectronBrowser
  sessionManager.browserFactory = () => new ElectronBrowser();

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
    const { session } = sessionManager.startSession(sessionId, url);
    activeSessionId = sessionId;
    pendingSnapshots = [];

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
          `Snapshot #${pendingSnapshots.length}: ${snap.trigger?.kind || "unknown"}`
        );
      },
    });
    settleCycle.start();

    // Show overlay immediately after reload so the user sees it while scripts inject
    settleCycle._showOverlay();

    // Now inject discovery scripts + page signal script.
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
   * Stop exploring and send snapshots to SessionManager for processing.
   * Returns immediately (non-blocking, same UX pattern as extension).
   */
  const stopExploring = async (note) => {
    if (!activeSessionId) throw new Error("No active session");

    const sessionId = activeSessionId;
    const batchId = crypto.randomUUID();

    // Stop the settle cycle manager
    if (settleCycle) {
      settleCycle.stop();
      settleCycle = null;
    }

    // Remove navigation listener
    const browserView = getBrowserView();
    if (navListener && browserView) {
      browserView.webContents.removeListener("did-navigate", navListener);
    }
    navListener = null;

    // Remove injected page scripts
    if (browserView) {
      await removeCapture(browserView.webContents);
    }

    activeSessionId = null;

    sendToUI("browserwire:session-status", {
      sessionId,
      status: "processing",
      snapshotCount: pendingSnapshots.length,
    });

    // Send to SessionManager (async — don't await)
    sessionManager.stopSession(sessionId, {
      pendingSnapshots,
      note,
      batchId,
      onStatus: (status) => {
        sendToUI("browserwire:batch-status", status);

        if (status.status === "finalized") {
          sendToUI("browserwire:session-status", {
            sessionId: status.sessionId,
            status: "finalized",
          });
        }
      },
    }).catch((err) => {
      sendToUI("browserwire:log", `Session error: ${err.message}`);
    });

    pendingSnapshots = [];
  };

  return { startExploring, stopExploring };
};
