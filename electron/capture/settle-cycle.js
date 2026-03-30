/**
 * settle-cycle.js — Main-process settle state machine for Electron.
 *
 * Determines WHEN to capture a snapshot marker by monitoring:
 *   - session.webRequest for network idle tracking
 *   - webContents.on('console-message') for page signals (click/mutation/navigation)
 *
 * On settle: drains rrweb events from the page into a main-process buffer,
 * triggers a FullSnapshot checkpoint, captures a screenshot, and emits a
 * snapshot marker with the eventIndex into the cumulative buffer.
 *
 * The event buffer lives in the main process — survives page navigations.
 * Each capture drains all new events from window.__bw_events, so the page
 * array is always emptied and navigation can't lose events.
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

    // Cumulative event buffer (main process — survives navigations)
    this._eventBuffer = [];

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
   * Get the cumulative event buffer (all events across all page navigations).
   * Called by session-bridge on stop to build the session recording.
   */
  get events() {
    return this._eventBuffer;
  }

  /**
   * Attach listeners and start receiving signals.
   */
  start() {
    if (this._started) return;
    this._started = true;

    this._wc.on("console-message", this._onConsoleMessage);

    const ses = this._wc.session || session.defaultSession;

    this._onBeforeRequest = (details, callback) => {
      callback({});
      if (details.webContentsId !== this._wcId) return;
      if (!BLOCKING_RESOURCE_TYPES.has(details.resourceType)) return;
      if (NON_BLOCKING_URL_RE.test(details.url)) return;

      this._pendingRequests.set(details.id, {
        url: details.url,
        startedAt: Date.now(),
      });

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

    const ses = this._wc.session || session.defaultSession;
    ses.webRequest.onBeforeRequest(null);
    ses.webRequest.onCompleted(null);
    ses.webRequest.onErrorOccurred(null);

    this._onBeforeRequest = null;
    this._onRequestCompleted = null;
    this._onRequestFailed = null;
  }

  /**
   * Drain all rrweb events from the page into the main-process buffer.
   * Clears the page array so events aren't double-counted.
   * Returns the number of events drained.
   */
  async drainEvents() {
    try {
      const eventsJson = await this._wc.executeJavaScript(`
        (function() {
          var events = window.__bw_events || [];
          window.__bw_events = [];
          return JSON.stringify(events);
        })()
      `);
      const events = JSON.parse(eventsJson);
      if (events.length > 0) {
        this._eventBuffer.push(...events);
      }
      return events.length;
    } catch {
      return 0;
    }
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

    // Drain events eagerly to prevent loss if the page navigates away.
    // Skip during snapshot capture — _captureSnapshot manages its own drain.
    if (!this._capturing) {
      this.drainEvents().catch(() => {});
    }

    if (signal.type === "interaction") {
      this._beginSettleCycle();
    } else if (signal.type === "mutation") {
      if (this._phase === "settling") {
        this._resetDebounce();
      }
    }
  }

  _beginSettleCycle() {
    if (this._phase === "settling") {
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
  }

  _forceScan() {
    this._hardTimer = null;
    if (this._phase !== "settling") return;
    this._executeScan();
  }

  _checkNetworkIdle() {
    if (this._phase !== "settling") return;
    if (!this._isNetworkIdle()) return;

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

    if (this._capturing) return;
    this._captureSnapshot().catch((err) => {
      console.warn("[browserwire-electron] snapshot capture failed:", err.message);
    });
  }

  /**
   * Capture a snapshot marker.
   *
   * 1. Trigger a FullSnapshot checkpoint in rrweb (adds Meta + FullSnapshot to page array)
   * 2. Drain ALL events from the page into the main-process buffer
   * 3. The eventIndex is the position of the FullSnapshot in the cumulative buffer
   * 4. Take a screenshot
   */
  async _captureSnapshot() {
    this._capturing = true;
    try {
      const wc = this._wc;

      await new Promise((r) => setTimeout(r, 50));

      // 1. Trigger rrweb FullSnapshot checkpoint
      try {
        await wc.executeJavaScript(`
          if (typeof rrweb !== 'undefined' && rrweb.record) {
            rrweb.record.takeFullSnapshot();
          }
          void 0;
        `);
      } catch (err) {
        console.warn("[browserwire-electron] rrweb checkout failed:", err.message);
        return;
      }

      // 2. Drain all events from page into main-process buffer
      const drained = await this.drainEvents();

      // Find the FullSnapshot (type=2) in the drained batch.
      // It may not be the last event — rrweb can emit IncrementalSnapshot
      // events for mutations triggered by the snapshot process itself.
      let eventIndex = -1;
      for (let i = this._eventBuffer.length - 1; i >= this._eventBuffer.length - drained && i >= 0; i--) {
        if (this._eventBuffer[i]?.type === 2) {
          eventIndex = i;
          break;
        }
      }

      if (eventIndex === -1) {
        console.warn(
          `[browserwire-electron] no FullSnapshot found in drained ${drained} events, buffer size ${this._eventBuffer.length}`
        );
        return;
      }

      // 3. Get page metadata
      let url, title;
      try {
        const meta = await wc.executeJavaScript(`
          JSON.stringify({ url: location.href, title: document.title })
        `);
        const parsed = JSON.parse(meta);
        url = parsed.url;
        title = parsed.title;
      } catch {
        url = "unknown";
        title = "unknown";
      }

      // 4. Screenshot
      let screenshotBase64 = null;
      try {
        const image = await wc.capturePage();
        screenshotBase64 = image.toJPEG(50).toString("base64");
      } catch (err) {
        console.warn("[browserwire-electron] screenshot failed:", err.message);
      }

      this._snapshotCount++;

      console.log(
        `[browserwire-electron] snapshot #${this._snapshotCount}: eventIndex=${eventIndex}, ` +
        `buffer=${this._eventBuffer.length} events, drained=${drained}`
      );

      this._onSnapshot({
        snapshotId: `snap_${this._snapshotCount}`,
        eventIndex,
        screenshot: screenshotBase64,
        url,
        title,
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
