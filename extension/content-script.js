/**
 * content-script.js — Dynamic Discovery Observer
 *
 * 3-state machine: IDLE → SETTLING → scan → IDLE
 *
 * Uses native DOM events (click, input, MutationObserver) instead of rrweb.
 * Two timers only:
 *   - settleTimer: 500ms debounce, resets on DOM mutations
 *   - hardTimer: 4s cap from first unscanned interaction, never resets
 */

const SETTLE_DEBOUNCE_MS = 500;
const SETTLE_HARD_TIMEOUT_MS = 4000;
const DEBUG = false;

// ─── Network Capture (received from MAIN world network-hook.js) ─────

let _pendingNetwork = 0;
const _networkLog = [];
const NETWORK_LOG_CAP = 100;

const drainNetworkLog = () => _networkLog.splice(0);

const isNetworkIdle = () => _pendingNetwork === 0;

// ─── State ──────────────────────────────────────────────────────────

const state = {
  active: false,
  sessionId: null,
  snapshotCount: 0,
  lastUrl: window.location.href,
  phase: "idle",        // "idle" | "settling"
  pendingTrigger: null,
  settleTimer: null,
  hardTimer: null
};

// ─── Timers ─────────────────────────────────────────────────────────

const clearTimers = () => {
  if (state.settleTimer) { clearTimeout(state.settleTimer); state.settleTimer = null; }
  if (state.hardTimer) { clearTimeout(state.hardTimer); state.hardTimer = null; }
};

// ─── Network message handler ────────────────────────────────────────

const onNetworkIdle = () => {
  if (state.phase !== "settling") return;
  if (!isNetworkIdle()) return;
  // Network just drained — short paint-flush then settle check
  if (!state.settleTimer) {
    state.settleTimer = setTimeout(onSettle, 100);
  }
};

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== "browserwire-network-hook") return;

  if (msg.type === "req_start") {
    if (state.active && state.phase === "settling") _pendingNetwork++;
  } else if (msg.type === "req_end") {
    if (state.active && _pendingNetwork > 0) {
      _pendingNetwork = Math.max(0, _pendingNetwork - 1);
      onNetworkIdle();
    }
  } else if (msg.type === "entry") {
    _networkLog.push(msg.detail);
    if (_networkLog.length > NETWORK_LOG_CAP) _networkLog.shift();
  }
});

// ─── Trigger Context Capture ────────────────────────────────────────

/**
 * Walk up the DOM to find nearest landmark role and heading.
 */
const getParentContext = (el) => {
  const LANDMARK_ROLES = new Set([
    "navigation", "main", "banner", "contentinfo", "complementary",
    "form", "region", "search", "dialog"
  ]);
  const LANDMARK_TAGS = {
    nav: "navigation", main: "main", header: "banner",
    footer: "contentinfo", aside: "complementary", form: "form",
    dialog: "dialog"
  };
  const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

  let nearestLandmark = null;
  let nearestHeading = null;
  let node = el?.parentElement;

  while (node && node !== document.body) {
    if (!nearestLandmark) {
      const role = node.getAttribute("role") || LANDMARK_TAGS[node.tagName.toLowerCase()] || null;
      if (role && LANDMARK_ROLES.has(role)) {
        nearestLandmark = role;
      }
    }

    if (!nearestHeading) {
      for (const child of node.children) {
        if (HEADING_TAGS.has(child.tagName.toLowerCase())) {
          nearestHeading = (child.textContent || "").trim().slice(0, 100);
          break;
        }
      }
    }

    if (nearestLandmark && nearestHeading) break;
    node = node.parentElement;
  }

  return { nearestLandmark, nearestHeading };
};

/**
 * Extract rich trigger context from a DOM element.
 */
const captureTriggerContext = (el, kind) => {
  if (!el || !(el instanceof HTMLElement)) {
    return {
      kind,
      target: null,
      parentContext: null,
      url: window.location.href,
      title: document.title,
      timestamp: Date.now()
    };
  }

  const attrs = {};
  for (const name of ["href", "data-testid", "type", "name", "placeholder", "aria-expanded", "aria-selected"]) {
    const val = el.getAttribute(name);
    if (val != null) attrs[name] = val;
  }

  return {
    kind,
    target: {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().slice(0, 100),
      role: el.getAttribute("role") || null,
      name: el.getAttribute("aria-label") || el.getAttribute("title") || null,
      attributes: attrs
    },
    parentContext: getParentContext(el),
    url: window.location.href,
    title: document.title,
    timestamp: Date.now()
  };
};

// ─── Scan Execution ─────────────────────────────────────────────────

const executeScan = () => {
  clearTimers();
  const trigger = state.pendingTrigger;
  state.phase = "idle";
  state.pendingTrigger = null;

  if (DEBUG) console.debug("[browserwire] executeScan", trigger?.kind, "snapshot#", state.snapshotCount + 1);

  if (typeof serializeDom !== "function") {
    if (DEBUG) console.debug("[browserwire] serializeDom unavailable — skipping");
    return;
  }

  try {
    const domHtml = serializeDom();
    const pageText = typeof collectPageText === "function" ? collectPageText() : "";
    const pageState = typeof capturePageState === "function" ? capturePageState() : {};
    state.snapshotCount += 1;

    chrome.runtime.sendMessage({
      source: "content",
      type: "snapshot",
      payload: {
        snapshotId: `snap_${state.sessionId}_${state.snapshotCount}`,
        sessionId: state.sessionId,
        trigger,
        domHtml,
        pageText,
        url: window.location.href,
        title: document.title,
        devicePixelRatio: window.devicePixelRatio || 1,
        capturedAt: new Date().toISOString(),
        pageState,
        networkLog: drainNetworkLog()
      }
    }, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) {
    console.warn("[browserwire] DOM serialization failed:", error);
  }
};

// ─── Settle Cycle (3-State Machine) ─────────────────────────────────

const onSettle = () => {
  state.settleTimer = null;
  if (state.phase !== "settling") return;
  if (isNetworkIdle()) {
    executeScan();
  }
  // else: network still active — wait for onNetworkIdle or hardTimer
};

const forceScan = () => {
  state.hardTimer = null;
  if (state.phase !== "settling") return;
  if (DEBUG) console.debug("[browserwire] hard cap reached — forcing scan");
  executeScan();
};

const beginSettleCycle = (trigger) => {
  if (state.phase === "settling") {
    // Already settling — update trigger, reset debounce, keep hard cap
    state.pendingTrigger = trigger;
    _pendingNetwork = 0;
    if (state.settleTimer) clearTimeout(state.settleTimer);
    state.settleTimer = setTimeout(onSettle, SETTLE_DEBOUNCE_MS);
    return;
  }

  state.phase = "settling";
  state.pendingTrigger = trigger;
  _pendingNetwork = 0;
  state.settleTimer = setTimeout(onSettle, SETTLE_DEBOUNCE_MS);
  state.hardTimer = setTimeout(forceScan, SETTLE_HARD_TIMEOUT_MS);
};

// ─── Native Event Listeners ─────────────────────────────────────────

let _mutationObserver = null;

const onClickCapture = (event) => {
  if (!state.active) return;
  const trigger = captureTriggerContext(event.target, "click");
  if (DEBUG) console.debug("[browserwire] click", trigger?.target?.text?.slice(0, 40));
  beginSettleCycle(trigger);
};

const onInputCapture = (event) => {
  if (!state.active) return;
  const trigger = captureTriggerContext(event.target, "input");
  if (DEBUG) console.debug("[browserwire] input", trigger?.target?.tag);
  beginSettleCycle(trigger);
};

const onMutationBatch = () => {
  if (state.phase !== "settling") return;
  // DOM still changing — reset settle debounce (hard cap stays)
  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = setTimeout(onSettle, SETTLE_DEBOUNCE_MS);
};

const attachListeners = () => {
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("input", onInputCapture, true);

  _mutationObserver = new MutationObserver(onMutationBatch);
  _mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
};

const detachListeners = () => {
  document.removeEventListener("click", onClickCapture, true);
  document.removeEventListener("input", onInputCapture, true);

  if (_mutationObserver) {
    _mutationObserver.disconnect();
    _mutationObserver = null;
  }
};

// ─── SPA Navigation Detection ───────────────────────────────────────

const handleNavigation = () => {
  if (!state.active) return;
  if (window.location.href === state.lastUrl) return;
  state.lastUrl = window.location.href;
  const trigger = captureTriggerContext(null, "navigation");
  if (DEBUG) console.debug("[browserwire] navigation", window.location.href);
  beginSettleCycle(trigger);
};

window.addEventListener("popstate", handleNavigation);
window.addEventListener("hashchange", handleNavigation);

// Listen for pushState/replaceState from the MAIN world hook.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== "browserwire-network-hook" || msg.type !== "pushstate") return;
  handleNavigation();
});

// ─── Session Lifecycle ──────────────────────────────────────────────

const startExploring = (sessionId) => {
  if (!sessionId || typeof sessionId !== "string") {
    return { ok: false, error: "invalid_session" };
  }

  if (state.active && state.sessionId === sessionId) {
    return { ok: true, alreadyRunning: true };
  }

  if (state.active) {
    stopExploring();
  }

  state.active = true;
  _pendingNetwork = 0;
  state.sessionId = sessionId;
  state.snapshotCount = 0;
  state.lastUrl = window.location.href;
  state.phase = "idle";
  state.pendingTrigger = null;

  attachListeners();

  // Kick off initial settle cycle — the normal state machine produces the first snapshot
  beginSettleCycle(captureTriggerContext(null, "initial"));

  return { ok: true, sessionId };
};

const stopExploring = () => {
  clearTimers();
  detachListeners();

  state.active = false;
  state.sessionId = null;
  state.snapshotCount = 0;
  state.phase = "idle";
  state.pendingTrigger = null;
};

// ─── API Request Matching ───────────────────────────────────────────

const matchesApiRequest = (entry, apiRequest) => {
  if (entry.method !== apiRequest.method) return false;

  try {
    const pathname = new URL(entry.url, window.location.origin).pathname;
    const regexPath = apiRequest.pathPattern
      .replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, '[^/]+')
      .replace(/\//g, '\\/');
    if (!new RegExp(`^${regexPath}$`).test(pathname)) return false;
  } catch { return false; }

  const matchOn = apiRequest.matchOn;
  if (!matchOn) return true;

  if (matchOn.operationName) {
    const opName = entry.requestBody?.operationName;
    if (opName !== matchOn.operationName) return false;
  }

  if (matchOn.queryParams && Array.isArray(matchOn.queryParams)) {
    const entryParams = entry.queryParams || {};
    for (const key of matchOn.queryParams) {
      if (!(key in entryParams)) return false;
    }
  }

  return true;
};

// ─── Message Listener ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== "background") {
    return false;
  }

  if (message.command === "get_network_log") {
    const apiRequest = message.apiRequest;
    const sinceTs = typeof message.sinceTs === "number" ? message.sinceTs : null;
    let entries = [..._networkLog];  // non-destructive copy
    if (sinceTs != null) {
      entries = entries.filter(e => (e.timestamp || 0) >= sinceTs);
    }
    if (apiRequest) {
      entries = entries.filter(e => matchesApiRequest(e, apiRequest));
    }
    sendResponse({ ok: true, entries });
    return false;
  }

  if (message.command === "clear_network_log") {
    _networkLog.splice(0);
    sendResponse({ ok: true });
    return false;
  }

  if (message.command === "explore_start") {
    sendResponse(startExploring(message.sessionId));
    return false;
  }

  if (message.command === "explore_stop") {
    stopExploring();
    sendResponse({ ok: true });
    return false;
  }

  if (message.command === "discovery_scan") {
    try {
      if (typeof runDiscoveryScan === "function") {
        const snapshot = runDiscoveryScan();
        sendResponse({ ok: true, snapshot });
      } else {
        sendResponse({ ok: false, error: "discovery_scan_unavailable" });
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "discovery_scan_failed"
      });
    }
    return false;
  }

  return false;
});

window.addEventListener("beforeunload", () => {
  if (state.active) {
    stopExploring();
  }
});
