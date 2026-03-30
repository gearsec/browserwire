/**
 * state-agent.js — Single ReAct agent for state machine discovery.
 *
 * Processes one snapshot from a session recording. Determines the semantic
 * state, writes Playwright code for views and actions, and submits them
 * incrementally. The orchestrator (session processing loop) calls this
 * agent per snapshot and wires the results into the StateMachineManifest.
 *
 * Tools available:
 *   Page understanding: view_screenshot, get_accessibility_tree, get_page_regions,
 *                       find_interactive, inspect_element
 *   Transition:         get_transition_events
 *   Context:            get_state_machine
 *   Testing:            test_code
 *   Submission:         submit_state, submit_view, submit_action, done
 */

import { HumanMessage } from "@langchain/core/messages";
import { getModel } from "./ai-provider.js";
import { getAgentTools } from "./tools-v2/index.js";
import { createReactAgent } from "./graphs/react-agent.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are building a state machine from a recorded browsing session. Each snapshot in the session is a potential state in the machine. Your job for each snapshot is to:

1. **Determine the state** — is this page a new state or one we've already seen? A state is identified by its purpose and what's visible/actionable on it. Two visits to the same page with the same content = same state.

2. **Extract views** (new states only) — what structured data is visible? Write Playwright code that extracts it. Each view is a function: \`async (page) => { ... }\` that returns the data.

3. **Extract actions** — what did the user do to leave this state? The recorded transition events tell you exactly which elements were clicked or filled. Write Playwright code that reproduces each interaction. Each action is a function: \`async (page, inputs) => { ... }\`.

## Workflow

1. **Orient**: Look at the screenshot, page regions, and accessibility tree. Check the existing state machine for states that might match.

2. **Submit state**: If you recognize an existing state, submit its id. Skip view extraction — views are already known. If it's new, submit the state identity (name, description, url_pattern, page_purpose). For the first snapshot also include domain and domainDescription.

3. **Submit views** (new states only): For each data region, use inspect_element on a representative element ref from the accessibility tree to discover the actual tag names, CSS classes, and attributes. Then write extraction code based on what you found, test it, and submit. Submit one view at a time — you can forget each view after submitting it. When testing, verify the code runs without errors and returns the correct structure (non-empty array for lists, non-empty object for single records). Do NOT compare against specific content values — page content is dynamic and will differ between the recorded session and the live page.

4. **Submit actions**: Check the transition events to see what the user did after this state. For each interaction, inspect the target element, write interaction code, test it against the recording to confirm it targets the correct elements, then submit. Terminal states (last snapshot) have no transition events — skip this step.

5. **Done**: Call done to signal completion.

## Code conventions

- View code: \`async (page) => { ... }\` — returns an object (single) or array of objects (list) with named fields
- Action code: \`async (page, inputs) => { ... }\` — inputs is an object with named parameters, may be empty for simple clicks
- When testing with test_code, write self-contained code with hardcoded sample values: \`async (page) => { await page.locator('input').fill('sample query'); }\`
- Submit the final parameterized version via submit_action: \`async (page, inputs) => { await page.locator('input').fill(inputs.query); }\`
- Use \`page.locator()\` with CSS selectors. Keep code simple and direct.
- When extracting fields from elements, wrap each field read in try/catch so missing elements return null instead of crashing: \`let text; try { text = await loc.innerText(); } catch { text = null; }\`. Playwright locators are always truthy even when no element matches — never use \`if (locator)\` to check existence.
- Use snake_case for all names.

## Rules

- NEVER submit views for an existing state.
- NEVER submit a view or action whose code hasn't been verified to return non-empty data via test_code. The submit tools will reject code that returns empty results.
- ONLY submit actions that match actual recorded transition events. Do not invent actions for elements the user didn't interact with.
- If your selectors don't work on the first try, STOP guessing and use inspect_element on the target element's ref to see the actual DOM structure (tag names, classes, attributes). Write selectors based on what inspect_element shows, not assumptions.
- ALWAYS call done when finished. If you stop without calling done, your work is lost.
- After each tool call, briefly note what you found before the next call.`;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the state machine agent on a single snapshot.
 *
 * @param {object} options
 * @param {object} options.index — SnapshotIndex (queryable DOM)
 * @param {object} options.browser — PlaywrightBrowser
 * @param {import('../manifest/manifest.js').StateMachineManifest} options.manifest
 * @param {Array} options.events — full rrweb event stream
 * @param {Array} options.snapshots — snapshot markers
 * @param {number} options.currentSnapshotIndex — which snapshot we're processing
 * @param {function} [options.onProgress] — called with { tool } on each tool call
 * @param {string} [options.sessionId]
 * @returns {Promise<{ pendingState, pendingViews, pendingActions, isExistingState, currentStateId, toolCallCount, error? }>}
 */
export async function runStateAgent({
  index,
  browser,
  manifest,
  events,
  snapshots,
  currentSnapshotIndex,
  onProgress,
  sessionId,
}) {
  const model = getModel();
  if (!model) {
    return { error: "No LLM provider configured", toolCallCount: 0 };
  }

  // Build the agent context — shared mutable object that tools read/write
  const ctx = {
    index,
    browser,
    manifest,
    events,
    snapshots,
    currentSnapshotIndex,
    // Submission state (set by submit tools)
    _currentStateId: null,
    _isExistingState: false,
    _pendingState: null,
    _pendingViews: [],
    _pendingActions: [],
    _done: false,
  };

  const tools = getAgentTools(ctx);

  let toolCallCount = 0;
  const { invoke } = createReactAgent({
    model,
    tools,
    submitToolName: "done",
    systemPrompt: SYSTEM_PROMPT,
    recursionLimit: 80,
    onProgress: ({ tool }) => {
      toolCallCount++;
      console.log(`[browserwire]   → ${tool.replace("state-agent:", "")}`);
      if (onProgress) onProgress({ tool });
    },
    agentRole: "state-agent",
  });

  const snapshot = snapshots[currentSnapshotIndex];
  const isTerminal = currentSnapshotIndex >= snapshots.length - 1;

  try {
    await invoke([
      new HumanMessage(
        `Analyze snapshot #${currentSnapshotIndex + 1} of ${snapshots.length}.\n` +
        `URL: ${snapshot.url}\n` +
        `Title: ${snapshot.title}\n` +
        (isTerminal ? "This is the LAST snapshot (terminal state — no forward transition events).\n" : "") +
        `\nProcess this snapshot: determine state, write views and actions, then call done.`
      ),
    ]);
  } catch (err) {
    return {
      error: `State agent error: ${err.message}`,
      toolCallCount,
      pendingState: ctx._pendingState,
      pendingViews: ctx._pendingViews,
      pendingActions: ctx._pendingActions,
      isExistingState: ctx._isExistingState,
      currentStateId: ctx._currentStateId,
    };
  }

  console.log(
    `[browserwire] state-agent: snapshot #${currentSnapshotIndex + 1} done — ` +
    `${ctx._isExistingState ? `existing state ${ctx._currentStateId}` : `new state "${ctx._pendingState?.name}"`}, ` +
    `${ctx._pendingViews.length} views, ${ctx._pendingActions.length} actions, ` +
    `${toolCallCount} tool calls`
  );

  return {
    pendingState: ctx._pendingState,
    pendingViews: ctx._pendingViews,
    pendingActions: ctx._pendingActions,
    isExistingState: ctx._isExistingState,
    currentStateId: ctx._currentStateId,
    toolCallCount,
  };
}
