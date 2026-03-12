/**
 * content-script.js — Dynamic Discovery Observer
 *
 * Uses rrweb's event stream to detect user interactions and DOM settle,
 * then triggers M1 scans (via discovery.js) and sends tagged snapshots
 * to the CLI server.
 *
 * rrweb events used:
 *   - MouseInteraction (source=2): click, focus, blur, touch — interaction trigger
 *   - Mutation (source=0): DOM changes — settle detection signal
 *   - Input (source=5): text/select/checkbox changes — input trigger
 */

const SETTLE_DEBOUNCE_MS = 300;
const SETTLE_HARD_TIMEOUT_MS = 3000;

/** rrweb IncrementalSource constants */
const RRWEB_SOURCE = {
  MUTATION: 0,
  MOUSE_INTERACTION: 2,
  INPUT: 5
};

/** rrweb EventType constants */
const RRWEB_TYPE = {
  INCREMENTAL: 3,
  META: 4
};

// ─── Network Idle Tracking ──────────────────────────────────────────

let _pendingNetwork = 0;
let _networkHooked = false;

const isNetworkIdle = () => _pendingNetwork === 0;

const onNetworkSettle = () => {
  if (!discoveryState.active || !discoveryState.pendingSettle) return;
  if (!isNetworkIdle()) return;
  // Network just drained — reschedule settle with short paint-flush delay
  if (discoveryState.settleTimer) clearTimeout(discoveryState.settleTimer);
  discoveryState.settleTimer = setTimeout(() => {
    if (discoveryState.pendingSettle) triggerScan(discoveryState.pendingTrigger);
  }, 100);
};

const hookNetwork = () => {
  if (_networkHooked) return;
  _networkHooked = true;

  const _origFetch = window.fetch;
  window.fetch = function(...args) {
    if (discoveryState.active) _pendingNetwork++;
    return _origFetch.apply(this, args).finally(() => {
      if (discoveryState.active) { _pendingNetwork = Math.max(0, _pendingNetwork - 1); onNetworkSettle(); }
    });
  };

  const _origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    if (discoveryState.active) {
      _pendingNetwork++;
      this.addEventListener('loadend', () => {
        if (discoveryState.active) { _pendingNetwork = Math.max(0, _pendingNetwork - 1); onNetworkSettle(); }
      }, { once: true });
    }
    return _origSend.apply(this, args);
  };
};

const discoveryState = {
  active: false,
  sessionId: null,
  stopRecording: null,
  snapshotCount: 0,
  /** Whether we're waiting for DOM to settle after an interaction */
  pendingSettle: false,
  /** Info about the interaction that triggered the current settle wait */
  pendingTrigger: null,
  settleTimer: null,
  hardTimer: null,
  /** Last known URL — for SPA navigation detection */
  lastUrl: window.location.href
};

const getRecordApi = () => {
  if (typeof rrweb !== "undefined" && rrweb && typeof rrweb.record === "function") {
    return rrweb;
  }

  return null;
};

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
    // Check landmark
    if (!nearestLandmark) {
      const role = node.getAttribute("role") || LANDMARK_TAGS[node.tagName.toLowerCase()] || null;
      if (role && LANDMARK_ROLES.has(role)) {
        nearestLandmark = role;
      }
    }

    // Check heading (first heading sibling or child near this path)
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

// ─── rrweb Event Filters ────────────────────────────────────────────

const isInteractionEvent = (event) => {
  if (event.type !== RRWEB_TYPE.INCREMENTAL) return false;
  const source = event.data?.source;
  return source === RRWEB_SOURCE.MOUSE_INTERACTION || source === RRWEB_SOURCE.INPUT;
};

const isMutationEvent = (event) =>
  event.type === RRWEB_TYPE.INCREMENTAL && event.data?.source === RRWEB_SOURCE.MUTATION;

const isMetaEvent = (event) =>
  event.type === RRWEB_TYPE.META;

// ─── DOM Settle Detection ───────────────────────────────────────────

const clearSettleTimers = () => {
  if (discoveryState.settleTimer) {
    clearTimeout(discoveryState.settleTimer);
    discoveryState.settleTimer = null;
  }
  if (discoveryState.hardTimer) {
    clearTimeout(discoveryState.hardTimer);
    discoveryState.hardTimer = null;
  }
};

/**
 * Resolve target element from rrweb MouseInteraction event.
 * rrweb stores a numeric id that maps to the mirrored node.
 * We try rrweb.mirror first, then fall back to document lookup.
 */
const resolveTarget = (event) => {
  const id = event.data?.id;
  if (!id) return null;

  // rrweb uses a mirror to map ids to elements
  if (typeof rrweb !== "undefined" && rrweb.mirror && typeof rrweb.mirror.getNode === "function") {
    return rrweb.mirror.getNode(id) || null;
  }

  return null;
};

const triggerScan = (trigger) => {
  clearSettleTimers();
  discoveryState.pendingSettle = false;
  discoveryState.pendingTrigger = null;

  // runSkeletonScan is defined in discovery.js, also injected as content script
  if (typeof runSkeletonScan !== "function") {
    return;
  }

  try {
    const skeletonResult = runSkeletonScan();
    discoveryState.snapshotCount += 1;

    chrome.runtime.sendMessage({
      source: "content",
      type: "discovery_incremental",
      payload: {
        snapshotId: `snap_${discoveryState.sessionId}_${discoveryState.snapshotCount}`,
        sessionId: discoveryState.sessionId,
        trigger,
        skeleton: skeletonResult.skeleton,
        pageText: skeletonResult.pageText,
        url: skeletonResult.url,
        title: skeletonResult.title,
        devicePixelRatio: skeletonResult.devicePixelRatio,
        capturedAt: skeletonResult.capturedAt,
        pageState: skeletonResult.pageState
      }
    }, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) {
    // Scan failed — log but don't crash
    console.warn("[browserwire] skeleton scan failed:", error);
  }
};

const onInteraction = (event) => {
  if (!discoveryState.active) return;

  const target = resolveTarget(event);
  const kind = event.data?.source === RRWEB_SOURCE.INPUT ? "input" : "click";
  const trigger = captureTriggerContext(target, kind);

  // Start watching for DOM settle
  discoveryState.pendingSettle = true;
  discoveryState.pendingTrigger = trigger;

  // Reset settle timer
  clearSettleTimers();
  discoveryState.settleTimer = setTimeout(() => {
    if (!discoveryState.pendingSettle) return;
    if (isNetworkIdle()) {
      triggerScan(discoveryState.pendingTrigger);
    } else {
      // Network still active — reschedule; hard timer is the backstop
      discoveryState.settleTimer = setTimeout(() => {
        if (discoveryState.pendingSettle) triggerScan(discoveryState.pendingTrigger);
      }, SETTLE_DEBOUNCE_MS);
    }
  }, SETTLE_DEBOUNCE_MS);

  // Hard timeout — scan even if mutations keep firing
  discoveryState.hardTimer = setTimeout(() => {
    if (discoveryState.pendingSettle) {
      triggerScan(discoveryState.pendingTrigger);
    }
  }, SETTLE_HARD_TIMEOUT_MS);
};

const onMutation = () => {
  if (!discoveryState.active || !discoveryState.pendingSettle) return;

  // DOM still changing — reset the settle debounce
  if (discoveryState.settleTimer) {
    clearTimeout(discoveryState.settleTimer);
  }

  discoveryState.settleTimer = setTimeout(() => {
    if (!discoveryState.pendingSettle) return;
    if (isNetworkIdle()) {
      triggerScan(discoveryState.pendingTrigger);
    } else {
      // Network still active — reschedule; hard timer is the backstop
      discoveryState.settleTimer = setTimeout(() => {
        if (discoveryState.pendingSettle) triggerScan(discoveryState.pendingTrigger);
      }, SETTLE_DEBOUNCE_MS);
    }
  }, SETTLE_DEBOUNCE_MS);
};

const onNavigation = () => {
  if (!discoveryState.active) return;

  const trigger = captureTriggerContext(null, "navigation");
  discoveryState.pendingSettle = true;
  discoveryState.pendingTrigger = trigger;

  // After navigation, wait for DOM to settle before scanning
  clearSettleTimers();
  discoveryState.settleTimer = setTimeout(() => {
    if (!discoveryState.pendingSettle) return;
    if (isNetworkIdle()) {
      triggerScan(discoveryState.pendingTrigger);
    } else {
      // Network still active — reschedule; hard timer is the backstop
      discoveryState.settleTimer = setTimeout(() => {
        if (discoveryState.pendingSettle) triggerScan(discoveryState.pendingTrigger);
      }, SETTLE_DEBOUNCE_MS);
    }
  }, SETTLE_DEBOUNCE_MS);

  discoveryState.hardTimer = setTimeout(() => {
    if (discoveryState.pendingSettle) {
      triggerScan(discoveryState.pendingTrigger);
    }
  }, SETTLE_HARD_TIMEOUT_MS);
};

// ─── SPA Navigation Detection ───────────────────────────────────────

window.addEventListener("popstate", () => {
  if (discoveryState.active && window.location.href !== discoveryState.lastUrl) {
    discoveryState.lastUrl = window.location.href;
    onNavigation();
  }
});

window.addEventListener("hashchange", () => {
  if (discoveryState.active && window.location.href !== discoveryState.lastUrl) {
    discoveryState.lastUrl = window.location.href;
    onNavigation();
  }
});

// ─── Session Lifecycle ──────────────────────────────────────────────

const startExploring = (sessionId) => {
  if (!sessionId || typeof sessionId !== "string") {
    return { ok: false, error: "invalid_session" };
  }

  if (discoveryState.active && discoveryState.sessionId === sessionId) {
    return { ok: true, alreadyRunning: true };
  }

  if (discoveryState.active) {
    stopExploring();
  }

  const recordApi = getRecordApi();
  if (!recordApi) {
    return { ok: false, error: "rrweb_unavailable" };
  }

  try {
    discoveryState.active = true;
    hookNetwork(); // one-time wrapping of fetch/XHR
    _pendingNetwork = 0; // reset counter at session start
    discoveryState.sessionId = sessionId;
    discoveryState.snapshotCount = 0;
    discoveryState.lastUrl = window.location.href;
    discoveryState.pendingSettle = false;
    discoveryState.pendingTrigger = null;

    // Start rrweb recording — only used for event detection, not sent to server
    discoveryState.stopRecording = recordApi.record({
      emit(event) {
        if (!discoveryState.active) return;

        if (isInteractionEvent(event)) {
          onInteraction(event);
        }
        if (isMutationEvent(event)) {
          onMutation();
        }
        if (isMetaEvent(event)) {
          // URL/title change detected by rrweb
          if (window.location.href !== discoveryState.lastUrl) {
            discoveryState.lastUrl = window.location.href;
            onNavigation();
          }
        }
      }
    });

    // Initial scan — wait for readyState=complete + paint-flush buffer
    const initialTrigger = captureTriggerContext(null, "initial");
    const doInitialScan = () => setTimeout(() => triggerScan(initialTrigger), 200);
    if (document.readyState === 'complete') {
      doInitialScan();
    } else {
      document.addEventListener('readystatechange', function onReady() {
        if (document.readyState === 'complete') {
          document.removeEventListener('readystatechange', onReady);
          doInitialScan();
        }
      });
    }

    return { ok: true, sessionId };
  } catch (error) {
    stopExploring();
    return {
      ok: false,
      error: error instanceof Error ? error.message : "explore_start_failed"
    };
  }
};

const stopExploring = () => {
  clearSettleTimers();

  if (typeof discoveryState.stopRecording === "function") {
    discoveryState.stopRecording();
  }

  discoveryState.active = false;
  discoveryState.sessionId = null;
  discoveryState.snapshotCount = 0;
  discoveryState.stopRecording = null;
  discoveryState.pendingSettle = false;
  discoveryState.pendingTrigger = null;
};

// ─── Message Listener ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== "background") {
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

  // Keep legacy discovery_scan for backward compat (called on initial scan too)
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
  if (discoveryState.active) {
    stopExploring();
  }
});
