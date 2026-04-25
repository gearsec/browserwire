/**
 * ax-tree.js — Fetch the Playwright accessibility tree as YAML.
 *
 * Uses page.accessibility.snapshot() and converts to YAML via the yaml lib.
 * No filtering, no custom serialization — what Playwright returns is what the agent sees.
 */

import { stringify } from "yaml";

/**
 * Fetch the accessibility tree and return as YAML text.
 *
 * @param {import('patchright').Page} page
 * @returns {Promise<{ url: string, title: string, tree: string }>}
 */
export async function getAccessibilityTree(page) {
  const url = page.url();
  const title = await page.title();
  const snapshot = await page.accessibility.snapshot();
  const tree = snapshot ? stringify(snapshot) : "(empty page)";
  return { url, title, tree };
}
