/**
 * workflow-executor.js — Execute workflows directly in Electron.
 *
 * Two modes:
 *   - executeWorkflowSteps(wc, payload) — run steps in any webContents (e.g. main BrowserView)
 *   - executeWorkflow(payload) — create a hidden window, run steps, destroy window (for REST API)
 */

import { BrowserWindow } from "electron";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PAGE_READY_TIMEOUT_MS = 20000;
const SETTLE_POLL_INTERVAL_MS = 150;
const DOM_IDLE_MS = 600;

// ─── Page executor functions (pre-extracted, no runtime parsing) ─────

let _pageExecutorSource = null;

const loadPageExecutorSource = async () => {
  if (!_pageExecutorSource) {
    _pageExecutorSource = await readFile(
      resolve(__dirname, "../vendor/page-executor.js"),
      "utf-8"
    );
  }
  return _pageExecutorSource;
};

// ─── Page helpers ────────────────────────────────────────────────────

const waitForPageSettle = async (webContents, { timeoutMs = PAGE_READY_TIMEOUT_MS } = {}) => {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (webContents.isDestroyed()) return { settled: false, reason: "destroyed" };

    const isLoading = webContents.isLoading();
    if (!isLoading) {
      const domStable = await webContents.executeJavaScript(`
        (function() {
          return new Promise((resolve) => {
            let timer = null;
            const obs = new MutationObserver(() => {
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => { obs.disconnect(); resolve(true); }, ${DOM_IDLE_MS});
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
            timer = setTimeout(() => { obs.disconnect(); resolve(true); }, ${DOM_IDLE_MS});
          });
        })()
      `).catch(() => true);

      if (domStable) return { settled: true };
    }

    await new Promise((r) => setTimeout(r, SETTLE_POLL_INTERVAL_MS));
  }

  return { settled: false, reason: "timeout" };
};

const navigateAndWait = (webContents, url, timeoutMs = PAGE_READY_TIMEOUT_MS) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Navigation to ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    webContents.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });

    webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
      clearTimeout(timer);
      if (errorCode === -3) {
        resolve(); // -3 = aborted (redirect) — not a real error
      } else {
        reject(new Error(`Navigation failed: ${errorDescription} (${errorCode})`));
      }
    });

    webContents.loadURL(url).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
};

/**
 * Resolve a step URL against the origin.
 * Workflow steps often have relative paths like "/" or "/search/:query".
 */
const resolveUrl = (stepUrl, origin, inputs) => {
  // Substitute :params with input values
  let url = stepUrl.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, param) => {
    const value = inputs?.[param];
    return value != null ? encodeURIComponent(value) : match;
  });

  // Prepend origin for relative paths
  if (url.startsWith("/") && origin) {
    url = origin.replace(/\/$/, "") + url;
  }

  return url;
};

// ─── Step execution ──────────────────────────────────────────────────

/**
 * Execute workflow steps in an existing webContents.
 * Can be used with the main BrowserView (visible) or a hidden window.
 *
 * @param {Electron.WebContents} wc
 * @param {{ steps: Array, outcomes: object, inputs: object, origin: string }} payload
 * @returns {Promise<object>}
 */
export const executeWorkflowSteps = async (wc, { steps, outcomes, inputs, origin }) => {
  // page-executor.js contains PAGE_EXECUTE_ACTION, PAGE_READ_VIEW, PAGE_EVALUATE_OUTCOME
  // as top-level const declarations. We inject the whole file before calling them.
  const executorSource = await loadPageExecutorSource();

  // Navigate to origin if first step isn't navigate
  const firstStepIsNav = steps?.length > 0 && steps[0].type === "navigate";
  if (origin && !firstStepIsNav) {
    await navigateAndWait(wc, origin);
    await waitForPageSettle(wc);
  }

  let lastReadData = null;
  let hasReadView = false;

  for (const step of steps || []) {
    const shouldWaitBefore = ["read_view", "fill", "select", "click", "submit"].includes(step.type);
    if (shouldWaitBefore) {
      const preSettle = await waitForPageSettle(wc);
      if (!preSettle.settled) {
        return { ok: false, error: "ERR_PAGE_NOT_READY", message: `Page did not settle before ${step.type}` };
      }
    }

    if (step.type === "navigate") {
      const url = resolveUrl(step.url, origin, inputs);
      await navigateAndWait(wc, url);
      continue;
    }

    if (step.type === "read_view") {
      hasReadView = true;

      const viewConfig = {
        containerLocator: step.viewConfig?.containerLocator || [],
        itemContainer: step.viewConfig?.itemContainer || null,
        fields: step.viewConfig?.fields || [],
        isList: step.viewConfig?.isList || false,
      };

      const result = await wc.executeJavaScript(`
        ${executorSource}
        PAGE_READ_VIEW(${JSON.stringify(viewConfig)});
      `);

      if (!result || result.ok === false) {
        return {
          ok: false,
          error: result?.error || "ERR_READ_VIEW_FAILED",
          message: result?.message || "read_view step failed",
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

      const result = await wc.executeJavaScript(`
        ${executorSource}
        PAGE_EXECUTE_ACTION(${JSON.stringify({
          strategies: step.strategies || [],
          interactionKind,
          inputs: stepInputs,
        })});
      `);

      if (!result || result.ok === false) {
        return {
          ok: false,
          error: result?.error || "ERR_STEP_FAILED",
          message: result?.message || `${step.type} step failed`,
        };
      }

      await waitForPageSettle(wc);
      continue;
    }
  }

  // All steps succeeded
  if (hasReadView) {
    return { ok: true, data: lastReadData };
  }

  // Write workflow — evaluate outcomes
  await waitForPageSettle(wc);

  if (outcomes) {
    try {
      const evalResult = await wc.executeJavaScript(`
        ${executorSource}
        PAGE_EVALUATE_OUTCOME(${JSON.stringify({ outcomes })});
      `);
      return { ok: true, outcome: evalResult?.outcome || "unknown" };
    } catch {
      return { ok: true, outcome: "unknown" };
    }
  }

  return { ok: true, outcome: "unknown" };
};

// ─── Hidden-window wrapper (for REST API / external calls) ───────────

/**
 * Execute a workflow in a hidden BrowserWindow.
 * Used by the REST API bridge.
 */
export const executeWorkflow = async (payload) => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  try {
    return await executeWorkflowSteps(win.webContents, payload);
  } catch (error) {
    return {
      ok: false,
      error: "ERR_WORKFLOW_FAILED",
      message: error.message || "Workflow execution failed",
    };
  } finally {
    win.destroy();
  }
};

/**
 * Create an Electron-compatible bridge object for the HTTP router.
 */
export const createElectronBridge = () => {
  return {
    async sendAndAwait(_socket, _type, payload, _timeoutMs) {
      return executeWorkflow(payload);
    },
    handleWsResult() { return false; },
    rejectAll() {},
  };
};
