/**
 * settle-cycle.js — Main-process settle state machine for Electron.
 *
 * Replaces the injected SETTLE_CYCLE_SCRIPT with native Electron APIs:
 *   - session.webRequest for network idle tracking
 *   - webContents.on('console-message') for page signals (click/input/mutation)
 *   - On settle: captures snapshot via executeJavaScript + capturePage
 */

import { session } from "electron";
import { annotateScreenshot } from "./screenshot.js";

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
    this._pendingTrigger = null;
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
    this._pendingTrigger = null;
    this._pendingRequests.clear();
    this._hideOverlay();

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
      this._beginSettleCycle(signal.trigger || { kind: "unknown" });
    } else if (signal.type === "mutation") {
      // DOM mutations during settling reset the debounce
      if (this._phase === "settling") {
        this._resetDebounce();
      }
    }
  }

  _beginSettleCycle(trigger) {
    if (this._phase === "settling") {
      // Already settling — update trigger, reset debounce, keep hard cap
      this._pendingTrigger = trigger;
      this._pendingRequests.clear(); // reset network tracking for this interaction
      this._resetDebounce();
      return;
    }

    this._phase = "settling";
    this._pendingTrigger = trigger;
    this._pendingRequests.clear();

    this._showOverlay();

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
    const trigger = this._pendingTrigger;
    this._phase = "idle";
    this._pendingTrigger = null;

    // Avoid concurrent captures
    if (this._capturing) return;
    this._captureSnapshot(trigger).catch((err) => {
      console.warn("[browserwire-electron] snapshot capture failed:", err.message);
      this._hideOverlay();
    });
  }

  async _captureSnapshot(trigger) {
    this._capturing = true;
    try {
      const wc = this._wc;

      // Remove overlay before capturing so it doesn't appear in screenshot/DOM
      await this._hideOverlay();
      await new Promise((r) => setTimeout(r, 50)); // wait one frame for repaint

      // 1. Capture DOM + skeleton as JSON string (avoids IPC serialization issues)
      let json;
      try {
        json = await wc.executeJavaScript(`
          (function() {
            var domHtml = null;
            try { domHtml = typeof serializeDom === 'function' ? serializeDom() : null; } catch(e) {}
            var pageText = '';
            try { pageText = typeof collectPageText === 'function' ? collectPageText() : ''; } catch(e) {}
            var pageState = {};
            try { pageState = typeof capturePageState === 'function' ? capturePageState() : {}; } catch(e) {}
            var skeletonData = { skeleton: [] };
            try { skeletonData = typeof runSkeletonScan === 'function' ? runSkeletonScan() : { skeleton: [] }; } catch(e) {}
            return JSON.stringify({
              domHtml: domHtml,
              pageText: pageText,
              pageState: pageState,
              skeleton: skeletonData.skeleton || [],
              url: location.href,
              title: document.title,
              devicePixelRatio: window.devicePixelRatio || 1,
              capturedAt: new Date().toISOString()
            });
          })()
        `);
      } catch (err) {
        console.warn("[browserwire-electron] DOM capture failed:", err.message);
        return;
      }

      let snapshot;
      try {
        snapshot = JSON.parse(json);
      } catch {
        console.warn("[browserwire-electron] Failed to parse snapshot JSON");
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

      // 3. Annotate screenshot with skeleton boxes
      let annotated = screenshotBase64;
      if (screenshotBase64 && snapshot.skeleton && snapshot.skeleton.length > 0) {
        try {
          annotated = await annotateScreenshot(
            screenshotBase64,
            snapshot.skeleton,
            snapshot.devicePixelRatio || 1
          );
        } catch (err) {
          console.warn("[browserwire-electron] annotation failed:", err.message);
        }
      }

      this._snapshotCount++;

      this._onSnapshot({
        snapshotId: `snap_electron_${this._snapshotCount}`,
        trigger,
        domHtml: snapshot.domHtml,
        pageText: snapshot.pageText,
        pageState: { ...snapshot.pageState, skeleton: snapshot.skeleton },
        skeleton: snapshot.skeleton,
        url: snapshot.url,
        title: snapshot.title,
        devicePixelRatio: snapshot.devicePixelRatio,
        capturedAt: snapshot.capturedAt,
        networkLog: [],
        screenshot: annotated,
      });
    } finally {
      this._capturing = false;
    }
  }

  // ─── Overlay ─────────────────────────────────────────────────────

  _showOverlay() {
    this._wc.executeJavaScript(`
      (function() {
        if (document.getElementById('__bw_overlay')) return;
        var d = document.createElement('div');
        d.id = '__bw_overlay';
        d.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.45);z-index:2147483647;display:flex;align-items:center;justify-content:center;';
        d.innerHTML = '<div style="background:#fff;padding:12px 20px;border-radius:8px;font:500 13px/1.4 system-ui,-apple-system,sans-serif;color:#333;display:flex;align-items:center;gap:10px;box-shadow:0 2px 12px rgba(0,0,0,0.15)">'
          + '<svg width="18" height="18" viewBox="0 0 24 24" style="animation:__bw_spin 0.8s linear infinite;flex-shrink:0"><circle cx="12" cy="12" r="10" stroke="#888" stroke-width="2.5" fill="none" stroke-dasharray="31.4 31.4" stroke-linecap="round"/></svg>'
          + 'Taking snapshot\\u2026</div>';
        var s = document.createElement('style');
        s.id = '__bw_overlay_style';
        s.textContent = '@keyframes __bw_spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(s);
        document.body.appendChild(d);
      })()
    `).catch(() => {});
  }

  async _hideOverlay() {
    try {
      await this._wc.executeJavaScript(`
        var el = document.getElementById('__bw_overlay');
        if (el) el.remove();
        var st = document.getElementById('__bw_overlay_style');
        if (st) st.remove();
        void 0;
      `);
    } catch {
      // Page may have navigated
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
