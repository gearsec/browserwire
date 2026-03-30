/**
 * execution-bridge.js — Execute routes using Electron BrowserWindow + Playwright CDP.
 *
 * Creates a hidden BrowserWindow, connects Playwright via Chrome's CDP,
 * runs the executor against the real Electron Chromium (no bot detection),
 * then destroys the window.
 *
 * This is the Electron-specific wrapper around core/api/executor.js.
 */

import { BrowserWindow } from "electron";
import { chromium } from "playwright";
import { executeRoute } from "../../core/api/executor.js";

let _cdpPort = null;

/**
 * Set the CDP port (called once from main.js on startup).
 */
export function setCDPPort(port) {
  _cdpPort = port;
}

/**
 * Execute a route using Electron's Chromium via CDP.
 *
 * @param {object} options
 * @param {object} options.manifest — state machine manifest
 * @param {object} options.route — route from buildRouteTable()
 * @param {object} options.inputs — flat inputs from the request
 * @param {string} options.origin — site origin
 * @param {BrowserWindow} [options.parentWindow] — parent window for the hidden exec window
 * @returns {Promise<object>} — executor result
 */
export async function executeViaElectron({ manifest, route, inputs, origin, parentWindow }) {
  if (!_cdpPort) {
    throw new Error("CDP port not configured — call setCDPPort() first");
  }

  // Create a visible BrowserWindow for execution
  const execWin = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
    ...(parentWindow ? { parent: parentWindow } : {}),
  });

  let browser = null;

  try {
    // Navigate to origin first — a real page load registers the CDP target properly
    await execWin.loadURL(origin);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${_cdpPort}`);

    // Find the execution page by origin
    const allPages = browser.contexts().flatMap((c) => c.pages());
    const page = allPages.find((p) => {
      try { return p.url().startsWith(origin); } catch { return false; }
    }) || allPages[allPages.length - 1];

    if (!page) {
      return { ok: false, error: `Could not find execution page via CDP. Found ${allPages.length} pages: ${allPages.map(p => { try { return p.url(); } catch { return '?'; } }).join(', ')}` };
    }

    console.log(`[browserwire-exec] CDP page: ${page.url()}, pages found: ${allPages.length}`);

    // Run the executor with the Playwright page
    return await executeRoute({ page, manifest, route, inputs, origin });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    execWin.destroy();
  }
}
