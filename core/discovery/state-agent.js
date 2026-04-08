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
 *   Testing:            test_code
 *   Submission:         submit_view, submit_action, done
 */

import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { getModel } from "./ai-provider.js";
import { getAgentTools } from "./tools-v2/index.js";
import { compactMessagesHook } from "./graphs/utils.js";
import { view_screenshot } from "./tools-v2/query.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are extracting views and actions from a browser snapshot for a state machine. The state has already been identified — your job is to write Playwright code for data extraction (views) and interaction reproduction (actions).

## Your tasks

1. **Extract views** (new states only) — what business data would an API consumer want from this page? Write Playwright code that extracts it. Each view is a function: \`async (page) => { ... }\` that returns the data.

2. **Extract actions** — what did the user do to leave this state? The recorded transition events tell you exactly which elements were clicked or filled. Write Playwright code that reproduces each interaction. Each action is a function: \`async (page, inputs) => { ... }\`.

## Budget

You have a LIMITED iteration budget (~50 tool calls). You MUST be efficient:
- **Orient phase: MAX 3 calls** — screenshot (auto-provided) + get_accessibility_tree + 1 inspect_element on a representative item. That's it.
- **Then immediately write code** — use test_code to validate, then submit. Do NOT chain inspect_element calls without writing code in between.
- **If a page is complex**, extract the most important data first, submit it, then refine. A partial submission is infinitely better than hitting the limit with nothing submitted.
- **Never spend more than 2 consecutive inspect_element calls** without a test_code call. If you find yourself inspecting many elements, you're over-exploring — write code based on what you already know.

## Workflow

1. **Orient** (1-3 calls max): Review the screenshot (already provided via view_screenshot), then use get_accessibility_tree to understand the page structure. Optionally inspect_element on ONE representative element to see DOM details.

2. **Submit views** (new states only): Think "what API would this site's team publish?" — extract business data that a developer would consume via REST API.

   **What to extract**: Products, prices, ratings, reviews, descriptions, availability, images, URLs — the core business data visible on the page. For list pages, extract ALL meaningful fields per item. For detail pages, extract comprehensive information — every visible business attribute.

   **What NOT to extract**: UI chrome like button labels, input placeholders, navigation links, search form state, page headers/footers. These are actions or layout, not data. Don't create views for search bars, nav menus, or UI controls.

   **Naming**: Name views after the business domain (e.g., \`products\`, \`product_details\`, \`order_summary\`) not UI components (e.g., \`product_carousel\`, \`search_bar\`). One comprehensive view per data region is better than multiple narrow views.

   **Process**: Use inspect_element on a representative element ref from the accessibility tree to discover actual tag names, CSS classes, and attributes. Write extraction code based on what you found, test it, and submit. Submit one view at a time. When testing, verify the code runs without errors and returns the correct structure (non-empty array for lists, non-empty object for single records). Do NOT compare against specific content values — page content is dynamic.

3. **Submit actions**: Check the transition events to see what the user did after this state. For each interaction, inspect the target element, write interaction code, test it against the recording to confirm it targets the correct elements, then submit. Terminal states (last snapshot) have no transition events — skip this step.

   **Form handling**: When transition events show multiple input events followed by a click (a form submission pattern), create **one action per form field** plus **one action for the submit button** — NOT a single composite action.
   - **Critical**: Process fields ONE AT A TIME: inspect_element → write code → test_code → submit_action → next field. Do NOT inspect all fields first and batch-submit later — this wastes iterations and risks running out of budget.
   - Details:
   - Use inspect_element on each target ref to discover field type, label, placeholder, options.
   - **Per-field actions**: Create one action per form field. Each action has:
     - \`kind\`: "input", "select", or "toggle" matching the field type
     - \`form_group\`: a shared name for the form (e.g., \`"registration_form"\`)
     - \`sequence_order\`: integer (0, 1, 2, ...) matching the order fields were filled in the recording
     - One input with \`widget\`, \`label\`, \`options\`, \`format\`, \`placeholder\`, and \`selector\` populated
     - \`leads_to\`: omit (field actions stay in the same state)
     - Code does only the single field fill
   - **Submit action**: One action for the submit button:
     - \`kind\`: "form_submit"
     - \`form_group\`: same name as the field actions
     - \`sequence_order\`: highest value (after all fields)
     - No inputs (or a confirmation checkbox if applicable)
     - \`leads_to\`: the next state (the only action that transitions)
     - Code just clicks the submit button
   - Widget-specific Playwright patterns:
     - Native \`<select>\`: \`page.locator('select[name="x"]').selectOption(inputs.x)\`
     - Custom dropdown (role=combobox): click trigger → wait for listbox → click option by text
     - Checkbox: \`page.locator('...').setChecked(inputs.x)\`
     - Radio group: \`page.locator(\\\`input[type="radio"][value="\${inputs.x}"]\\\`).check()\`
     - File upload: \`page.locator('input[type="file"]').setInputFiles(inputs.x)\`
     - Text/email/tel/url/textarea: \`page.locator('...').fill(inputs.x)\`
   - Guard each field fill with \`if (inputs.field_name !== undefined)\` so callers can omit optional fields.
   - **Testing**: Test each per-field action individually with \`verify_against_recording: true\` and \`target_refs: [ref]\` where \`ref\` is the element ref from get_transition_events. This verifies each action targets the exact element the user interacted with, without requiring coverage of all transition events.

4. **Done**: Call done to signal completion.

## Code conventions

- View code: \`async (page) => { ... }\` — returns an object (single) or array of objects (list) with named fields
- Action code: \`async (page, inputs) => { ... }\` — inputs is an object with named parameters, may be empty for simple clicks
- When testing with test_code, write self-contained code with hardcoded sample values: \`async (page) => { await page.locator('input').fill('sample query'); }\`
- Submit the final parameterized version via submit_action: \`async (page, inputs) => { await page.locator('input').fill(inputs.query); }\`
- Use \`page.locator()\` with CSS selectors. Keep code simple and direct.
- NEVER use [href="..."] CSS attribute selectors for links. The replayed DOM has resolved absolute URLs but live sites store relative paths, so href selectors that pass test_code will fail at runtime. Instead use text/role-based selectors: \`page.getByRole('link', { name: 'Create' })\` or \`page.locator('a', { hasText: 'Create' })\`.
- When extracting fields from elements, wrap each field read in try/catch so missing elements return null instead of crashing: \`let text; try { text = await loc.innerText(); } catch { text = null; }\`. Playwright locators are always truthy even when no element matches — never use \`if (locator)\` to check existence.
- url_pattern must be an RFC 6570 URI template. Use {param} for path parameters (e.g. /users/{id}). Use {?param} for query parameters (e.g. /item{?id}). Use {?p1,p2} for multiple query params.
- Use snake_case for all names.

## When stuck

If your code returns empty results or null fields after 2 attempts:
- You are probably guessing at selectors. Stop and use inspect_element on a nearby element from the accessibility tree — request descendant_depth=4 to see the full DOM subtree. Write selectors based on what you see, not what you assume.
- Never submit a view that returned empty data in test_code. An empty view is worse than no view — call done instead.

## Rules

- NEVER submit views for an existing state.
- NEVER submit a view or action whose code hasn't been verified to return non-empty data via test_code. The code you submit must be EXACTLY the code you tested — do NOT modify selectors, clean up code, or "improve" selectors between testing and submission. If test_code passed with \`textarea.lux-naked-input\`, submit that exact selector — do not replace it with \`textarea[name="name"]\` or any other untested selector.
- ONLY submit actions that match actual recorded transition events. Do not invent actions for elements the user didn't interact with.
- If your selectors don't work on the first try, STOP guessing and use inspect_element on the target element's ref to see the actual DOM structure (tag names, classes, attributes). Write selectors based on what inspect_element shows, not assumptions.
- ALWAYS call done when finished. If you stop without calling done, your work is lost.
- After each tool call, briefly note what you found before the next call.

## Intent-driven mode

When you receive an API intent in the task description, focus exclusively on that intent:
- **View intent**: Extract only the described view (business data). Do not extract actions unless they are navigation actions needed to reach the data.
- **Workflow intent**: Extract per-field form actions with \`form_group\` and \`sequence_order\`. Also extract navigation actions needed to reach the form. Do not extract views.
  - The form snapshot's transition events tell you what the user filled — do NOT navigate to every subsequent snapshot to follow intermediate states. Only navigate forward to identify the submit button's destination state (check the last snapshot briefly).
  - Work in a tight loop per field: inspect → test → submit. Do not batch-explore all fields before submitting.
  - You have a limited iteration budget. Complex forms with many fields require efficient execution — submit each action immediately after testing it.
- You have access to all snapshots. Navigate through them to find the relevant states, extract navigation actions along the way, and extract the target view/workflow at the destination.
- Skip snapshots that aren't relevant to your assigned intent.`;

// ---------------------------------------------------------------------------
// Snapshot map builder (for intent-driven mode)
// ---------------------------------------------------------------------------

/**
 * Build a human-readable snapshot map grouped by state, showing which
 * snapshots belong to which states and transition event counts.
 */
function buildSnapshotMap(groups, snapshots, events) {
  if (!groups.length) return "(no snapshots)";

  // Group by state label
  const stateGroups = new Map();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const label = g.stateLabel;
    if (!stateGroups.has(label)) {
      stateGroups.set(label, {
        name: g.stateIdentity?.name || label,
        description: g.stateIdentity?.description || "",
        snapshots: [],
      });
    }
    // Count transition events to next snapshot
    let transitionCount = 0;
    if (i < groups.length - 1) {
      const startIdx = snapshots[i].eventIndex + 1;
      const endIdx = snapshots[i + 1].eventIndex;
      const slice = events.slice(startIdx, endIdx);
      for (const evt of slice) {
        if (evt.type === 3 && (evt.data?.source === 2 || evt.data?.source === 5)) {
          transitionCount++; // MouseInteraction (2) or Input (5)
        }
      }
    }

    stateGroups.get(label).snapshots.push({
      index: i + 1, // 1-based
      url: snapshots[i].url,
      isFirst: g.isFirstOccurrence,
      isTerminal: i >= groups.length - 1,
      transitionEvents: transitionCount,
      nextSnapshotIndex: i < groups.length - 1 ? i + 2 : null,
    });
  }

  const lines = [];
  for (const [label, info] of stateGroups) {
    lines.push(`State "${info.name}" (${label}): ${info.description}`);
    for (const s of info.snapshots) {
      let detail = `  Snapshot #${s.index}: ${s.url}`;
      if (s.isFirst) detail += " (first occurrence)";
      if (s.isTerminal) detail += " (terminal)";
      lines.push(detail);
      if (s.transitionEvents > 0 && s.nextSnapshotIndex) {
        lines.push(`    → ${s.transitionEvents} transition events → snapshot #${s.nextSnapshotIndex}`);
      } else if (s.isTerminal) {
        lines.push(`    → no forward events`);
      }
    }
  }
  return lines.join("\n");
}

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
 * @param {boolean} options.isExistingState — pre-determined by classifier
 * @param {object} [options.stateInfo] — { name, description } from classifier
 * @param {object} [options.intent] — API intent: { id, type, name, description }
 * @param {Array} [options.groups] — classified state groups (for intent-driven context)
 * @param {function} [options.onProgress] — called with { tool } on each tool call
 * @param {string} [options.sessionId]
 * @returns {Promise<{ pendingViews, pendingActions, toolCallCount, error? }>}
 */
export async function runStateAgent({
  index,
  browser,
  manifest,
  events,
  snapshots,
  currentSnapshotIndex,
  isExistingState = false,
  stateInfo,
  intent,
  groups,
  onProgress,
  sessionId,
}) {
  const model = getModel();
  if (!model) {
    return { error: "No LLM provider configured", toolCallCount: 0 };
  }

  // Build the agent context — shared mutable object that tools read/write.
  // State determination is pre-set by the classifier (no submit_state needed).
  const ctx = {
    index,
    browser,
    manifest,
    events,
    snapshots,
    currentSnapshotIndex,
    // Pre-set by classifier (no longer set by submit_state)
    _isExistingState: isExistingState,
    _pendingViews: [],
    _pendingActions: [],
    _done: false,
  };

  let toolCallCount = 0;
  ctx._onProgress = ({ tool }) => {
    toolCallCount++;
    console.log(`[browserwire]   → ${tool}`);
    if (onProgress) onProgress({ tool: `state-agent:${tool}` });
  };

  const tools = getAgentTools(ctx);

  const agentRunName = intent
    ? `browserwire:agent:${intent.name}`
    : `browserwire:agent:snapshot-${currentSnapshotIndex + 1}`;
  const agentTags = intent
    ? ["pass:3", "react-agent", `intent:${intent.name}`, `intent-type:${intent.type}`]
    : ["pass:3", "react-agent", `snapshot:${currentSnapshotIndex + 1}`];
  const agentMetadata = {
    ...(intent ? { intentId: intent.id, intentName: intent.name, intentType: intent.type } : {}),
    snapshotIndex: currentSnapshotIndex,
    stateName: stateInfo?.name || "unknown",
  };

  const agent = createReactAgent({
    llm: model,
    tools,
    prompt: SYSTEM_PROMPT,
    preModelHook: compactMessagesHook,
    name: agentRunName,
  });

  const snapshot = snapshots[currentSnapshotIndex];
  const isTerminal = currentSnapshotIndex >= snapshots.length - 1;

  try {
    let humanText;

    if (intent) {
      // Intent-driven mode: agent builds one API end-to-end
      // Build snapshot map grouped by state
      const snapshotMap = buildSnapshotMap(groups || [], snapshots, events);

      humanText =
        `## Your API Intent\n` +
        `Type: ${intent.type}\n` +
        `Name: ${intent.name}\n` +
        `Goal: ${intent.description}\n\n` +
        `## Snapshot Map\n` +
        `${snapshotMap}\n\n` +
        `## Current Snapshot\n` +
        `You are on Snapshot #${currentSnapshotIndex + 1} (${snapshot.url}).\n` +
        `Use navigate_to_snapshot(snapshot_index) to switch to any snapshot.\n\n` +
        `## Instructions\n` +
        `Build the "${intent.name}" ${intent.type} API end-to-end:\n` +
        `1. Review the snapshot map to find relevant snapshots for your intent.\n` +
        `2. Navigate to each relevant snapshot using navigate_to_snapshot.\n` +
        `3. At each snapshot, use view_screenshot, get_accessibility_tree, and get_transition_events to understand the page.\n` +
        `4. Extract navigation actions for state transitions along the path.\n` +
        `5. Extract the target ${intent.type} at the destination.\n` +
        `6. When testing with verify_against_recording, use target_refs to scope verification to the specific element(s) your action targets.\n` +
        `7. Call done when finished.\n`;
    } else {
      // Legacy mode: per-snapshot extraction
      const stateDesc = isExistingState
        ? `This is an EXISTING state "${stateInfo?.name || "unknown"}". Skip view extraction — only extract new actions from transition events.`
        : `This is a NEW state "${stateInfo?.name || "unknown"}". Extract views (business data) and actions (user interactions), then call done.`;

      humanText =
        `Snapshot #${currentSnapshotIndex + 1} of ${snapshots.length}.\n` +
        `URL: ${snapshot.url}\n` +
        `Title: ${snapshot.title}\n` +
        stateDesc + "\n" +
        (isTerminal ? "This is the LAST snapshot (terminal state — no forward transition events).\n" : "");
    }

    const initialMessages = [new HumanMessage(humanText)];

    // Auto-inject screenshot so the agent always sees it on turn 1
    const screenshotResult = view_screenshot.execute(ctx);
    if (!screenshotResult.error) {
      const syntheticToolCallId = "auto_screenshot";
      initialMessages.push(
        new AIMessage({
          content: "",
          tool_calls: [{ id: syntheticToolCallId, name: "view_screenshot", args: {} }],
        }),
        new ToolMessage({
          content: screenshotResult.content,
          tool_call_id: syntheticToolCallId,
          name: "view_screenshot",
        }),
      );
    }

    await agent.invoke(
      { messages: initialMessages },
      {
        recursionLimit: 200,
        ...(agentTags.length > 0 ? { tags: agentTags } : {}),
        ...(Object.keys(agentMetadata).length > 0 ? { metadata: agentMetadata } : {}),
      }
    );
  } catch (err) {
    return {
      error: `State agent error: ${err.message}`,
      toolCallCount,
      pendingViews: ctx._pendingViews,
      pendingActions: ctx._pendingActions,
    };
  }

  console.log(
    `[browserwire] state-agent: snapshot #${currentSnapshotIndex + 1} done — ` +
    `${isExistingState ? "existing" : "new"} state "${stateInfo?.name || "unknown"}", ` +
    `${ctx._pendingViews.length} views, ${ctx._pendingActions.length} actions, ` +
    `${toolCallCount} tool calls`
  );

  return {
    pendingViews: ctx._pendingViews,
    pendingActions: ctx._pendingActions,
    toolCallCount,
  };
}
