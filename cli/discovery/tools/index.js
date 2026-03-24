/**
 * index.js — Tool Registry for the Agentic Discovery System
 *
 * Exports all tools with Zod schemas for inputs/outputs and execute functions.
 * Each tool: { name, description, parameters: zodSchema, execute: fn(index, params) }
 *
 * Ready to be consumed by the agent loop (Phase 2) via Vercel AI SDK's tool system.
 */

import { z } from "zod";
import { SnapshotIndex } from "../snapshot/snapshot-index.js";
import {
  getAccessibilitySnapshot,
  getPageRegions,
  findInteractive,
  getElementDetails,
  inspectItemFields,
} from "./query-engine.js";
import {
  testSelector,
  testViewExtraction,
  submitManifest,
} from "./testing.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const tools = {
  // ---- Page Understanding ----

  view_screenshot: {
    name: "view_screenshot",
    description: "View the page screenshot. Returns the base64-encoded screenshot image for visual understanding of the page layout.",
    parameters: z.object({}),
    execute: (index, _params) => {
      if (!index.screenshot) {
        return { error: "No screenshot available for this snapshot" };
      }
      return { screenshot: index.screenshot, format: "base64/jpeg" };
    },
  },

  get_accessibility_snapshot: {
    name: "get_accessibility_snapshot",
    description: "Get a YAML-style accessibility tree with ref IDs. Shows: role, name, value, state, children. Each element has a stable ref ID (e.g., e23) for use in other tools. Optionally scope to a subtree by providing root_ref.",
    parameters: z.object({
      root_ref: z.string().optional().describe("Scope to subtree rooted at this ref ID"),
    }),
    execute: (index, params) => getAccessibilitySnapshot(index, params),
  },

  get_page_regions: {
    name: "get_page_regions",
    description: "Get a high-level 'table of contents' of the page — sections with their CDP accessibility roles, headings, child element counts, and whether they contain data lists. Use this first to understand page layout before drilling into specific regions.",
    parameters: z.object({}),
    execute: (index, _params) => getPageRegions(index),
  },

  // ---- Element Discovery ----

  find_interactive: {
    name: "find_interactive",
    description: "Find elements by their accessibility role, optionally filtered by kind (button/link/input/form) or text. Scope to a region with near_ref.",
    parameters: z.object({
      near_ref: z.string().optional().describe("Scope to elements within this ref's subtree"),
      kind: z.enum(["button", "link", "input", "form"]).optional().describe("Filter by element kind"),
      text: z.string().optional().describe("Filter by text content (case-insensitive substring match)"),
    }),
    execute: (index, params) => findInteractive(index, params),
  },

  get_element_details: {
    name: "get_element_details",
    description: "Get detailed information about a specific element by its ref ID. Returns: tag, role, name, text, all attributes, CSS selector, XPath, locator strategies with confidence scores, parent/children refs, and form context if inside a form.",
    parameters: z.object({
      ref: z.string().describe("The ref ID of the element (e.g., 'e23')"),
    }),
    execute: (index, params) => getElementDetails(index, params),
  },

  inspect_item_fields: {
    name: "inspect_item_fields",
    description: "Analyze the internal structure of a list/table item and return CSS selector candidates for each distinct content element within it. Also returns the item's own CSS selector and attributes. Use include_ancestor_height to see ancestor elements (their CSS classes, child counts) — this helps discover the right container_selector and item_selector. Use this on a sample item ref BEFORE proposing field selectors for test_view_extraction.",
    parameters: z.object({
      item_ref: z.string().describe("Ref ID of a list/table item to inspect (e.g., 'e42')"),
      include_ancestor_height: z.number().optional().describe(
        "How many ancestor levels to include. 0 (default) = item only, 3 = item + 3 ancestors, -1 = full branch to root"
      ),
    }),
    execute: (index, params) => inspectItemFields(index, params),
  },

  // ---- Validation / Testing ----

  test_selector: {
    name: "test_selector",
    description: 'Test a selector or locator against the page snapshot. Pass a locator object with kind and value. Supports kind: "css", "xpath", "text", "role_name" (format "role:name", e.g. "button:Submit"), "data_testid", "attribute" (format "attr=value"). Pass expected_count and/or expected_text to get strict pass/fail instead of raw data. Prefer data_testid when available, then css, then role_name/text as fallbacks. If after 3 attempts a selector cannot be validated, skip it and proceed with the best selector you have. Example: { locator: { kind: "css", value: "button.submit" }, expected_count: 1 }',
    parameters: z.object({
      locator: z.object({
        kind: z.enum(["css", "xpath", "text", "role_name", "data_testid", "attribute"]).describe("Selector/locator type"),
        value: z.string().describe("The selector or locator value to test"),
      }).describe("The locator to test"),
      expected_count: z.number().optional().describe("Assert exact match count. When provided, returns pass/fail instead of raw data."),
      expected_text: z.string().optional().describe("Assert first element's text contains this. When provided, returns pass/fail instead of raw data."),
    }),
    execute: (index, params, browser) => testSelector(index, params, browser),
  },

  test_view_extraction: {
    name: "test_view_extraction",
    description: "Simulate a complete view extraction: find a container, find items within it, extract named fields from each item. Pass expected_first_item to get strict pass/fail instead of raw sample rows. Use this to verify your view selectors work end-to-end before submitting the manifest.",
    parameters: z.object({
      container_selector: z.string().describe("CSS selector for the list/table container"),
      item_selector: z.string().optional().describe("CSS selector for individual items within the container (defaults to direct children)"),
      fields: z.array(z.object({
        name: z.string().describe("Field name"),
        selector: z.string().describe("CSS selector for the field within each item"),
        attribute: z.string().optional().describe("Extract an attribute value instead of text content"),
      })).describe("Fields to extract from each item"),
      expected_first_item: z.record(z.string(), z.string()).optional().describe("Field name → expected text for the first row. When provided, returns pass/fail with failures instead of raw sample rows."),
    }),
    execute: (index, params, browser) => testViewExtraction(index, params, browser),
  },

  submit_manifest: {
    name: "submit_manifest",
    description: "Validate and submit the final manifest. Checks schema validity (Zod), verifies endpoint references in workflows, and checks for duplicate names. Returns validation errors if any.",
    parameters: z.object({
      manifest: z.any().describe("The complete manifest object to validate"),
    }),
    execute: (_index, params) => submitManifest(params),
  },
};

// ---------------------------------------------------------------------------
// Convenience: create index + bind tools
// ---------------------------------------------------------------------------

/**
 * Create a SnapshotIndex from raw snapshot data.
 *
 * @param {object} options
 * @param {object} options.rrwebSnapshot - Parsed rrweb snapshot tree
 * @param {import('../snapshot/playwright-browser.js').PlaywrightBrowser} options.browser - Playwright browser instance (required)
 * @param {string|null} [options.screenshot] - Base64 screenshot
 * @param {object[]} [options.networkLogs] - Raw network logs
 * @param {string} [options.url] - Page URL
 * @param {string} [options.title] - Page title
 * @returns {SnapshotIndex}
 */
export const createIndex = (options) => new SnapshotIndex(options);

/**
 * Get tools formatted for Vercel AI SDK's `generateText({ tools })`.
 * Each tool has its execute function pre-bound to the given index and optional browser.
 *
 * @param {SnapshotIndex} index
 * @param {import('../snapshot/playwright-browser.js').PlaywrightBrowser} [browser]
 * @returns {Record<string, { description: string, parameters: z.ZodSchema, execute: (params: any) => any }>}
 */
export const getToolsForSDK = (index, browser) => {
  const sdkTools = {};

  for (const [name, tool] of Object.entries(tools)) {
    sdkTools[name] = {
      description: tool.description,
      parameters: tool.parameters,
      execute: (params) => tool.execute(index, params, browser),
    };
  }

  return sdkTools;
};

export { SnapshotIndex };
