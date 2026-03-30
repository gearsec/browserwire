/**
 * playwright-browser.js — Real Chromium browser for selector testing
 *
 * Loads rrweb snapshots into a headless Chromium page using rrweb-snapshot's
 * rebuild(), then uses Playwright's native selector/locator APIs for testing.
 *
 * Single browser instance per session, fresh page per snapshot.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to rrweb-snapshot UMD bundle for injection into the page
const RRWEB_SNAPSHOT_UMD_PATH = resolve(
  __dirname,
  "../../../node_modules/rrweb-snapshot/dist/rrweb-snapshot.umd.cjs"
);


export class PlaywrightBrowser {
  constructor() {
    /** @type {import('playwright').Browser|null} */
    this._browser = null;
    /** @type {import('playwright').Page|null} */
    this.page = null;
    /** @type {string|null} Cached UMD script content */
    this._rrwebScript = null;
  }

  /**
   * Lazy-launch headless Chromium. Reuses the same browser instance.
   */
  async ensureBrowser() {
    if (this._browser) return;
    this._browser = await chromium.launch({ headless: true });
  }

  /**
   * Load an rrweb snapshot into a fresh Chromium page.
   * Closes any previously open page.
   *
   * @param {object} rrwebSnapshotJson - The raw rrweb snapshot tree (JSON object)
   * @param {string} [url] - The page URL (for context)
   * @returns {Promise<import('playwright').Page>}
   */
  async loadSnapshot(rrwebSnapshotJson, url = "http://localhost") {
    await this.ensureBrowser();

    // Close previous page
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }

    // Read and cache the UMD script
    if (!this._rrwebScript) {
      this._rrwebScript = await readFile(RRWEB_SNAPSHOT_UMD_PATH, "utf-8");
    }

    const page = await this._browser.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });

    // Set up a minimal HTML shell
    await page.setContent(
      `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>`,
      { waitUntil: "domcontentloaded" }
    );

    // Inject rrweb-snapshot UMD
    await page.addScriptTag({ content: this._rrwebScript });

    // Rebuild the full rrweb snapshot (including <head> for stylesheets) into the real DOM
    await page.evaluate((snapshotJson) => {
      /* global rrwebSnapshot */
      const mirror = rrwebSnapshot.createMirror();
      const cache = rrwebSnapshot.createCache();

      // Find the <html> node in the rrweb tree
      function findHtmlNode(node) {
        if (!node) return null;
        if (node.type === 2 && (node.tagName || "").toLowerCase() === "html") {
          return node;
        }
        for (const child of node.childNodes || []) {
          const found = findHtmlNode(child);
          if (found) return found;
        }
        return null;
      }

      const htmlNode = findHtmlNode(snapshotJson);
      if (!htmlNode) {
        throw new Error("No html node found in rrweb snapshot");
      }

      const domHtml = rrwebSnapshot.buildNodeWithSN(htmlNode, {
        doc: document,
        mirror,
        hackCss: false,
        cache,
      });

      if (!domHtml) {
        throw new Error("buildNodeWithSN returned null for html node");
      }

      // Replace the entire document element (includes <head> with stylesheets + <body>)
      document.replaceChild(domHtml, document.documentElement);

      // Store mirror on window for rrweb ID lookups
      window.__rrwebMirror = mirror;
    }, rrwebSnapshotJson);

    // Wait for external stylesheets to load so CSS layout matches the live page
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

    this.page = page;
    return page;
  }

  /**
   * Run a CSS selector via document.querySelectorAll and return rrweb IDs.
   *
   * @param {import('playwright').Page} page
   * @param {string} selector - CSS selector
   * @returns {Promise<number[]>} Array of rrweb node IDs
   */
  async querySelectorAll(page, selector) {
    return page.evaluate((sel) => {
      const elements = document.querySelectorAll(sel);
      const ids = [];
      for (const el of elements) {
        const id = window.__rrwebMirror.getId(el);
        if (id > 0) ids.push(id);
      }
      return ids;
    }, selector);
  }

  /**
   * Locate elements using Playwright's locator API and return rrweb IDs.
   * Supports: css, xpath, text, role_name, data_testid, attribute.
   *
   * @param {import('playwright').Page} page
   * @param {string} kind - Locator kind
   * @param {string} value - Locator value
   * @returns {Promise<number[]>} Array of rrweb node IDs
   */
  async locateElements(page, kind, value) {
    let locator;

    switch (kind) {
      case "css":
        locator = page.locator(value);
        break;
      case "xpath":
        locator = page.locator("xpath=" + value);
        break;
      case "text":
        locator = page.getByText(value);
        break;
      case "role_name": {
        // Parse "role:name" format, e.g. "button:Submit" or just "button"
        const colonIdx = value.indexOf(":");
        if (colonIdx >= 0) {
          const role = value.slice(0, colonIdx).trim();
          const name = value.slice(colonIdx + 1).trim();
          locator = page.getByRole(role, { name });
        } else {
          locator = page.getByRole(value);
        }
        break;
      }
      case "data_testid":
        locator = page.getByTestId(value);
        break;
      case "attribute": {
        // Value format: "attr=val" → [attr="val"]
        const eqIdx = value.indexOf("=");
        if (eqIdx >= 0) {
          const attr = value.slice(0, eqIdx).trim();
          const val = value.slice(eqIdx + 1).trim();
          locator = page.locator(`[${attr}="${val}"]`);
        } else {
          locator = page.locator(`[${value}]`);
        }
        break;
      }
      default:
        return [];
    }

    const elements = await locator.all();
    const ids = [];
    for (const el of elements) {
      const id = await el.evaluate((node) => {
        return window.__rrwebMirror.getId(node);
      });
      if (id > 0) ids.push(id);
    }
    return ids;
  }

  /**
   * Get the full accessibility tree from Chrome's CDP Accessibility domain.
   *
   * @param {import('playwright').Page} page
   * @returns {Promise<object[]>} Array of CDP AXTree nodes
   */
  async getAccessibilityTree(page) {
    const cdp = await page.context().newCDPSession(page);
    try {
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      return nodes;
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  /**
   * Map CDP accessibility nodes back to rrweb IDs via DOM.resolveNode.
   *
   * For each CDP node that has a backendDOMNodeId, resolves it to a JS object
   * reference and evaluates `window.__rrwebMirror.getId(element)` to get the
   * rrweb node ID.
   *
   * @param {import('playwright').Page} page
   * @param {object[]} cdpNodes - CDP AXTree nodes from getAccessibilityTree()
   * @returns {Promise<Map<string, number>>} Map<cdpNodeId, rrwebId>
   */
  async mapCDPNodesToRrwebIds(page, cdpNodes) {
    const cdp = await page.context().newCDPSession(page);
    const mapping = new Map();

    try {
      for (const node of cdpNodes) {
        const backendId = node.backendDOMNodeId;
        if (!backendId) continue;

        try {
          const { object } = await cdp.send("DOM.resolveNode", {
            backendNodeId: backendId,
          });

          if (!object || !object.objectId) continue;

          const { result } = await cdp.send("Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: `function() {
              return window.__rrwebMirror ? window.__rrwebMirror.getId(this) : -1;
            }`,
            returnByValue: true,
          });

          const rrwebId = result?.value;
          if (rrwebId && rrwebId > 0) {
            mapping.set(node.nodeId, rrwebId);
          }
        } catch {
          // Node may have been GC'd or is not an element — skip
        }
      }
    } finally {
      await cdp.detach().catch(() => {});
    }

    return mapping;
  }

  /**
   * Start capturing interaction events via DOM listeners.
   * Uses window.__rrwebMirror (from snapshot reconstruction) to map
   * event targets to original recording node IDs.
   * Call collectRecordedEvents() after executing action code.
   */
  async startRecording() {
    if (!this.page) throw new Error("No page loaded");
    await this.page.evaluate(() => {
      window.__bw_test_events = [];
      const handler = (e) => {
        // Prevent navigation — link clicks in reconstructed DOM destroy the page context
        if (e.type === "click") e.preventDefault();

        // Walk up from target to find the nearest node in the reconstruction mirror
        let node = e.target;
        let id = 0;
        while (node && node !== document) {
          id = window.__rrwebMirror?.getId(node) || 0;
          if (id > 0) break;
          node = node.parentElement;
        }
        if (id > 0) {
          window.__bw_test_events.push({ type: e.type, rrweb_node_id: id });
        }
      };
      window.__bw_test_handler = handler;
      ["mousedown", "mouseup", "click", "input", "change"].forEach((t) =>
        document.addEventListener(t, handler, { capture: true })
      );
    });
  }

  /**
   * Collect interaction events captured since startRecording().
   * Returns deduplicated events with rrweb node IDs from the reconstruction mirror.
   *
   * @returns {Promise<Array<{ type: string, rrweb_node_id: number, interaction_type?: number }>>}
   */
  async collectRecordedEvents() {
    if (!this.page) return [];
    return this.page.evaluate(() => {
      const handler = window.__bw_test_handler;
      if (handler) {
        ["mousedown", "mouseup", "click", "input", "change"].forEach((t) =>
          document.removeEventListener(t, handler, { capture: true })
        );
        window.__bw_test_handler = null;
      }
      const events = window.__bw_test_events || [];
      window.__bw_test_events = [];

      // Map DOM event types to rrweb MouseInteraction types
      const INTERACTION_TYPE = { mousedown: 1, mouseup: 0, click: 2 };
      const seen = new Set();
      return events
        .map((e) => {
          const isInput = e.type === "input" || e.type === "change";
          return {
            type: isInput ? "input" : "mouse_interaction",
            interaction_type: isInput ? undefined : INTERACTION_TYPE[e.type],
            rrweb_node_id: e.rrweb_node_id,
          };
        })
        .filter((e) => {
          const key = e.type + ":" + e.rrweb_node_id + ":" + e.interaction_type;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    });
  }

  /**
   * Close the browser and release resources.
   */
  async close() {
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    if (this._browser) {
      await this._browser.close().catch(() => {});
      this._browser = null;
    }
  }
}
