/**
 * workflow-executor.js — Execute workflows using Playwright over Electron's CDP.
 *
 * Uses Electron's own Chromium (no automation fingerprint) controlled via
 * Playwright's locator APIs through connectOverCDP.
 *
 * Two modes:
 *   - executeWorkflowSteps(page, payload) — run steps in a Playwright page
 *   - executeWorkflow(payload, { cdpPort }) — create a hidden BrowserWindow,
 *     connect Playwright via CDP, run steps, destroy window (for REST API)
 */

import { BrowserWindow } from "electron";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PAGE_READY_TIMEOUT_MS = 20000;
const DOM_IDLE_MS = 600;
const ACTION_TIMEOUT_MS = 5000;

// ─── Persistent CDP connection to Electron ──────────────────────────────

let _cdpBrowser = null;

/**
 * Get (or establish) a Playwright browser connected to Electron via CDP.
 * Reuses the connection across workflow executions.
 */
const getCDPBrowser = async (cdpPort) => {
  if (_cdpBrowser?.isConnected()) return _cdpBrowser;
  _cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  return _cdpBrowser;
};

/**
 * Find the Playwright page corresponding to an Electron BrowserWindow.
 * Matches by URL prefix after the window has navigated.
 */
const findPage = (browser, urlPrefix) => {
  const allPages = browser.contexts().flatMap((c) => c.pages());
  return allPages.find((p) => p.url().startsWith(urlPrefix)) || allPages[allPages.length - 1];
};

// ─── Page executor functions (PAGE_READ_VIEW, PAGE_EVALUATE_OUTCOME) ────

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

// ─── Locator resolution ─────────────────────────────────────────────────

/**
 * Resolve a list of strategies into a Playwright locator.
 * Tries strategies in descending confidence order.
 *
 * @param {import('playwright').Page} page
 * @param {Array<{kind: string, value: string, confidence: number}>} strategies
 * @returns {{ locator: import('playwright').Locator, usedStrategy: {kind: string, value: string} } | null}
 */
const resolveLocator = (page, strategies) => {
  const sorted = [...(strategies || [])].sort((a, b) => b.confidence - a.confidence);

  for (const s of sorted) {
    let locator;
    try {
      switch (s.kind) {
        case "css":
        case "dom_path":
          locator = page.locator(s.value);
          break;
        case "xpath": {
          const xpath = s.value.startsWith("/body") ? `/html${s.value}` : s.value;
          locator = page.locator("xpath=" + xpath);
          break;
        }
        case "text":
          locator = page.getByText(s.value);
          break;
        case "role_name": {
          // Handle format: 'button "Next"'
          const quoteMatch = s.value.match(/^(\w+)\s+"(.+)"$/);
          if (quoteMatch) {
            locator = page.getByRole(quoteMatch[1], { name: quoteMatch[2] });
          } else {
            // Handle format: 'button:Next'
            const colonIdx = s.value.indexOf(":");
            if (colonIdx >= 0) {
              locator = page.getByRole(s.value.slice(0, colonIdx).trim(), {
                name: s.value.slice(colonIdx + 1).trim(),
              });
            } else {
              locator = page.getByRole(s.value);
            }
          }
          break;
        }
        case "data_testid":
          locator = page.getByTestId(s.value);
          break;
        case "attribute": {
          const eqIdx = s.value.indexOf("=");
          if (eqIdx >= 0) {
            const attr = s.value.slice(0, eqIdx).trim();
            const val = s.value.slice(eqIdx + 1).trim();
            locator = page.locator(`[${attr}="${val}"]`);
          } else {
            locator = page.locator(`[${s.value}]`);
          }
          break;
        }
        default:
          continue;
      }
    } catch {
      continue;
    }

    if (locator) {
      return { locator, usedStrategy: { kind: s.kind, value: s.value } };
    }
  }

  return null;
};

// ─── Page helpers ────────────────────────────────────────────────────────

const waitForPageSettle = async (page, { timeoutMs = PAGE_READY_TIMEOUT_MS } = {}) => {
  try {
    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
  } catch {
    // networkidle timeout is non-fatal; continue with DOM idle check
  }

  const domStable = await page.evaluate((idleMs) => {
    return new Promise((resolve) => {
      let timer = null;
      const obs = new MutationObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { obs.disconnect(); resolve(true); }, idleMs);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      timer = setTimeout(() => { obs.disconnect(); resolve(true); }, idleMs);
    });
  }, DOM_IDLE_MS).catch(() => true);

  return { settled: domStable };
};

/**
 * Navigate to a URL and inject page executor functions.
 */
const navigateAndSetup = async (page, url, executorSource) => {
  await page.goto(url, { waitUntil: "load", timeout: PAGE_READY_TIMEOUT_MS });
  await page.addScriptTag({ content: executorSource });
};

/**
 * Resolve a step URL against the origin.
 */
const resolveUrl = (stepUrl, origin, inputs) => {
  let url = stepUrl.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, param) => {
    const value = inputs?.[param];
    return value != null ? encodeURIComponent(value) : match;
  });

  if (url.startsWith("/") && origin) {
    url = origin.replace(/\/$/, "") + url;
  }

  return url;
};

// ─── Action execution via Playwright locators ────────────────────────────

/**
 * Execute an action (click/fill/select) using Playwright's native locator APIs.
 */
const executeAction = async (page, { strategies, interactionKind, inputs }) => {
  const resolved = resolveLocator(page, strategies);
  if (!resolved) {
    return { ok: false, error: "ERR_TARGET_NOT_FOUND", message: "No locator matched" };
  }

  const target = resolved.locator.first();
  const kind = (interactionKind || "click").toLowerCase();

  try {
    if (kind === "click" || kind === "navigate") {
      await target.click({ timeout: ACTION_TIMEOUT_MS });
      return { ok: true, result: { action: "clicked" }, usedStrategy: resolved.usedStrategy };
    }
    if (kind === "type") {
      const text = inputs?.text || inputs?.value || "";
      await target.fill(text, { timeout: ACTION_TIMEOUT_MS });
      return { ok: true, result: { action: "typed", length: text.length }, usedStrategy: resolved.usedStrategy };
    }
    if (kind === "select") {
      const val = inputs?.value || "";
      await target.selectOption(val, { timeout: ACTION_TIMEOUT_MS });
      return { ok: true, result: { action: "selected", value: val }, usedStrategy: resolved.usedStrategy };
    }
    // Default: click
    await target.click({ timeout: ACTION_TIMEOUT_MS });
    return { ok: true, result: { action: "clicked" }, usedStrategy: resolved.usedStrategy };
  } catch (err) {
    return { ok: false, error: "ERR_ACTION_FAILED", message: err.message };
  }
};

// ─── Step execution ──────────────────────────────────────────────────────

/**
 * Execute workflow steps in a Playwright page.
 *
 * @param {import('playwright').Page} page
 * @param {{ steps: Array, outcomes: object, inputs: object, origin: string, pagination: object }} payload
 * @returns {Promise<object>}
 */
export const executeWorkflowSteps = async (page, { steps, outcomes, inputs, origin, pagination }) => {
  const executorSource = await loadPageExecutorSource();

  // Navigate to origin if first step isn't navigate
  const firstStepIsNav = steps?.length > 0 && steps[0].type === "navigate";
  if (origin && !firstStepIsNav) {
    await navigateAndSetup(page, origin, executorSource);
    await waitForPageSettle(page);
  }

  let lastReadData = null;
  let hasReadView = false;

  for (const step of steps || []) {
    const shouldWaitBefore = ["read_view", "fill", "select", "click", "submit"].includes(step.type);
    if (shouldWaitBefore) {
      const preSettle = await waitForPageSettle(page);
      if (!preSettle.settled) {
        return { ok: false, error: "ERR_PAGE_NOT_READY", message: `Page did not settle before ${step.type}` };
      }
    }

    if (step.type === "navigate") {
      const url = resolveUrl(step.url, origin, inputs);
      await navigateAndSetup(page, url, executorSource);
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

      // First page read
      const result = await page.evaluate(
        (config) => PAGE_READ_VIEW(config),
        viewConfig
      );

      if (!result || result.ok === false) {
        return {
          ok: false,
          error: result?.error || "ERR_READ_VIEW_FAILED",
          message: result?.message || "read_view step failed",
        };
      }

      let allData = Array.isArray(result.result) ? [...result.result] : result.result;
      const limit = inputs?.limit ? Number(inputs.limit) : null;

      // Paginate if limit requested and pagination config provided
      while (pagination && limit && Array.isArray(allData) && allData.length < limit) {
        const prevCount = allData.length;

        if (pagination.kind === "click_next" && pagination.strategies?.length) {
          const clickResult = await executeAction(page, {
            strategies: pagination.strategies,
            interactionKind: "click",
            inputs: {},
          });
          if (!clickResult || clickResult.ok === false) break;
          await waitForPageSettle(page);

          // Re-inject after potential navigation
          await page.addScriptTag({ content: executorSource }).catch(() => {});

          const nextResult = await page.evaluate(
            (config) => PAGE_READ_VIEW(config),
            viewConfig
          );
          if (!nextResult || nextResult.ok === false) break;
          const newItems = Array.isArray(nextResult.result) ? nextResult.result : [];
          if (newItems.length === 0) break;
          allData.push(...newItems);
        } else if (pagination.kind === "scroll") {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await waitForPageSettle(page);

          const nextResult = await page.evaluate(
            (config) => PAGE_READ_VIEW(config),
            viewConfig
          );
          if (!nextResult || nextResult.ok === false) break;
          // Scroll pages accumulate items in the DOM
          allData = Array.isArray(nextResult.result) ? nextResult.result : allData;
        }

        if (allData.length === prevCount) break;
      }

      if (limit && Array.isArray(allData)) {
        allData = allData.slice(0, limit);
      }

      lastReadData = allData;
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

      const result = await executeAction(page, {
        strategies: step.strategies || [],
        interactionKind,
        inputs: stepInputs,
      });

      if (!result || result.ok === false) {
        return {
          ok: false,
          error: result?.error || "ERR_STEP_FAILED",
          message: result?.message || `${step.type} step failed`,
        };
      }

      await waitForPageSettle(page);
      continue;
    }
  }

  // All steps succeeded
  if (hasReadView) {
    return { ok: true, data: lastReadData };
  }

  // Write workflow — evaluate outcomes
  await waitForPageSettle(page);

  if (outcomes) {
    try {
      const evalResult = await page.evaluate(
        (config) => PAGE_EVALUATE_OUTCOME(config),
        { outcomes }
      );
      return { ok: true, outcome: evalResult?.outcome || "unknown" };
    } catch {
      return { ok: true, outcome: "unknown" };
    }
  }

  return { ok: true, outcome: "unknown" };
};

// ─── Hidden-window wrapper (for REST API) ─────────────────────────────────

/**
 * Execute a workflow in a hidden Electron BrowserWindow controlled via Playwright CDP.
 * Uses Electron's clean Chromium (no automation fingerprint).
 */
export const executeWorkflow = async (payload, { cdpPort } = {}) => {
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
    // Navigate the Electron window to the origin
    const origin = payload.origin;
    if (origin) {
      await win.loadURL(origin);
    }

    // Connect Playwright to Electron via CDP and find this page
    const browser = await getCDPBrowser(cdpPort);
    const page = findPage(browser, origin || "about:blank");

    if (!page) {
      return { ok: false, error: "ERR_CDP_PAGE_NOT_FOUND", message: "Could not find page via CDP" };
    }

    const result = await executeWorkflowSteps(page, payload);
    if (!result.ok) {
      console.error(`[browserwire] workflow failed: ${result.error || result.message}`);
    }
    return result;
  } catch (error) {
    console.error(`[browserwire] workflow threw: ${error.message}`);
    return {
      ok: false,
      error: error.message || "Workflow execution failed",
    };
  } finally {
    win.destroy();
  }
};

/**
 * Create a bridge object for the HTTP router.
 * Connects Playwright to Electron's Chromium via CDP.
 */
export const createPlaywrightBridge = ({ cdpPort } = {}) => {
  return {
    async sendAndAwait(_socket, _type, payload, _timeoutMs) {
      return executeWorkflow(payload, { cdpPort });
    },
    handleWsResult() { return false; },
    rejectAll() {},
  };
};
