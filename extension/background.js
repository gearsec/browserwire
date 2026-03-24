import {
  MessageType,
  parseEnvelope,
  PROTOCOL_VERSION
} from "./shared/protocol.js";
import { encode, decode } from "./shared/codec.js";


const DEFAULT_WS_URL = "ws://127.0.0.1:8787";
const HEARTBEAT_INTERVAL_MS = 20000;
const MAX_LOG_ENTRIES = 200;
const AUTO_CONNECT_MAX_ATTEMPTS = 5;
const PAGE_READY_TIMEOUT_MS = 20000;
const NAVIGATION_OBSERVE_WINDOW_MS = 1200;
const DOM_IDLE_MS = 600;
const DOM_IDLE_PROBE_TIMEOUT_MS = 4000;
const NETWORK_QUIET_MS = 600;
const SETTLE_POLL_INTERVAL_MS = 150;

const BLOCKING_REQUEST_TYPES = new Set([
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "fetch"
]);

const NON_BLOCKING_REQUEST_URL_RE = /google-analytics|segment\.io|sentry\.io|hotjar|intercom|doubleclick|fonts\.(googleapis|gstatic)|\.woff2?|\.ttf|\.css(\?|$)|\.png|\.jpg|\.jpeg|\.svg|\.gif/i;

let wsUrl = DEFAULT_WS_URL;
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let reconnectAttempt = 0;
let shouldReconnect = false;
let autoConnectGaveUp = false;
let activeSession = null;
let logs = [];
let pendingSnapshots = [];
const processingBatches = new Map();

// ─── Per-Tab In-Flight Network Request Tracking ─────────────────────
// Maps tabId → Map(requestId -> request metadata)
const pendingRequests = new Map();

const getPendingSnapshot = (tabId) => {
  const requests = pendingRequests.get(tabId);
  if (!requests) return { total: 0, blocking: 0 };

  let blocking = 0;
  for (const req of requests.values()) {
    if (req?.blocking) blocking += 1;
  }

  return { total: requests.size, blocking };
};

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return; // ignore non-tab requests (e.g. service worker)
    if (!pendingRequests.has(details.tabId)) {
      pendingRequests.set(details.tabId, new Map());
    }

    const requests = pendingRequests.get(details.tabId);
    const type = details.type || "other";
    const url = details.url || "";
    requests.set(details.requestId, {
      type,
      url,
      startedAt: Date.now(),
      blocking: BLOCKING_REQUEST_TYPES.has(type) && !NON_BLOCKING_REQUEST_URL_RE.test(url)
    });
  },
  { urls: ["<all_urls>"] }
);

const onRequestFinished = (details) => {
  if (details.tabId < 0) return;
  const requests = pendingRequests.get(details.tabId);
  if (requests) {
    requests.delete(details.requestId);
    if (requests.size === 0) pendingRequests.delete(details.tabId);
  }
};

chrome.webRequest.onCompleted.addListener(onRequestFinished, { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(onRequestFinished, { urls: ["<all_urls>"] });

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  pendingRequests.delete(tabId);
});

const notifyAllContexts = (payload) => {
  chrome.runtime.sendMessage({ source: "background", ...payload }, () => {
    void chrome.runtime.lastError;
  });
};

const addLog = (message) => {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  logs = [line, ...logs].slice(0, MAX_LOG_ENTRIES);
  notifyAllContexts({ event: "log", line });
};

const getBackendState = () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return "connected";
  }

  if (socket && socket.readyState === WebSocket.CONNECTING) {
    return "connecting";
  }

  if (shouldReconnect) {
    return "reconnecting";
  }

  return "disconnected";
};

const getState = () => ({
  wsUrl,
  backendState: getBackendState(),
  reconnectAttempt,
  autoConnectGaveUp,
  session: activeSession,
  processingBatches: [...processingBatches.entries()].map(([id, b]) => ({ batchId: id, ...b })),
  logs
});

const broadcastState = () => {
  notifyAllContexts({ event: "state", state: getState() });
};

const clearTimers = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
};

const sendToBackend = (type, payload = {}, requestId = crypto.randomUUID()) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(encode(type, payload, requestId));
  return true;
};

const scheduleReconnect = () => {
  reconnectAttempt += 1;

  if (reconnectAttempt >= AUTO_CONNECT_MAX_ATTEMPTS) {
    shouldReconnect = false;
    autoConnectGaveUp = true;
    addLog("auto-connect gave up after max attempts");
    broadcastState();
    return;
  }

  const delay = Math.min(30000, 500 * 2 ** reconnectAttempt);
  addLog(`backend reconnect scheduled in ${Math.round(delay / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    connectBackend();
  }, delay);
};

const onBackendMessage = (rawMessage) => {
  // Try binary (protobuf) first, then JSON fallback
  let message;
  if (rawMessage instanceof ArrayBuffer || rawMessage instanceof Uint8Array) {
    const bytes = rawMessage instanceof ArrayBuffer ? new Uint8Array(rawMessage) : rawMessage;
    message = decode(bytes);
  } else {
    message = parseEnvelope(rawMessage);
  }

  if (!message) {
    addLog("received undecodable message from backend");
    return;
  }

  if (message.type === MessageType.DISCOVERY_SESSION_STATUS) {
    const { sessionId, status } = message.payload || {};
    addLog(`session status: sessionId=${sessionId ?? "unknown"} status=${status ?? "unknown"}`);

    if (activeSession) {
      broadcastState();
    }
    return;
  }

  if (message.type === MessageType.BATCH_PROCESSING_STATUS) {
    const { batchId, status, error } = message.payload || {};
    if (!batchId) return;

    if (status === "pending") {
      processingBatches.set(batchId, { ...(processingBatches.get(batchId) || {}), status: "pending", updatedAt: Date.now() });
      addLog(`batch ${batchId.slice(0, 8)}… pending (queued)`);
    } else if (status === "processing") {
      const existing = processingBatches.get(batchId);
      processingBatches.set(batchId, { ...(existing || {}), status: "processing", updatedAt: Date.now() });
      addLog(`batch ${batchId.slice(0, 8)}… processing`);
    } else if (status === "complete") {
      processingBatches.delete(batchId);
      addLog(`batch ${batchId.slice(0, 8)}… complete`);
    } else if (status === "error") {
      processingBatches.set(batchId, { ...(processingBatches.get(batchId) || {}), status: "error", error: error || "unknown", updatedAt: Date.now() });
      addLog(`batch ${batchId.slice(0, 8)}… error: ${error || "unknown"}`);
    }

    notifyAllContexts({ event: "batch_status", batchId, status, error: error || null });
    broadcastState();
    return;
  }

  if (message.type === MessageType.ERROR) {
    addLog(`backend error: ${message.payload?.message || "unknown"}`);
    return;
  }

  if (message.type === MessageType.HELLO_ACK) {
    addLog("backend handshake acknowledged");
    return;
  }

  if (message.type === MessageType.EXECUTE_WORKFLOW) {
    handleExecuteWorkflow(message);
    return;
  }

  if (message.type !== MessageType.STATUS) {
    addLog(`backend message: ${message.type}`);
  }
};

const connectBackend = (nextUrl) => {
  if (nextUrl && typeof nextUrl === "string") {
    wsUrl = nextUrl;
  }

  autoConnectGaveUp = false;
  shouldReconnect = true;

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    broadcastState();
    return { ok: true, reused: true, state: getState() };
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  addLog(`connecting to ${wsUrl}`);
  try {
    socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";
  } catch (error) {
    shouldReconnect = false;
    addLog("invalid backend websocket URL");
    return {
      ok: false,
      error: "invalid_ws_url",
      state: getState()
    };
  }
  broadcastState();

  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    autoConnectGaveUp = false;
    addLog("backend connected");

    sendToBackend(MessageType.HELLO, {
      client: "browserwire-extension-background",
      version: PROTOCOL_VERSION
    });

    heartbeatTimer = setInterval(() => {
      sendToBackend(MessageType.PING, { source: "background" });
    }, HEARTBEAT_INTERVAL_MS);

    broadcastState();
  });

  socket.addEventListener("message", (event) => {
    onBackendMessage(event.data);
  });

  socket.addEventListener("close", () => {
    clearTimers();
    socket = null;

    // Mark all in-flight batches as error
    for (const [batchId, batch] of processingBatches) {
      if (batch.status === "sent" || batch.status === "processing") {
        processingBatches.set(batchId, { ...batch, status: "error", error: "Backend disconnected", updatedAt: Date.now() });
      }
    }

    addLog("backend disconnected");
    broadcastState();

    if (shouldReconnect) {
      scheduleReconnect();
    }
  });

  socket.addEventListener("error", () => {
    addLog("backend websocket error");
  });

  return { ok: true, state: getState() };
};

const disconnectBackend = () => {
  shouldReconnect = false;
  autoConnectGaveUp = true;
  reconnectAttempt = 0;
  clearTimers();

  if (socket) {
    const closingSocket = socket;
    socket = null;
    closingSocket.close();
  }

  addLog("backend disconnected manually");
  broadcastState();
};

const queryActiveTab = () =>
  new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] || null);
    });
  });


const sendTabMessage = (tabId, message) =>
  new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });

// ─── Exploration Session ────────────────────────────────────────────

const startExploring = async () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return {
      ok: false,
      error: "backend_not_connected",
      state: getState()
    };
  }

  const tab = await queryActiveTab();

  if (!tab || typeof tab.id !== "number") {
    return {
      ok: false,
      error: "no_active_tab",
      state: getState()
    };
  }

  if (activeSession) {
    await stopExploring();
  }

  const sessionId = crypto.randomUUID();

  // Reload the tab so network requests from page load are captured in the first snapshot
  try {
    await chrome.tabs.reload(tab.id);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("tab_reload_timeout"));
      }, 15000);
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "tab_reload_failed",
      state: getState()
    };
  }

  let response;
  try {
    response = await sendTabMessage(tab.id, {
      source: "background",
      command: "explore_start",
      sessionId
    });
  } catch (error) {
    return {
      ok: false,
      error: "content_script_unavailable",
      state: getState()
    };
  }

  if (!response || response.ok !== true) {
    return {
      ok: false,
      error: response?.error || "explore_start_failed",
      state: getState()
    };
  }

  activeSession = {
    sessionId,
    tabId: tab.id,
    url: tab.url || "",
    title: tab.title || "",
    startedAt: new Date().toISOString(),
    snapshotCount: 0,
    entityCount: 0,
    actionCount: 0
  };

  sendToBackend(MessageType.DISCOVERY_SESSION_START, {
    sessionId,
    tabId: tab.id,
    url: tab.url || "",
    title: tab.title || "",
    startedAt: activeSession.startedAt
  });

  addLog(`exploration started on tab ${tab.id}`);
  broadcastState();

  return {
    ok: true,
    sessionId,
    state: getState()
  };
};

const stopExploring = async (note) => {
  if (!activeSession) {
    return { ok: true, idle: true, state: getState() };
  }

  const sessionToStop = activeSession;
  const remainingSnapshots = pendingSnapshots.slice();
  const batchId = crypto.randomUUID();
  activeSession = null;
  pendingSnapshots = [];

  // Register batch as sent
  processingBatches.set(batchId, {
    sessionId: sessionToStop.sessionId,
    status: "sent",
    snapshotCount: remainingSnapshots.length,
    startedAt: Date.now()
  });

  try {
    await sendTabMessage(sessionToStop.tabId, {
      source: "background",
      command: "explore_stop",
      sessionId: sessionToStop.sessionId
    });
  } catch (error) {
    addLog(`failed to notify tab ${sessionToStop.tabId} to stop exploring`);
  }

  sendToBackend(MessageType.DISCOVERY_SESSION_STOP, {
    sessionId: sessionToStop.sessionId,
    batchId,
    note: note || null,
    stoppedAt: new Date().toISOString(),
    pendingSnapshots: remainingSnapshots
  });

  if (remainingSnapshots.length > 0) {
    addLog(`exploration stopped (flushed ${remainingSnapshots.length} buffered snapshots, batch ${batchId.slice(0, 8)}…)`);
  } else {
    addLog(`exploration stopped (batch ${batchId.slice(0, 8)}…)`);
  }
  broadcastState();

  return { ok: true, state: getState() };
};

/**
 * Annotate a JPEG screenshot data URL with orange boxes around interactable
 * skeleton elements, labeled with their s-ID.
 * Returns base64-encoded annotated JPEG, or null on failure.
 */
const annotateScreenshot = async (screenshotDataUrl, skeleton, devicePixelRatio) => {
  try {
    const comma = screenshotDataUrl.indexOf(",");
    if (comma === -1) return null;

    const b64 = screenshotDataUrl.slice(comma + 1);
    const byteStr = atob(b64);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    const blob = new Blob([arr], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);

    const dpr = devicePixelRatio || 1;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);

    ctx.font = `bold ${Math.round(10 * dpr)}px sans-serif`;

    for (const entry of skeleton) {
      if (!entry.interactable || !entry.rect) continue;
      const { x, y, width, height } = entry.rect;
      const px = x * dpr;
      const py = y * dpr;
      const pw = width * dpr;
      const ph = height * dpr;

      ctx.fillStyle = "rgba(255, 165, 0, 0.3)";
      ctx.fillRect(px, py, pw, ph);

      ctx.strokeStyle = "rgba(255, 140, 0, 0.8)";
      ctx.lineWidth = 1;
      ctx.strokeRect(px, py, pw, ph);

      ctx.fillStyle = "rgba(255, 165, 0, 0.9)";
      ctx.fillText(`s${entry.scanId}`, px + 2, py + Math.round(11 * dpr));
    }

    const annotatedBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
    const arrayBuffer = await annotatedBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Convert to base64 in chunks to avoid stack overflow on large images
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  } catch (error) {
    console.error("[browserwire] annotateScreenshot failed:", error);
    return null;
  }
};

/**
 * Handle incremental discovery snapshot from content script.
 * Captures and annotates a screenshot, then buffers locally in pendingSnapshots[].
 * Snapshots are only sent to the backend on a CHECKPOINT or STOP event.
 * Runs async — the content script response is sent before this completes.
 */
const handleSnapshot = async (message, sender) => {
  const payload = message.payload || {};

  if (!activeSession || payload.sessionId !== activeSession.sessionId) {
    return;
  }

  activeSession = {
    ...activeSession,
    snapshotCount: activeSession.snapshotCount + 1
  };

  // Capture and annotate screenshot
  let annotatedScreenshot = null;
  try {
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 50 });
    annotatedScreenshot = await annotateScreenshot(
      screenshotDataUrl,
      payload.skeleton || [],
      payload.devicePixelRatio || 1
    );
  } catch (error) {
    addLog(`screenshot capture failed: ${error.message}`);
  }

  // Size guard for network log — truncate response bodies if too large
  if (payload.networkLog) {
    const logStr = JSON.stringify(payload.networkLog);
    if (logStr.length > 200_000) {
      payload.networkLog = payload.networkLog.map(e => ({
        ...e, responseBody: null, bodyTruncated: true
      }));
    }
  }

  // Buffer locally — do NOT forward to backend yet
  pendingSnapshots.push({
    ...payload,
    screenshot: annotatedScreenshot,
    tabId: sender.tab?.id,
    frameId: sender.frameId
  });

  addLog(`snapshot ${activeSession.snapshotCount} buffered (${pendingSnapshots.length} pending): trigger=${payload.trigger?.kind || "unknown"}, skeleton=${(payload.skeleton || []).length}`);
  notifyAllContexts({ event: "buffered", count: pendingSnapshots.length });
  broadcastState();
};


// ─── Action Execution (unchanged) ───────────────────────────────────

/**
 * Execute a function in the active tab via chrome.scripting.executeScript.
 */
const executeInTab = async (tabId, func, args) => {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });

  if (!results || results.length === 0) {
    return { ok: false, error: "ERR_SCRIPT_FAILED", message: "No result from executeScript" };
  }

  return results[0].result;
};

/**
 * Self-contained locator resolver + action executor.
 * Injected directly into the page — no content script dependency.
 */
const PAGE_EXECUTE_ACTION = (payload) => {
  const { strategies, interactionKind, inputs } = payload;

  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const s = window.getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const tryCSS = (v) => { const m = document.querySelectorAll(v); if (m.length === 1) return m[0]; for (const el of m) { if (isVisible(el)) return el; } return null; };

  const tryXPath = (v) => {
    const x = v.startsWith("/body") ? `/html${v}` : v;
    const r = document.evaluate(x, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    if (r.snapshotLength === 1) return r.snapshotItem(0);
    for (let i = 0; i < r.snapshotLength; i++) { const el = r.snapshotItem(i); if (isVisible(el)) return el; }
    return null;
  };

  const tryAttr = (v) => {
    const ci = v.indexOf(":");
    if (ci === -1) return null;
    const a = v.slice(0, ci), av = v.slice(ci + 1);
    try {
      const m = document.querySelectorAll(`[${a}="${CSS.escape(av)}"]`);
      if (m.length === 1) return m[0];
      for (const el of m) { if (isVisible(el)) return el; }
    } catch { /* invalid selector */ }
    return null;
  };

  const tryRoleName = (v) => {
    const match = v.match(/^(\w+)\s+"(.+)"$/);
    if (!match) return null;
    const [, role, name] = match;
    const IMPLICIT = { button:"button",a:"link",nav:"navigation",footer:"contentinfo",header:"banner",main:"main",select:"combobox",textarea:"textbox" };
    let found = null, count = 0;
    for (const el of document.querySelectorAll("*")) {
      const r = el.getAttribute("role") || IMPLICIT[el.tagName.toLowerCase()] || (el.tagName.toLowerCase() === "input" ? "textbox" : null);
      if (r !== role) continue;
      const n = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || el.textContent?.trim().slice(0,100) || "";
      if (n === name) { found = el; count++; if (count > 1) return null; }
    }
    return found;
  };

  const tryText = (v) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode(n) { return (n.textContent||"").trim() === v ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
    const t = w.nextNode(); if (!t) return null; if (w.nextNode()) return null;
    return t.parentElement;
  };

  const sorted = [...(strategies || [])].sort((a, b) => b.confidence - a.confidence);
  let element = null, usedStrategy = null;

  for (const s of sorted) {
    let el = null;
    try {
      if (s.kind === "css" || s.kind === "dom_path") el = tryCSS(s.value);
      else if (s.kind === "xpath") el = tryXPath(s.value);
      else if (s.kind === "attribute") el = tryAttr(s.value);
      else if (s.kind === "role_name") el = tryRoleName(s.value);
      else if (s.kind === "text") el = tryText(s.value);
    } catch { /* skip */ }
    if (el) { element = el; usedStrategy = { kind: s.kind, value: s.value }; break; }
  }

  if (!element) return { ok: false, error: "ERR_TARGET_NOT_FOUND", message: "No locator matched" };

  const kind = (interactionKind || "click").toLowerCase();
  if (kind === "click" || kind === "navigate") {
    element.click();
    return { ok: true, result: { action: "clicked" }, usedStrategy };
  }
  if (kind === "type") {
    const text = inputs?.text || inputs?.value || "";
    element.focus();
    if ("value" in element) element.value = "";
    for (const c of text) {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: c, bubbles: true }));
      if ("value" in element) element.value += c;
      element.dispatchEvent(new InputEvent("input", { data: c, inputType: "insertText", bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key: c, bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, result: { action: "typed", length: text.length }, usedStrategy };
  }
  if (kind === "select") {
    const val = inputs?.value || "";
    if ("value" in element) { element.value = val; element.dispatchEvent(new Event("change", { bubbles: true })); }
    return { ok: true, result: { action: "selected", value: val }, usedStrategy };
  }
  element.click();
  return { ok: true, result: { action: "clicked" }, usedStrategy };
};

/**
 * Self-contained view data extractor. Injected directly into the page.
 * Extracts structured data using CSS selectors — no LLM at runtime.
 */
const PAGE_READ_VIEW = (payload) => {
  const { containerLocator, itemContainer, fields, isList } = payload;

  // ── Locator helpers (same as PAGE_EXECUTE_ACTION) ──

  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const s = window.getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const tryCSS = (v) => { const m = document.querySelectorAll(v); if (m.length === 1) return m[0]; for (const el of m) { if (isVisible(el)) return el; } return null; };

  const tryXPath = (v) => {
    const x = v.startsWith("/body") ? `/html${v}` : v;
    const r = document.evaluate(x, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    if (r.snapshotLength === 1) return r.snapshotItem(0);
    for (let i = 0; i < r.snapshotLength; i++) { const el = r.snapshotItem(i); if (isVisible(el)) return el; }
    return null;
  };

  const tryAttr = (v) => {
    const ci = v.indexOf(":");
    if (ci === -1) return null;
    const a = v.slice(0, ci), av = v.slice(ci + 1);
    try {
      const m = document.querySelectorAll(`[${a}="${CSS.escape(av)}"]`);
      if (m.length === 1) return m[0];
      for (const el of m) { if (isVisible(el)) return el; }
    } catch { /* invalid selector */ }
    return null;
  };

  const tryRoleName = (v) => {
    const match = v.match(/^(\w+)\s+"(.+)"$/);
    if (!match) return null;
    const [, role, name] = match;
    const IMPLICIT = { button:"button",a:"link",nav:"navigation",footer:"contentinfo",header:"banner",main:"main",select:"combobox",textarea:"textbox" };
    let found = null, count = 0;
    for (const el of document.querySelectorAll("*")) {
      const r = el.getAttribute("role") || IMPLICIT[el.tagName.toLowerCase()] || (el.tagName.toLowerCase() === "input" ? "textbox" : null);
      if (r !== role) continue;
      const n = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || el.textContent?.trim().slice(0,100) || "";
      if (n === name) { found = el; count++; if (count > 1) return null; }
    }
    return found;
  };

  const tryText = (v) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode(n) { return (n.textContent||"").trim() === v ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
    const t = w.nextNode(); if (!t) return null; if (w.nextNode()) return null;
    return t.parentElement;
  };

  const tryLocate = (strategies) => {
    if (!strategies || strategies.length === 0) return null;
    const sorted = [...strategies].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    for (const s of sorted) {
      let el = null;
      try {
        if (s.kind === "css" || s.kind === "dom_path") el = tryCSS(s.value);
        else if (s.kind === "xpath") el = tryXPath(s.value);
        else if (s.kind === "attribute") el = tryAttr(s.value);
        else if (s.kind === "role_name") el = tryRoleName(s.value);
        else if (s.kind === "text") el = tryText(s.value);
      } catch { /* skip */ }
      if (el) return el;
    }
    return null;
  };

  // ── Container fallback chain ──

  const CONTAINER_FALLBACKS = [
    "main", "[role='main']", "#main-content", "#content", ".content",
    "#app", "#root", "article", "[role='feed']"
  ];

  let container = tryLocate(containerLocator);
  let containerFallback = null;
  if (!container) {
    for (const sel of CONTAINER_FALLBACKS) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) { container = el; containerFallback = sel; break; }
      } catch { /* skip */ }
    }
    if (!container) {
      container = document.body;
      containerFallback = "document.body";
    }
    console.warn(`[browserwire] read_view container fallback used: ${containerFallback}`);
  }

  // ── Field extraction with text fallback ──

  const coerceValue = (raw, type) => {
    if (!raw) return null;
    if (type === "number") return Number(raw) || null;
    if (type === "boolean") return raw === "true" || raw === "yes";
    return raw || null;
  };

  // Shadow-DOM-aware query helpers
  const qsDeep = (root, sel) => {
    try { return root.querySelector(sel) || root.shadowRoot?.querySelector(sel) || null; }
    catch { return null; }
  };

  const qsaDeep = (root, sel) => {
    try {
      const light = root.querySelectorAll(sel);
      if (light.length > 0) return light;
      return root.shadowRoot?.querySelectorAll(sel) || [];
    } catch { return []; }
  };

  const extractField = (root, field) => {
    if (!field || !field.locator) return null;
    const selector = field.locator.value;

    // 0. Attribute extraction (when field specifies an attribute to extract)
    if (field.locator.attribute) {
      let el = qsDeep(root, selector);
      // Self-match: if root IS the target (e.g., item=shreddit-post, selector=shreddit-post)
      if (!el) try { if (root.matches?.(selector)) el = root; } catch {}
      if (el) {
        const val = el.getAttribute(field.locator.attribute);
        if (val != null) return coerceValue(val.trim(), field.type);
      }
      return null;  // Don't fall through — attribute fields never use textContent
    }

    // 1. Direct CSS selector
    try {
      const el = qsDeep(root, selector);
      if (el) return coerceValue((el.textContent || "").trim(), field.type);
    } catch { /* invalid selector */ }

    // 2. Self-referencing rewrite: if selector starts with a class the root has,
    //    rewrite to :scope > rest  (e.g. ".card > .title" when root IS .card)
    try {
      const leadClassMatch = selector.match(/^(\.[a-zA-Z0-9_-]+)\s*>\s*(.+)$/);
      if (leadClassMatch) {
        const [, leadClass, rest] = leadClassMatch;
        if (root.matches && root.matches(leadClass)) {
          // Try :scope > rest
          const scopeEl = qsDeep(root, `:scope > ${rest}`);
          if (scopeEl) return coerceValue((scopeEl.textContent || "").trim(), field.type);
          // Try just the structural part
          const restEl = qsDeep(root, rest);
          if (restEl) return coerceValue((restEl.textContent || "").trim(), field.type);
        }
      }
    } catch { /* skip */ }

    // 3. aria-label extraction for title/name fields
    //    Last-resort: only for fields whose name suggests a title/name
    try {
      if (/title|name/i.test(field.name)) {
        for (const tag of ["a", "button"]) {
          const els = qsaDeep(root, `${tag}[aria-label]`);
          for (const el of els) {
            const label = (el.getAttribute("aria-label") || "").trim();
            if (label.length > 3) return coerceValue(label, field.type);
          }
        }
      }
    } catch { /* skip */ }

    // 4. Semantic class matching: fuzzy last-resort — match field name parts
    //    against class names of *direct children only* to limit false positives
    try {
      const nameParts = field.name.split("_").filter(p => p.length > 2);
      for (const part of nameParts) {
        const matches = qsaDeep(root, `:scope > [class*="${part}"], :scope > * > [class*="${part}"]`);
        for (const el of matches) {
          if (el !== root) {
            const raw = (el.textContent || "").trim();
            if (raw.length > 1) return coerceValue(raw, field.type);
          }
        }
      }
    } catch { /* skip */ }

    return null;
  };

  /**
   * Text-block fallback: extract the N most distinct text blocks from an element,
   * mapping them positionally to the N field names.
   * Filters out zero-width chars and single-char noise.
   */
  const ZERO_WIDTH_RE = /[\u200B\u00A0\uFEFF]/g;
  const extractFieldsByTextBlocks = (root, fieldDefs) => {
    if (!fieldDefs || fieldDefs.length === 0) return {};
    const blocks = [];
    const walkRoot = (r) => {
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const t = (n.textContent || "").replace(ZERO_WIDTH_RE, "").trim();
          return t.length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      let node;
      while ((node = walker.nextNode()) && blocks.length < fieldDefs.length + 10) {
        const text = (node.textContent || "").replace(ZERO_WIDTH_RE, "").trim();
        if (text.length > 1 && !blocks.includes(text)) blocks.push(text);
      }
    };
    walkRoot(root);
    // Pierce shadow DOM if light DOM yielded nothing
    if (blocks.length === 0 && root.shadowRoot) walkRoot(root.shadowRoot);
    const row = {};
    for (let i = 0; i < fieldDefs.length; i++) {
      row[fieldDefs[i].name] = i < blocks.length ? blocks[i] : null;
    }
    return row;
  };

  if (isList) {
    // List view: find all items, extract fields per item
    let items;

    // Try itemContainer if provided
    if (itemContainer) {
      try {
        const selector = itemContainer.value || itemContainer;
        items = container.querySelectorAll(typeof selector === "string" ? selector : selector.value);
      } catch { /* invalid selector — fall through to fallbacks */ }

      // Try container's shadow root
      if ((!items || items.length === 0) && container.shadowRoot) {
        try {
          const sel = itemContainer.value || itemContainer;
          items = container.shadowRoot.querySelectorAll(typeof sel === "string" ? sel : sel.value);
        } catch {}
      }

      // If no items found with the item selector, try document-wide before generic fallbacks
      if (!items || items.length === 0) {
        try {
          const selector = itemContainer.value || itemContainer;
          const sel = typeof selector === "string" ? selector : selector.value;
          const docItems = document.querySelectorAll(sel);
          if (docItems.length > 0) {
            items = docItems;
            console.warn(`[browserwire] read_view items found document-wide: ${sel} (${docItems.length} items)`);
          }
        } catch { /* skip */ }
      }
    }

    // If still no items, try common list patterns within container
    if (!items || items.length === 0) {
      const LIST_ITEM_FALLBACKS = ["li", "[role='listitem']", "[role='row']", "tr", "article", ":scope > div"];
      for (const sel of LIST_ITEM_FALLBACKS) {
        try {
          const candidates = container.querySelectorAll(sel);
          if (candidates.length > 0) { items = candidates; console.warn(`[browserwire] read_view item fallback used: ${sel}`); break; }
        } catch { /* skip */ }
      }
    }

    if (!items || items.length === 0) {
      return { ok: true, result: [], count: 0, _note: "no items found" };
    }

    const fieldDefs = fields || [];
    const result = [];
    let allNull = true;
    const seenAncestors = new Set();

    for (const item of items) {
      const row = {};
      let extractionRoot = item;
      for (const field of fieldDefs) {
        row[field.name] = extractField(item, field);
      }

      // If all fields null, item may be an overlay/link — escalate to card-like ancestor
      if (!Object.values(row).some(v => v !== null)) {
        const CARD_ANCESTORS = '[role="button"], [role="listitem"], [class*="card"], article, li';
        const ancestor = (item.closest && item.closest(CARD_ANCESTORS)) || item.parentElement;
        if (ancestor && ancestor !== item && ancestor !== document.body) {
          // Deduplicate: skip if we already extracted from this ancestor
          if (seenAncestors.has(ancestor)) continue;
          seenAncestors.add(ancestor);
          extractionRoot = ancestor;
          for (const field of fieldDefs) {
            row[field.name] = extractField(ancestor, field);
          }
          console.warn(`[browserwire] read_view: escalated item to ancestor <${ancestor.tagName.toLowerCase()}>`);
        }
      }

      // Check if any field was extracted
      const hasValue = Object.values(row).some(v => v !== null);
      if (!hasValue) {
        // Text-block fallback using best extraction root
        const textRow = extractFieldsByTextBlocks(extractionRoot, fieldDefs);
        for (const key of Object.keys(textRow)) row[key] = textRow[key];
      }
      if (Object.values(row).some(v => v !== null)) allNull = false;
      result.push(row);
    }

    // Last resort: if ALL rows are still entirely null, add _raw_text per item
    if (allNull && result.length > 0) {
      for (let i = 0; i < result.length; i++) {
        const root = items[i];
        const CARD_ANCESTORS = '[role="button"], [role="listitem"], [class*="card"], article, li';
        const best = (root.closest && root.closest(CARD_ANCESTORS)) || root;
        result[i]._raw_text = (best.textContent || "").trim().slice(0, 500);
      }
      console.warn("[browserwire] read_view: all fields null, falling back to _raw_text");
    }

    return { ok: true, result, count: result.length, ...(containerFallback ? { containerFallback } : {}) };
  } else {
    // Single/detail view: extract fields from container directly
    const fieldDefs = fields || [];
    const row = {};
    for (const field of fieldDefs) {
      row[field.name] = extractField(container, field);
    }
    // Text-block fallback if all fields are null
    if (Object.values(row).every(v => v === null) && fieldDefs.length > 0) {
      const textRow = extractFieldsByTextBlocks(container, fieldDefs);
      for (const key of Object.keys(textRow)) row[key] = textRow[key];
    }
    return { ok: true, result: row, ...(containerFallback ? { containerFallback } : {}) };
  }
};

// ─── Workflow Execution ─────────────────────────────────────────────

/**
 * Navigate a tab to a URL and wait for the page to finish loading.
 * Resolves relative URLs against baseOrigin.
 */
const navigateTabAndWait = async (tabId, url, baseOrigin, timeoutMs = PAGE_READY_TIMEOUT_MS) => {
  const fullUrl = url.startsWith("http") ? url : `${baseOrigin}${url}`;
  await chrome.tabs.update(tabId, { url: fullUrl });

  const settle = await waitForPageSettle(tabId, {
    timeoutMs,
    expectNavigation: true,
    context: `navigate:${fullUrl}`
  });

  if (!settle.settled) {
    throw new Error(`Navigation to ${fullUrl} did not settle (${settle.reason || "timeout"})`);
  }
};

/**
 * Self-contained outcome evaluator. Injected into the page after workflow steps complete.
 * Checks outcome signals and returns { outcome: "success" | "failure" | "unknown" }.
 */
const PAGE_EVALUATE_OUTCOME = (payload) => {
  const { outcomes } = payload;
  if (!outcomes) return { outcome: "unknown" };

  const check = (signal) => {
    if (!signal || !signal.kind || !signal.value) return false;
    try {
      if (signal.kind === "url_change") {
        return new RegExp(signal.value).test(window.location.pathname + window.location.search);
      }
      if (signal.kind === "element_appears") {
        return document.querySelector(signal.value) !== null;
      }
      if (signal.kind === "element_disappears") {
        return document.querySelector(signal.value) === null;
      }
      if (signal.kind === "text_contains") {
        const el = signal.selector ? document.querySelector(signal.selector) : document.body;
        if (!el) return false;
        return new RegExp(signal.value, "i").test(el.textContent || "");
      }
    } catch { /* invalid regex or selector */ }
    return false;
  };

  if (outcomes.success && check(outcomes.success)) return { outcome: "success" };
  if (outcomes.failure && check(outcomes.failure)) return { outcome: "failure" };
  return { outcome: "unknown" };
};

/**
 * Poll/retry for read_view data — handles async-loading DOM and delayed data.
 * Retries on hard errors (container not found) and empty results.
 */
const pollReadView = async (tabId, viewConfig, { timeoutMs = 20000, readyQuietMs = 500 } = {}) => {
  const start = Date.now();
  let lastActivityTime = start;
  let stableNonEmptyReads = 0;
  let lastNonEmptySignature = null;

  while (Date.now() - start < timeoutMs) {
    // Wait for DOM to be briefly quiet before reading
    const domResult = await executeInTab(tabId, PAGE_WAIT_FOR_DOM_IDLE, [{
      idleMs: 300,
      timeoutMs: 3000,
      requireReadyStateComplete: true
    }]);
    const result = await executeInTab(tabId, PAGE_READ_VIEW, [viewConfig]);

    if (!result || result.ok === false) {
      stableNonEmptyReads = 0;
      lastNonEmptySignature = null;
      lastActivityTime = Date.now();
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    const isEmpty = viewConfig.isList
      ? (Array.isArray(result.result) && result.result.length === 0)
      : (result.result && Object.values(result.result).every(v => v === null));
    const pending = getPendingSnapshot(tabId);
    const domActive = !domResult?.domIdle;

    if (!isEmpty) {
      if (pending.blocking === 0 && !domActive) {
        const signature = JSON.stringify(result.result).slice(0, 2000);
        if (signature === lastNonEmptySignature) {
          stableNonEmptyReads += 1;
        } else {
          stableNonEmptyReads = 1;
          lastNonEmptySignature = signature;
        }

        if (stableNonEmptyReads >= 2) {
          return result;
        }
      } else {
        stableNonEmptyReads = 0;
        lastNonEmptySignature = null;
        lastActivityTime = Date.now();
      }

      await new Promise(r => setTimeout(r, 200));
      continue;
    }

    stableNonEmptyReads = 0;
    lastNonEmptySignature = null;

    // Empty result — check for activity signals
    if (pending.blocking > 0 || domActive) {
      lastActivityTime = Date.now();
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    // Everything quiet — but has it been quiet long enough?
    const quietDuration = Date.now() - lastActivityTime;
    if (quietDuration < readyQuietMs || (Date.now() - start) < 3000) {
      await new Promise(r => setTimeout(r, 200));
      continue;
    }

    // Truly quiet + empty after reasonable wait → accept as real
    return result;
  }

  return await executeInTab(tabId, PAGE_READ_VIEW, [viewConfig]);
};

// Page-injected: watches DOM mutations only.
// Network idle is tracked separately in the background via chrome.webRequest.
const PAGE_WAIT_FOR_DOM_IDLE = (opts) => {
  const {
    idleMs = 500,
    timeoutMs = 10000,
    requireReadyStateComplete = true
  } = opts || {};

  return new Promise((resolve) => {
    const target = document.body || document.documentElement;
    if (!target) {
      resolve({ domIdle: false, elapsed: 0, reason: "no_dom_root", readyState: document.readyState });
      return;
    }

    const start = Date.now();
    let lastActivity = start;

    const observer = new MutationObserver(() => {
      lastActivity = Date.now();
    });

    observer.observe(target, {
      childList: true, subtree: true, attributes: true, characterData: true
    });

    const finish = (domIdle, reason) => {
      observer.disconnect();
      resolve({
        domIdle,
        elapsed: Date.now() - start,
        reason,
        readyState: document.readyState
      });
    };

    const flushPaint = (cb) => {
      if (typeof requestAnimationFrame !== "function") {
        setTimeout(cb, 0);
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(cb));
    };

    const check = () => {
      const now = Date.now();
      const elapsed = now - start;

      if (elapsed >= timeoutMs) {
        finish(false, "timeout");
        return;
      }

      if (requireReadyStateComplete && document.readyState !== "complete") {
        setTimeout(check, 100);
        return;
      }

      if (now - lastActivity >= idleMs) {
        flushPaint(() => finish(true, "idle"));
        return;
      }

      setTimeout(check, 100);
    };

    // Small initial delay to let the action's immediate effects begin
    setTimeout(check, 100);
  });
};

const waitForNavigation = async (
  tabId,
  {
    timeoutMs = PAGE_READY_TIMEOUT_MS,
    observeWindowMs = NAVIGATION_OBSERVE_WINDOW_MS,
    expectNavigation = false
  } = {}
) => {
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!currentTab) {
    return { ok: false, navigated: false, complete: false, reason: "tab_not_found" };
  }

  const initialUrl = currentTab.url || "";
  let sawLoading = currentTab.status === "loading";
  let sawComplete = currentTab.status === "complete";

  return await new Promise((resolve) => {
    let done = false;
    let observeTimer = null;
    let navigationTimer = null;

    const cleanup = () => {
      if (observeTimer) {
        clearTimeout(observeTimer);
        observeTimer = null;
      }
      if (navigationTimer) {
        clearTimeout(navigationTimer);
        navigationTimer = null;
      }
      chrome.tabs.onUpdated.removeListener(listener);
    };

    const finish = (result) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    const startNavigationTimer = () => {
      if (navigationTimer) return;
      navigationTimer = setTimeout(() => {
        finish({
          ok: false,
          navigated: true,
          complete: sawComplete,
          reason: "navigation_timeout"
        });
      }, timeoutMs);
    };

    const listener = (id, info) => {
      if (id !== tabId) return;

      if (info.status === "loading") {
        sawLoading = true;
        startNavigationTimer();
      }

      if (info.status === "complete") {
        sawComplete = true;
        if (sawLoading) {
          finish({ ok: true, navigated: true, complete: true, reason: "complete" });
        }
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    const pollStatus = async () => {
      if (done) return;
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) {
        finish({ ok: false, navigated: sawLoading, complete: false, reason: "tab_not_found" });
        return;
      }

      if (tab.status === "loading") {
        sawLoading = true;
        startNavigationTimer();
      }

      if (tab.status === "complete") {
        sawComplete = true;
        if (sawLoading) {
          finish({ ok: true, navigated: true, complete: true, reason: "complete" });
          return;
        }
      }

      setTimeout(pollStatus, 100);
    };
    setTimeout(pollStatus, 100);

    if (sawLoading) {
      startNavigationTimer();
      return;
    }

    observeTimer = setTimeout(async () => {
      if (sawLoading) {
        startNavigationTimer();
        return;
      }

      const latestTab = await chrome.tabs.get(tabId).catch(() => null);
      const latestUrl = latestTab?.url || "";
      const latestComplete = latestTab?.status === "complete" || sawComplete;
      const urlChanged = latestUrl !== "" && latestUrl !== initialUrl;

      if (latestTab?.status === "loading") {
        sawLoading = true;
        startNavigationTimer();
        return;
      }

      if (expectNavigation && urlChanged && latestComplete) {
        finish({ ok: true, navigated: true, complete: true, reason: "url_changed" });
        return;
      }

      if (expectNavigation) {
        finish({ ok: false, navigated: false, complete: sawComplete, reason: "navigation_not_detected" });
      } else {
        finish({ ok: true, navigated: false, complete: sawComplete, reason: "no_navigation_detected" });
      }
    }, observeWindowMs);
  });
};

/**
 * Wait for the page to fully settle after an interaction.
 * Combines waitForNavigation (full page loads) with DOM idle + network quiescence
 * checks (SPA transitions that don't trigger tab status changes).
 */
const waitForPageSettle = async (
  tabId,
  {
    timeoutMs = PAGE_READY_TIMEOUT_MS,
    expectNavigation = false,
    context = "default"
  } = {}
) => {
  const start = Date.now();

  // 1) Catch both immediate and slightly delayed navigations.
  const navigation = await waitForNavigation(tabId, {
    timeoutMs,
    observeWindowMs: NAVIGATION_OBSERVE_WINDOW_MS,
    expectNavigation
  });

  if (!navigation.ok) {
    return {
      settled: false,
      reason: navigation.reason || "navigation_failed",
      elapsedMs: Date.now() - start,
      navigation,
      pending: getPendingSnapshot(tabId)
    };
  }

  // 2) Require both DOM quietness and blocking-network quietness.
  let quietStart = null;
  let lastDomResult = null;
  let lastPending = getPendingSnapshot(tabId);

  while (Date.now() - start < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - start);
    const domProbeTimeout = Math.max(500, Math.min(DOM_IDLE_PROBE_TIMEOUT_MS, remaining));

    let domResult;
    try {
      domResult = await executeInTab(tabId, PAGE_WAIT_FOR_DOM_IDLE, [{
        idleMs: DOM_IDLE_MS,
        timeoutMs: domProbeTimeout,
        requireReadyStateComplete: true
      }]);
    } catch (error) {
      return {
        settled: false,
        reason: "dom_probe_failed",
        elapsedMs: Date.now() - start,
        navigation,
        pending: getPendingSnapshot(tabId),
        error: error instanceof Error ? error.message : "dom_probe_failed"
      };
    }

    lastDomResult = domResult;
    lastPending = getPendingSnapshot(tabId);

    const domIdle = Boolean(domResult?.domIdle);
    const networkIdle = lastPending.blocking === 0;

    if (domIdle && networkIdle) {
      const now = Date.now();
      if (quietStart === null) {
        quietStart = now;
      }
      if (now - quietStart >= NETWORK_QUIET_MS) {
        return {
          settled: true,
          reason: "settled",
          elapsedMs: now - start,
          navigation,
          dom: domResult,
          pending: lastPending
        };
      }
    } else {
      quietStart = null;
    }

    await new Promise(r => setTimeout(r, SETTLE_POLL_INTERVAL_MS));
  }

  addLog(
    `[settle-timeout] tab=${tabId} ctx=${context} nav=${navigation.reason || "unknown"} dom=${lastDomResult?.reason || "unknown"} pendingBlocking=${lastPending.blocking} pendingTotal=${lastPending.total}`
  );

  return {
    settled: false,
    reason: "timeout",
    elapsedMs: Date.now() - start,
    navigation,
    dom: lastDomResult,
    pending: lastPending
  };
};

/**
 * Walk a dot-notation JSON path (e.g. "user.name", "activities[0].state") into an object.
 */
const getByJsonPath = (obj, path) => {
  if (obj == null || !path) return undefined;
  const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = obj;
  for (const seg of segments) {
    if (current == null) return undefined;
    current = current[seg];
  }
  return current;
};

/**
 * Extract specific fields from API response data using apiFields mapping.
 * For arrays, extracts the fields from each element.
 */
const extractApiFields = (data, apiFields) => {
  if (!apiFields || typeof apiFields !== 'object') return data;

  const extractOne = (item) => {
    const row = {};
    for (const [fieldName, jsonPath] of Object.entries(apiFields)) {
      const val = getByJsonPath(item, jsonPath);
      if (val !== undefined) row[fieldName] = val;
    }
    return row;
  };

  if (Array.isArray(data)) return data.map(extractOne);
  return extractOne(data);
};

/**
 * Clears the in-page network capture buffer.
 */
const clearNetworkLog = async (tabId) => {
  try {
    await chrome.tabs.sendMessage(tabId, {
      source: "background",
      command: "clear_network_log"
    });
  } catch {
    // no-op (content script unavailable or tab navigated)
  }
};

/**
 * Read API data from the content script's network log, matching by request signature.
 * If apiFields is provided, extracts only the mapped fields from the response.
 */
const readNetworkData = async (tabId, apiRequest, apiFields, { sinceTs = null } = {}) => {
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      source: "background",
      command: "get_network_log",
      apiRequest,
      sinceTs
    });

    if (result?.ok && result.entries?.length > 0) {
      const entriesWithBodies = result.entries.filter((e) => e?.responseBody != null);
      if (entriesWithBodies.length === 0) return null;

      entriesWithBodies.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      const newestTs = entriesWithBodies[0].timestamp || 0;
      const freshnessWindowMs = 1500;
      const freshEntries = entriesWithBodies.filter((e) => {
        const ts = e.timestamp || 0;
        return newestTs - ts <= freshnessWindowMs;
      });

      const bodies = freshEntries.map(e => e.responseBody).filter(Boolean);
      if (bodies.length === 0) return null;

      let data;
      if (bodies.length === 1) data = bodies[0];
      else if (Array.isArray(bodies[0])) data = bodies.flat();
      else data = bodies;

      if (apiFields) return extractApiFields(data, apiFields);
      return data;
    }
  } catch {}
  return null;
};

/**
 * Execute a multi-step workflow in a given tab.
 * Returns { ok, data?, outcome?, error?, message? } directly.
 */
const runWorkflowSteps = async (tabId, baseOrigin, steps, outcomes, inputs) => {
  let lastReadData = null;
  let hasReadView = false;
  let networkScopeStartTs = 0;

  const readinessError = (stepType, phase, settle) => ({
    ok: false,
    error: "ERR_PAGE_NOT_READY",
    message: `Page did not settle ${phase} ${stepType} step`,
    details: settle
  });

  for (const step of (steps || [])) {
    try {
      const shouldWaitBefore = ["read_view", "fill", "select", "click", "submit"].includes(step.type);
      if (shouldWaitBefore) {
        const preStepSettle = await waitForPageSettle(tabId, {
          timeoutMs: PAGE_READY_TIMEOUT_MS,
          context: `before:${step.type}`
        });
        if (!preStepSettle.settled) {
          return readinessError(step.type, "before", preStepSettle);
        }
      }

      if (step.type === "navigate") {
        // Replace :param placeholders with input values
        const url = step.url.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, param) => {
          const value = inputs?.[param];
          return value != null ? encodeURIComponent(value) : match;
        });

        networkScopeStartTs = Date.now();
        await clearNetworkLog(tabId);
        await navigateTabAndWait(tabId, url, baseOrigin, PAGE_READY_TIMEOUT_MS);
        continue;
      }

      if (step.type === "read_view") {
        hasReadView = true;

        // Try network-first if apiRequest signature is available
        if (step.viewConfig?.apiRequest) {
          const apiData = await readNetworkData(
            tabId,
            step.viewConfig.apiRequest,
            step.viewConfig.apiFields,
            { sinceTs: networkScopeStartTs }
          );

          if (apiData != null) {
            // Quality gate: check that the data has substance
            const hasSubstance = Array.isArray(apiData)
              ? apiData.length > 0 && apiData.some(row => Object.values(row).some(v => v != null && v !== ''))
              : Object.values(apiData).some(v => v != null && v !== '');
            if (hasSubstance) {
              console.log("[browserwire] read_view: got data from network API");
              lastReadData = apiData;
              continue;
            }
            console.log("[browserwire] read_view: network API data empty, falling back to DOM");
          }
          console.log("[browserwire] read_view: no network match, falling back to DOM");
        }

        // DOM fallback (existing logic)
        const viewConfig = {
          containerLocator: step.viewConfig?.containerLocator || [],
          itemContainer: step.viewConfig?.itemContainer || null,
          fields: step.viewConfig?.fields || [],
          isList: step.viewConfig?.isList || false
        };
        console.log("[browserwire] read_view step:", JSON.stringify(viewConfig).slice(0, 300));
        const result = await pollReadView(tabId, viewConfig);
        console.log("[browserwire] read_view result:", JSON.stringify(result).slice(0, 300));
        if (!result || result.ok === false) {
          return {
            ok: false,
            error: result?.error || "ERR_READ_VIEW_FAILED",
            message: result?.message || "read_view step failed"
          };
        }
        lastReadData = result.result;
        continue;
      }

      if (["fill", "select", "click", "submit"].includes(step.type)) {
        const interactionKind = step.type === "fill" ? "type"
          : step.type === "submit" ? "click"
          : step.type;
        const inputValue = step.inputParam ? (inputs || {})[step.inputParam] : undefined;
        const stepInputs = inputValue !== undefined
          ? { text: inputValue, value: inputValue }
          : {};

        networkScopeStartTs = Date.now();
        await clearNetworkLog(tabId);

        const result = await executeInTab(tabId, PAGE_EXECUTE_ACTION, [{
          strategies: step.strategies || [],
          interactionKind,
          inputs: stepInputs
        }]);

        if (!result || result.ok === false) {
          return {
            ok: false,
            error: result?.error || "ERR_STEP_FAILED",
            message: result?.message || `${step.type} step failed`
          };
        }

        const postStepSettle = await waitForPageSettle(tabId, {
          timeoutMs: PAGE_READY_TIMEOUT_MS,
          context: `after:${step.type}`
        });
        if (!postStepSettle.settled) {
          return readinessError(step.type, "after", postStepSettle);
        }

        continue;
      }
    } catch (error) {
      return {
        ok: false,
        error: "ERR_WORKFLOW_STEP_FAILED",
        message: error instanceof Error ? error.message : `Step ${step.type} threw an error`
      };
    }
  }

  // All steps succeeded
  if (hasReadView) {
    return { ok: true, data: lastReadData };
  }

  // Write workflow: wait for page to settle then evaluate outcomes
  const finalSettle = await waitForPageSettle(tabId, {
    timeoutMs: PAGE_READY_TIMEOUT_MS,
    context: "final_outcome"
  });
  if (!finalSettle.settled) {
    return {
      ok: false,
      error: "ERR_PAGE_NOT_READY",
      message: "Page did not settle before outcome evaluation",
      details: finalSettle
    };
  }

  try {
    const evalResult = await executeInTab(tabId, PAGE_EVALUATE_OUTCOME, [{ outcomes }]);
    return { ok: true, outcome: evalResult?.outcome || "unknown" };
  } catch (error) {
    return { ok: true, outcome: "unknown" };
  }
};

/**
 * Handle EXECUTE_WORKFLOW from the WS server.
 */
const handleExecuteWorkflow = async (message) => {
  const { steps, outcomes, inputs, origin } = message.payload || {};
  const requestId = message.requestId;

  // Create a dedicated minimized window for this workflow
  const win = await chrome.windows.create({ url: "about:blank", focused: false, state: "minimized" });
  const tab = win.tabs[0];

  try {
    // Navigate to the site origin so content scripts can run on the right domain
    const firstStepIsNav = steps?.length > 0 && steps[0].type === "navigate";
    if (origin && !firstStepIsNav) {
      await navigateTabAndWait(tab.id, origin, "");
    }

    const baseOrigin = origin || "";
    const result = await runWorkflowSteps(tab.id, baseOrigin, steps, outcomes, inputs);
    sendToBackend(MessageType.WORKFLOW_RESULT, result, requestId);
  } catch (error) {
    sendToBackend(MessageType.WORKFLOW_RESULT, {
      ok: false, error: "ERR_WORKFLOW_FAILED", message: error.message || "Workflow execution failed"
    }, requestId);
  } finally {
    // Always clean up the window
    try { await chrome.windows.remove(win.id); } catch { /* already closed */ }
  }
};


// ─── Sidepanel Command Handler ──────────────────────────────────────

const handleSidepanelCommand = async (message) => {
  if (message.command === "sidepanel_opened") {
    // Auto-connect if not already connected and haven't given up
    if (!socket && !shouldReconnect && !autoConnectGaveUp) {
      return connectBackend();
    }
    return { ok: true, state: getState() };
  }

  if (message.command === "get_state") {
    return { ok: true, state: getState() };
  }

  if (message.command === "connect_backend") {
    return connectBackend(message.url);
  }

  if (message.command === "disconnect_backend") {
    disconnectBackend();
    return { ok: true, state: getState() };
  }

  if (message.command === "start_exploring") {
    return startExploring();
  }

  if (message.command === "stop_exploring") {
    return stopExploring(message.note);
  }

  return {
    ok: false,
    error: "unsupported_command",
    state: getState()
  };
};

// ─── Message Router ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.source === "background") {
    return false;
  }

  // Content script sends buffered snapshots.
  // Respond immediately; screenshot capture runs async.
  if (message.source === "content" && message.type === "snapshot") {
    sendResponse({ ok: true });
    handleSnapshot(message, sender).catch((error) => {
      addLog(`incremental handler error: ${error.message}`);
    });
    return false;
  }

  if (message.source === "sidepanel") {
    handleSidepanelCommand(message)
      .then((response) => {
        sendResponse(response);
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "background_command_failed",
          state: getState()
        });
      });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!activeSession || activeSession.tabId !== tabId) {
    return;
  }

  const session = activeSession;
  const remainingSnapshots = pendingSnapshots.slice();
  const batchId = crypto.randomUUID();
  activeSession = null;
  pendingSnapshots = [];

  processingBatches.set(batchId, {
    sessionId: session.sessionId,
    status: "sent",
    snapshotCount: remainingSnapshots.length,
    startedAt: Date.now()
  });

  sendToBackend(MessageType.DISCOVERY_SESSION_STOP, {
    sessionId: session.sessionId,
    batchId,
    reason: "tab_closed",
    stoppedAt: new Date().toISOString(),
    pendingSnapshots: remainingSnapshots
  });

  addLog(`exploration stopped because tab ${tabId} closed (batch ${batchId.slice(0, 8)}…)`);
  broadcastState();
});

const enableActionSidePanel = () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
};

chrome.runtime.onInstalled.addListener(() => {
  enableActionSidePanel();
  addLog("extension installed");
  broadcastState();
});

chrome.runtime.onStartup.addListener(() => {
  enableActionSidePanel();
  addLog("extension started");
  broadcastState();
});

// Auto-connect on service worker load
if (!socket && !shouldReconnect && !autoConnectGaveUp) {
  connectBackend();
}
