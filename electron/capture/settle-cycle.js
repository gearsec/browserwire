/**
 * settle-cycle.js — Main-process settle state machine for Electron.
 *
 * Determines WHEN to capture a snapshot marker by monitoring:
 *   - session.webRequest for network idle tracking
 *   - webContents.on('console-message') for page signals (click/mutation/navigation)
 *
 * On settle: captures a screenshot + records a snapshot marker.
 * The rrweb event stream (recorded in-page by dom-capture.js) is the source of
 * truth for DOM state — this module only captures the screenshot and marks
 * the boundary in the event stream.
 *
 * The snapshot marker is: { snapshotId, eventIndex, screenshot, url, title }
 * where eventIndex points to the FullSnapshot event in the rrweb stream
 * that corresponds to this settled state.
 */

import { session } from "electron";

const SETTLE_DEBOUNCE_MS = 500;
const SETTLE_HARD_TIMEOUT_MS = 4000;
const SIGNAL_PREFIX = "__bw:";

const BLOCKING_RESOURCE_TYPES = new Set([
  "mainFrame", "subFrame", "xmlhttprequest", "fetch",
]);

const NON_BLOCKING_URL_RE =
  /google-analytics|segment\.io|sentry\.io|hotjar|intercom|doubleclick|fonts\.(googleapis|gstatic)|\.woff2?(\?|$)|\.ttf(\?|$)|\.css(\?|$)|\.png(\?|$)|\.jpg(\?|$)|\.jpeg(\?|$)|\.svg(\?|$)|\.gif(\?|$)/i;

/**
 * @param {{ webContents: Electron.WebContents, onSnapshot: (snap: object) => void }} opts
 */
export class SettleCycleManager {
  constructor({ webContents, onSnapshot }) {
    this._wc = webContents;
    this._onSnapshot = onSnapshot;
    this._wcId = webContents.id;

    // State machine
    this._phase = "idle"; // "idle" | "settling"
    this._settleTimer = null;
    this._hardTimer = null;
    this._capturing = false;
    this._snapshotCount = 0;

    // Network tracking
    this._pendingRequests = new Map();

    // Bound handlers for cleanup
    this._onConsoleMessage = this._handleConsoleMessage.bind(this);
    this._onBeforeRequest = null;
    this._onRequestCompleted = null;
    this._onRequestFailed = null;

    this._started = false;
  }

  get snapshotCount() {
    return this._snapshotCount;
  }

  /**
   * Attach listeners and start receiving signals.
   */
  start() {
    if (this._started) return;
    this._started = true;

    // Listen for page signals via console-message
    this._wc.on("console-message", this._onConsoleMessage);

    // Network tracking via session.webRequest
    const ses = this._wc.session || session.defaultSession;

    this._onBeforeRequest = (details, callback) => {
      callback({}); // always proceed — we're observing, not blocking
      if (details.webContentsId !== this._wcId) return;
      if (!BLOCKING_RESOURCE_TYPES.has(details.resourceType)) return;
      if (NON_BLOCKING_URL_RE.test(details.url)) return;

      this._pendingRequests.set(details.id, {
        url: details.url,
        startedAt: Date.now(),
      });

      // Network activity during settling resets the debounce
      if (this._phase === "settling") {
        this._resetDebounce();
      }
    };

    this._onRequestCompleted = (details) => {
      if (details.webContentsId !== this._wcId) return;
      this._pendingRequests.delete(details.id);
      this._checkNetworkIdle();
    };

    this._onRequestFailed = (details) => {
      if (details.webContentsId !== this._wcId) return;
      this._pendingRequests.delete(details.id);
      this._checkNetworkIdle();
    };

    ses.webRequest.onBeforeRequest(this._onBeforeRequest);
    ses.webRequest.onCompleted(this._onRequestCompleted);
    ses.webRequest.onErrorOccurred(this._onRequestFailed);
  }

  /**
   * Detach all listeners, clear timers, reset state.
   */
  stop() {
    if (!this._started) return;
    this._started = false;

    this._clearTimers();
    this._phase = "idle";
    this._pendingRequests.clear();

    this._wc.removeListener("console-message", this._onConsoleMessage);

    // Remove webRequest listeners by setting to null
    const ses = this._wc.session || session.defaultSession;
    ses.webRequest.onBeforeRequest(null);
    ses.webRequest.onCompleted(null);
    ses.webRequest.onErrorOccurred(null);

    this._onBeforeRequest = null;
    this._onRequestCompleted = null;
    this._onRequestFailed = null;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  _handleConsoleMessage(_event, _level, message) {
    if (!message.startsWith(SIGNAL_PREFIX)) return;

    let signal;
    try {
      signal = JSON.parse(message.slice(SIGNAL_PREFIX.length));
    } catch {
      return;
    }

    if (signal.type === "interaction") {
      this._beginSettleCycle();
    } else if (signal.type === "mutation") {
      // DOM mutations during settling reset the debounce
      if (this._phase === "settling") {
        this._resetDebounce();
      }
    }
  }

  _beginSettleCycle() {
    if (this._phase === "settling") {
      // Already settling — reset debounce, keep hard cap
      this._pendingRequests.clear();
      this._resetDebounce();
      return;
    }

    this._phase = "settling";
    this._pendingRequests.clear();

    this._settleTimer = setTimeout(() => this._onSettle(), SETTLE_DEBOUNCE_MS);
    this._hardTimer = setTimeout(() => this._forceScan(), SETTLE_HARD_TIMEOUT_MS);
  }

  _resetDebounce() {
    if (this._settleTimer) clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => this._onSettle(), SETTLE_DEBOUNCE_MS);
  }

  _onSettle() {
    this._settleTimer = null;
    if (this._phase !== "settling") return;

    if (this._isNetworkIdle()) {
      this._executeScan();
    }
    // else: network still active — wait for _checkNetworkIdle or hard timeout
  }

  _forceScan() {
    this._hardTimer = null;
    if (this._phase !== "settling") return;
    this._executeScan();
  }

  _checkNetworkIdle() {
    if (this._phase !== "settling") return;
    if (!this._isNetworkIdle()) return;

    // Network just drained — short debounce then settle
    if (!this._settleTimer) {
      this._settleTimer = setTimeout(() => this._onSettle(), 100);
    }
  }

  _isNetworkIdle() {
    return this._pendingRequests.size === 0;
  }

  _executeScan() {
    this._clearTimers();
    this._phase = "idle";

    // Avoid concurrent captures
    if (this._capturing) return;
    this._captureSnapshot().catch((err) => {
      console.warn("[browserwire-electron] snapshot capture failed:", err.message);
    });
  }

  /**
   * Capture a snapshot marker: screenshot + eventIndex into the rrweb stream.
   *
   * The rrweb event stream is recorded in-page (window.__bw_events).
   * We ask the page for the current event count to get the eventIndex,
   * then trigger a FullSnapshot checkpoint so the index points to a
   * FullSnapshot event.
   */
  async _captureSnapshot() {
    this._capturing = true;
    try {
      const wc = this._wc;

      // Wait one frame for repaint
      await new Promise((r) => setTimeout(r, 50));

      // 1. Trigger an rrweb checkout (emits a new FullSnapshot into the stream)
      //    and get the eventIndex pointing to that FullSnapshot + page metadata
      let meta;
      try {
        meta = await wc.executeJavaScript(`
          (function() {
            if (typeof rrweb !== 'undefined' && rrweb.record) {
              rrweb.record.takeFullSnapshot();
            }
            return JSON.stringify({
              eventIndex: (window.__bw_events || []).length - 1,
              url: location.href,
              title: document.title,
            });
          })()
        `);
      } catch (err) {
        console.warn("[browserwire-electron] rrweb checkout failed:", err.message);
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(meta);
      } catch {
        console.warn("[browserwire-electron] Failed to parse snapshot meta");
        return;
      }

      // 2. Screenshot (native Electron API)
      let screenshotBase64 = null;
      try {
        const image = await wc.capturePage();
        screenshotBase64 = image.toJPEG(50).toString("base64");
      } catch (err) {
        console.warn("[browserwire-electron] screenshot failed:", err.message);
      }

      this._snapshotCount++;

      this._onSnapshot({
        snapshotId: `snap_${this._snapshotCount}`,
        eventIndex: parsed.eventIndex,
        screenshot: screenshotBase64,
        url: parsed.url,
        title: parsed.title,
      });
    } finally {
      this._capturing = false;
    }
  }

  _clearTimers() {
    if (this._settleTimer) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
    if (this._hardTimer) {
      clearTimeout(this._hardTimer);
      this._hardTimer = null;
    }
  }
}
