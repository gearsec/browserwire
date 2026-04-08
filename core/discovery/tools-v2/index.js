/**
 * tools-v2/index.js — Tool registry for the state machine agent.
 *
 * All tools receive a context object (ctx) with:
 *   - index: SnapshotIndex (queryable DOM)
 *   - browser: PlaywrightBrowser (for code execution)
 *   - manifest: StateMachineManifest (accumulated state machine)
 *   - events: rrwebEvent[] (full session event stream)
 *   - snapshots: snapshotMarker[] (snapshot boundaries)
 *   - currentSnapshotIndex: number (which snapshot we're processing)
 *
 * The context also accumulates submission state (set by submit tools):
 *   - _isExistingState (pre-set by classifier), _pendingViews, _pendingActions
 *
 * Tools are converted to LangChain tool() instances via getAgentTools().
 */

import { tool } from "@langchain/core/tools";
import { view_screenshot, get_accessibility_tree, get_page_regions, find_interactive } from "./query.js";
import { inspect_element } from "./inspect.js";
import { get_transition_events } from "./transition.js";
import { test_code } from "./test-code.js";
import { submit_view, submit_action, done } from "./submit.js";
import { navigate_to_snapshot } from "./navigate.js";

// All tool definitions
// Note: submit_state and get_state_machine removed — state determination
// is now handled by the classifier (state-classifier.js) before the agent runs.
const allTools = [
  // Page understanding
  view_screenshot,
  get_accessibility_tree,
  get_page_regions,
  find_interactive,
  inspect_element,
  // Transition understanding
  get_transition_events,
  // Code testing
  test_code,
  // Navigation (intent-driven agents)
  navigate_to_snapshot,
  // Submission (incremental)
  submit_view,
  submit_action,
  done,
];

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
 * Get all agent tools as LangChain tool() instances bound to the given context.
 *
 * @param {object} ctx
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} ctx.index
 * @param {import('../snapshot/playwright-browser.js').PlaywrightBrowser} ctx.browser
 * @param {import('../../manifest/manifest.js').StateMachineManifest} ctx.manifest
 * @param {Array} ctx.events — full rrweb event stream
 * @param {Array} ctx.snapshots — snapshot markers
 * @param {number} ctx.currentSnapshotIndex
 * @returns {import('@langchain/core/tools').StructuredTool[]}
 */
export const getAgentTools = (ctx) =>
  allTools.map((def) => toLangChainTool(def, ctx));
