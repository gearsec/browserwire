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

// Path to rrweb record UMD bundle for event capture during testing
const RRWEB_RECORD_UMD_PATH = resolve(
  __dirname,
  "../../../node_modules/@rrweb/record/dist/record.umd.cjs"
);

export class PlaywrightBrowser {
  constructor() {
    /** @type {import('playwright').Browser|null} */
    this._browser = null;
    /** @type {import('playwright').Page|null} */
    this.page = null;
    /** @type {string|null} Cached UMD script content */
    this._rrwebScript = null;
    /** @type {string|null} Cached rrweb record UMD script */
    this._rrwebRecordScript = null;
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

    // Rebuild the rrweb snapshot into the real DOM
    await page.evaluate((snapshotJson) => {
      /* global rrwebSnapshot */
      const mirror = rrwebSnapshot.createMirror();
      const cache = rrwebSnapshot.createCache();

      // Find the body node in the rrweb tree
      function findBodyNode(node) {
        if (!node) return null;
        if (node.type === 2 && (node.tagName || "").toLowerCase() === "body") {
          return node;
        }
        for (const child of node.childNodes || []) {
          const found = findBodyNode(child);
          if (found) return found;
        }
        return null;
      }

      const bodyNode = findBodyNode(snapshotJson);
      if (!bodyNode) {
        throw new Error("No body node found in rrweb snapshot");
      }

      const domBody = rrwebSnapshot.buildNodeWithSN(bodyNode, {
        doc: document,
        mirror,
        hackCss: false,
        cache,
      });

      if (!domBody) {
        throw new Error("buildNodeWithSN returned null");
      }

      // Replace the document body with the reconstructed one
      if (document.body) {
        document.documentElement.replaceChild(domBody, document.body);
      } else {
        document.documentElement.appendChild(domBody);
      }

      // Store mirror on window for rrweb ID lookups
      window.__rrwebMirror = mirror;
    }, rrwebSnapshotJson);

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
   * Inject rrweb record into the page and start capturing events.
   * Call this before executing action code to capture generated events.
   * Call collectRecordedEvents() after to retrieve them.
   */
  async startRecording() {
    if (!this.page) throw new Error("No page loaded");

    // Load and cache the rrweb record script
    if (!this._rrwebRecordScript) {
      this._rrwebRecordScript = await readFile(RRWEB_RECORD_UMD_PATH, "utf-8");
    }

    // Inject rrweb record UMD (exposes window.rrweb.record)
    await this.page.addScriptTag({ content: this._rrwebRecordScript });

    // Start recording, filtering to only interaction events
    await this.page.evaluate(() => {
      window.__bw_test_events = [];
      window.__bw_test_stop = window.rrweb.record({
        emit: (event) => {
          // Only capture IncrementalSnapshot (type=3) with MouseInteraction (source=2) or Input (source=5)
          if (event.type === 3 && (event.data.source === 2 || event.data.source === 5)) {
            window.__bw_test_events.push(event);
          }
        },
        sampling: {
          mousemove: false,
          scroll: 0,
          media: 0,
          canvas: 0,
        },
        recordCanvas: false,
        collectFonts: false,
      });
    });
  }

  /**
   * Collect events captured by startRecording() and stop recording.
   * Returns interaction events with rrweb node IDs.
   *
   * @returns {Promise<Array<{ type: string, rrweb_node_id: number, interaction_type?: number, text?: string }>>}
   */
  async collectRecordedEvents() {
    if (!this.page) return [];

    const rawEvents = await this.page.evaluate(() => {
      // Stop recording
      if (window.__bw_test_stop) {
        window.__bw_test_stop();
        window.__bw_test_stop = null;
      }
      const events = window.__bw_test_events || [];
      window.__bw_test_events = [];
      return events;
    });

    // Parse into a structured format
    return rawEvents.map((event) => {
      if (event.data.source === 2) {
        // MouseInteraction
        return {
          type: "mouse_interaction",
          interaction_type: event.data.type,
          rrweb_node_id: event.data.id,
        };
      } else if (event.data.source === 5) {
        // Input
        return {
          type: "input",
          rrweb_node_id: event.data.id,
          text: event.data.text || null,
        };
      }
      return null;
    }).filter(Boolean);
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
