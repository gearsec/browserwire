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
 *   - _currentStateId, _isExistingState, _pendingState, _pendingViews, _pendingActions
 *
 * Tools are converted to LangChain tool() instances via getAgentTools().
 */

import { tool } from "@langchain/core/tools";
import { view_screenshot, get_accessibility_tree, get_page_regions, find_interactive } from "./query.js";
import { inspect_element } from "./inspect.js";
import { get_transition_events } from "./transition.js";
import { get_state_machine } from "./context.js";
import { test_code } from "./test-code.js";
import { submit_state, submit_view, submit_action } from "./submit.js";

// All tool definitions
const allTools = [
  // Page understanding
  view_screenshot,
  get_accessibility_tree,
  get_page_regions,
  find_interactive,
  inspect_element,
  // Transition understanding
  get_transition_events,
  // State machine context
  get_state_machine,
  // Code testing
  test_code,
  // Submission (incremental)
  submit_state,
  submit_view,
  submit_action,
];

/**
 * Convert a tool definition to a LangChain tool() bound to the agent context.
 */
const toLangChainTool = (def, ctx) =>
  tool(
    async (params) => {
      const result = await def.execute(ctx, params);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
    { name: def.name, description: def.description, schema: def.parameters }
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
