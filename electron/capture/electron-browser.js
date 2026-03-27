/**
 * electron-browser.js — Drop-in replacement for PlaywrightBrowser.
 *
 * Uses a hidden BrowserWindow + webContents.debugger (CDP) instead of Playwright.
 * Same public API as PlaywrightBrowser.
 */

import { BrowserWindow } from "electron";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RRWEB_SNAPSHOT_UMD_PATH = resolve(
  __dirname,
  "../../node_modules/rrweb-snapshot/dist/rrweb-snapshot.umd.cjs"
);

export class ElectronBrowser {
  constructor() {
    /** @type {BrowserWindow|null} */
    this._window = null;
    /** @type {Electron.WebContents|null} */
    this.page = null;
    /** @type {string|null} */
    this._rrwebScript = null;
  }

  /**
   * No-op for Electron — the BrowserWindow is created lazily in loadSnapshot.
   */
  async ensureBrowser() {
    // Nothing to do — window created per-snapshot
  }

  /**
   * Load an rrweb snapshot into a hidden BrowserWindow.
   * Mirrors PlaywrightBrowser.loadSnapshot() API.
   *
   * @param {object} rrwebSnapshotJson - Raw rrweb snapshot tree
   * @param {string} [url] - Page URL for context
   * @returns {Promise<Electron.WebContents>} The webContents (analogous to Playwright Page)
   */
  async loadSnapshot(rrwebSnapshotJson, url = "http://localhost") {
    // Close previous window
    if (this._window) {
      this._window.destroy();
      this._window = null;
      this.page = null;
    }

    // Cache rrweb UMD script
    if (!this._rrwebScript) {
      this._rrwebScript = await readFile(RRWEB_SNAPSHOT_UMD_PATH, "utf-8");
    }

    // Create hidden window
    this._window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: {
        offscreen: true,
        contextIsolation: false,
        nodeIntegration: false,
      },
    });

    const wc = this._window.webContents;

    // Load minimal HTML shell
    await wc.loadURL("data:text/html,<!DOCTYPE html><html><head><meta charset='utf-8'></head><body></body></html>");

    // Inject rrweb-snapshot UMD
    await wc.executeJavaScript(this._rrwebScript);

    // Rebuild the snapshot into the DOM
    await wc.executeJavaScript(`
      (function() {
        const snapshotJson = ${JSON.stringify(rrwebSnapshotJson)};
        const mirror = rrwebSnapshot.createMirror();
        const cache = rrwebSnapshot.createCache();

        function findBodyNode(node) {
          if (!node) return null;
          if (node.type === 2 && (node.tagName || "").toLowerCase() === "body") return node;
          for (const child of node.childNodes || []) {
            const found = findBodyNode(child);
            if (found) return found;
          }
          return null;
        }

        const bodyNode = findBodyNode(snapshotJson);
        if (!bodyNode) throw new Error("No body node found in rrweb snapshot");

        const domBody = rrwebSnapshot.buildNodeWithSN(bodyNode, {
          doc: document,
          mirror,
          hackCss: false,
          cache,
        });

        if (!domBody) throw new Error("buildNodeWithSN returned null");

        if (document.body) {
          document.documentElement.replaceChild(domBody, document.body);
        } else {
          document.documentElement.appendChild(domBody);
        }

        window.__rrwebMirror = mirror;
      })();
    `);

    // Wrap webContents with an evaluate() method compatible with Playwright's
    // page.evaluate(fn, arg) API.  testing.js calls browser.page.evaluate()
    // directly — Playwright Pages have this natively, but webContents only has
    // executeJavaScript(string).  The wrapper serializes fn+arg into an IIFE.
    this.page = new Proxy(wc, {
      get(target, prop) {
        if (prop === "evaluate") {
          return async (fn, arg) => {
            const script = arg !== undefined
              ? `(${fn.toString()})(${JSON.stringify(arg)})`
              : `(${fn.toString()})()`;
            return target.executeJavaScript(script);
          };
        }
        const value = target[prop];
        if (typeof value === "function") {
          return value.bind(target);
        }
        return value;
      },
    });
    return this.page;
  }

  /**
   * Run a CSS selector and return rrweb IDs.
   *
   * @param {Electron.WebContents} page
   * @param {string} selector
   * @returns {Promise<number[]>}
   */
  async querySelectorAll(page, selector) {
    return page.executeJavaScript(`
      (function() {
        const elements = document.querySelectorAll(${JSON.stringify(selector)});
        const ids = [];
        for (const el of elements) {
          const id = window.__rrwebMirror.getId(el);
          if (id > 0) ids.push(id);
        }
        return ids;
      })()
    `);
  }

  /**
   * Locate elements using various strategies and return rrweb IDs.
   *
   * @param {Electron.WebContents} page
   * @param {string} kind
   * @param {string} value
   * @returns {Promise<number[]>}
   */
  async locateElements(page, kind, value) {
    return page.executeJavaScript(`
      (function() {
        const kind = ${JSON.stringify(kind)};
        const value = ${JSON.stringify(value)};
        let elements = [];

        if (kind === "css" || kind === "dom_path") {
          try { elements = [...document.querySelectorAll(value)]; } catch {}
        } else if (kind === "xpath") {
          try {
            const result = document.evaluate(value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < result.snapshotLength; i++) {
              elements.push(result.snapshotItem(i));
            }
          } catch {}
        } else if (kind === "data_testid") {
          elements = [...document.querySelectorAll('[data-testid="' + value.replace(/"/g, '\\\\"') + '"]')];
        } else if (kind === "attribute") {
          const eqIdx = value.indexOf("=");
          if (eqIdx >= 0) {
            const attr = value.slice(0, eqIdx).trim();
            const val = value.slice(eqIdx + 1).trim();
            elements = [...document.querySelectorAll('[' + attr + '="' + val.replace(/"/g, '\\\\"') + '"]')];
          } else {
            elements = [...document.querySelectorAll('[' + value + ']')];
          }
        } else if (kind === "text") {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            if (walker.currentNode.textContent.includes(value)) {
              elements.push(walker.currentNode.parentElement);
            }
          }
        } else if (kind === "role_name") {
          const colonIdx = value.indexOf(":");
          if (colonIdx >= 0) {
            const role = value.slice(0, colonIdx).trim();
            const name = value.slice(colonIdx + 1).trim();
            elements = [...document.querySelectorAll('[role="' + role + '"]')].filter(
              el => (el.getAttribute("aria-label") || el.textContent || "").includes(name)
            );
          } else {
            elements = [...document.querySelectorAll('[role="' + value + '"]')];
          }
        }

        const ids = [];
        for (const el of elements) {
          if (el && window.__rrwebMirror) {
            const id = window.__rrwebMirror.getId(el);
            if (id > 0) ids.push(id);
          }
        }
        return ids;
      })()
    `);
  }

  /**
   * Get the full accessibility tree via CDP.
   *
   * @param {Electron.WebContents} page
   * @returns {Promise<object[]>}
   */
  async getAccessibilityTree(page) {
    const wc = page;
    try {
      wc.debugger.attach("1.3");
      const { nodes } = await wc.debugger.sendCommand("Accessibility.getFullAXTree");
      return nodes;
    } finally {
      try { wc.debugger.detach(); } catch {}
    }
  }

  /**
   * Map CDP accessibility nodes to rrweb IDs.
   *
   * @param {Electron.WebContents} page
   * @param {object[]} cdpNodes
   * @returns {Promise<Map<string, number>>}
   */
  async mapCDPNodesToRrwebIds(page, cdpNodes) {
    const wc = page;
    const mapping = new Map();

    try {
      wc.debugger.attach("1.3");

      for (const node of cdpNodes) {
        const backendId = node.backendDOMNodeId;
        if (!backendId) continue;

        try {
          const { object } = await wc.debugger.sendCommand("DOM.resolveNode", {
            backendNodeId: backendId,
          });

          if (!object || !object.objectId) continue;

          const { result } = await wc.debugger.sendCommand("Runtime.callFunctionOn", {
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
          // Node may have been GC'd — skip
        }
      }
    } finally {
      try { wc.debugger.detach(); } catch {}
    }

    return mapping;
  }

  /**
   * Close the hidden window and release resources.
   */
  async close() {
    if (this._window) {
      this._window.destroy();
      this._window = null;
      this.page = null;
    }
  }
}
