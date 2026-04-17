/**
 * tools-v2/index.js — Tool registry for agents.
 *
 * Two tool sets:
 *   - Transition mode: agent writes code for a single snapshot transition
 *   - View mode: agent extracts business data views from a state
 *
 * All tools receive a context object (ctx) with:
 *   - index: SnapshotIndex (queryable DOM)
 *   - browser: PlaywrightBrowser (for code execution)
 *   - events: rrwebEvent[] (full session event stream)
 *   - snapshots: snapshotMarker[] (snapshot boundaries)
 *   - currentSnapshotIndex: number (which snapshot we're processing)
 */

import { tool } from "@langchain/core/tools";
import { view_screenshot, get_accessibility_tree, get_page_regions, find_interactive } from "./query.js";
import { inspect_element } from "./inspect.js";
import { test_code } from "./test-code.js";
import { submit_view, done } from "./submit.js";
import { load_snapshot } from "./navigate.js";

// ---------------------------------------------------------------------------
// Tool set: Transition mode
// ---------------------------------------------------------------------------

// Agent writes code for a SINGLE transition.
// No submit tools (orchestrator builds the action from done output).
// No navigation (agent stays on one snapshot).
// No get_transition_events (transition events provided upfront in the prompt).
const transitionTools = [
  view_screenshot,
  get_accessibility_tree,
  get_page_regions,
  find_interactive,
  inspect_element,
  test_code,
  done,
];

// ---------------------------------------------------------------------------
// Tool set: View mode
// ---------------------------------------------------------------------------

// Agent extracts business data views from a state.
// Has submit_view to submit views, but no action submission.
// No navigation (agent processes one snapshot at a time).
const viewTools = [
  view_screenshot,
  get_accessibility_tree,
  get_page_regions,
  find_interactive,
  inspect_element,
  test_code,
  load_snapshot,
  submit_view,
  done,
];

// ---------------------------------------------------------------------------
// LangChain tool conversion
// ---------------------------------------------------------------------------

/**
 * Convert a tool definition to a LangChain tool() bound to the agent context.
 */
const toLangChainTool = (def, ctx) =>
  tool(
    async (params) => {
      const result = await def.execute(ctx, params);
      if (ctx._onProgress) ctx._onProgress({ tool: def.name });
      if (typeof result === "string") return result;
      if (result?._multimodal) return result.content; // pass content blocks through
      return JSON.stringify(result);
    },
    {
      name: def.name,
      description: def.description,
      schema: def.parameters,
      ...(def.returnDirect ? { returnDirect: true } : {}),
    }
  );

/**
 * Get tools for transition agents.
 * @param {object} ctx
 * @returns {import('@langchain/core/tools').StructuredTool[]}
 */
export const getTransitionAgentTools = (ctx) =>
  transitionTools.map((def) => toLangChainTool(def, ctx));

/**
 * Get tools for view agents.
 * @param {object} ctx
 * @returns {import('@langchain/core/tools').StructuredTool[]}
 */
export const getViewAgentTools = (ctx) =>
  viewTools.map((def) => toLangChainTool(def, ctx));
