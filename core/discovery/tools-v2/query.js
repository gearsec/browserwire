/**
 * query.js — Page understanding tools for the state machine agent.
 *
 * These tools query the SnapshotIndex (built from an rrweb FullSnapshot
 * replayed into Playwright). They are carried over from the previous
 * agent system — same implementations, same query-engine underneath.
 */

import { z } from "zod";
import {
  getAccessibilitySnapshot,
  getPageRegions,
  findInteractive,
} from "../tools/query-engine.js";

// ---------------------------------------------------------------------------
// view_screenshot
// ---------------------------------------------------------------------------

export const view_screenshot = {
  name: "view_screenshot",
  description: "View the page screenshot at this snapshot. Returns a base64-encoded JPEG image for visual understanding of the page layout.",
  parameters: z.object({}),
  execute: (ctx) => {
    if (!ctx.index.screenshot) {
      return { error: "No screenshot available for this snapshot" };
    }
    return { screenshot: ctx.index.screenshot, format: "base64/jpeg" };
  },
};

// ---------------------------------------------------------------------------
// get_accessibility_tree
// ---------------------------------------------------------------------------

export const get_accessibility_tree = {
  name: "get_accessibility_tree",
  description: "Get a YAML-style accessibility tree with stable ref IDs (e.g., e23). Shows: role, name, value, state, children. Optionally scope to a subtree by providing root_ref.",
  parameters: z.object({
    root_ref: z.string().optional().describe("Scope to subtree rooted at this ref ID"),
  }),
  execute: (ctx, params) => getAccessibilitySnapshot(ctx.index, params),
};

// ---------------------------------------------------------------------------
// get_page_regions
// ---------------------------------------------------------------------------

export const get_page_regions = {
  name: "get_page_regions",
  description: "Get a high-level table of contents of the page: major sections with their accessibility roles, headings, child element counts, and whether they contain data lists. Use this first to understand page layout.",
  parameters: z.object({}),
  execute: (ctx) => getPageRegions(ctx.index),
};

// ---------------------------------------------------------------------------
// find_interactive
// ---------------------------------------------------------------------------

export const find_interactive = {
  name: "find_interactive",
  description: "Find interactive elements (buttons, links, inputs, forms) by accessibility role. Optionally filter by kind, text, or scope to a subtree.",
  parameters: z.object({
    near_ref: z.string().optional().describe("Scope to elements within this ref's subtree"),
    kind: z.enum(["button", "link", "input", "form"]).optional().describe("Filter by element kind"),
    text: z.string().optional().describe("Filter by text content (case-insensitive substring match)"),
  }),
  execute: (ctx, params) => findInteractive(ctx.index, params),
};

