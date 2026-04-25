/**
 * browser-client.js — Live browser connection via CDP.
 *
 * Connects to an existing Chrome instance using Playwright's connectOverCDP.
 * Unlike PlaywrightBrowser (which launches headless + loads rrweb snapshots),
 * this connects to the user's running browser and navigates real pages.
 *
 * On disconnect, the browser stays open — we only detach.
 */

import { chromium } from "patchright";

export class BrowserClient {
  /**
   * @param {{ cdpEndpoint: string }} options
   */
  constructor({ cdpEndpoint }) {
    this._cdpEndpoint = cdpEndpoint;
    /** @type {import('patchright').Browser|null} */
    this._browser = null;
    /** @type {import('patchright').Page|null} */
    this._page = null;
  }

  /**
   * Connect to the browser via CDP WebSocket.
   * Grabs the first existing page, or creates one if none exist.
   */
  async connect() {
    this._browser = await chromium.connectOverCDP(this._cdpEndpoint);
    const contexts = this._browser.contexts();
    if (!contexts.length) throw new Error("No browser contexts found — is Chrome running?");
    const context = contexts[0];
    this._page = await context.newPage();
  }

  /**
   * The active Playwright Page object.
   * @returns {import('patchright').Page}
   */
  get page() {
    if (!this._page) throw new Error("Not connected — call connect() first");
    return this._page;
  }

  /**
   * Capture a screenshot as base64 JPEG.
   * @returns {Promise<string>} Base64-encoded JPEG
   */
  async screenshot() {
    const buffer = await this.page.screenshot({ type: "jpeg", quality: 80 });
    return buffer.toString("base64");
  }

  /**
   * Navigate to a URL and wait for initial load.
   * @param {string} url
   */
  async navigate(url) {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  /**
   * Wait for network to settle after navigation or interaction.
   * @param {{ timeout?: number }} [options]
   */
  async waitForLoad({ timeout = 10000 } = {}) {
    await this.page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  }

  /**
   * Get a CDP session for the current page.
   * Caller is responsible for detaching when done.
   * @returns {Promise<import('patchright').CDPSession>}
   */
  async getCDPSession() {
    return this.page.context().newCDPSession(this.page);
  }

  /**
   * Disconnect from the browser without closing it.
   */
  async disconnect() {
    if (this._browser) {
      await this._browser.close().catch(() => {});
      this._browser = null;
      this._page = null;
    }
  }
}
