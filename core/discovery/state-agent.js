/**
 * state-agent.js — ReAct agent for state machine discovery.
 *
 * Two modes:
 *   - Transition mode (runAgent): writes Playwright code for a single
 *     snapshot transition. Called once per transition by the orchestrator.
 *   - View mode (runViewAgent): extracts business data views from a state.
 *     Called once per new state.
 *
 * The orchestrator (session-processor.js) handles all workflow assembly
 * (form_group, sequence_order, to_state) deterministically.
 */

import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { getTransitionAgentTools, getViewAgentTools } from "./tools-v2/index.js";
import { compactMessagesHook } from "./graphs/utils.js";
import { view_screenshot } from "./tools-v2/query.js";

// ---------------------------------------------------------------------------
// Transition mode prompt
// ---------------------------------------------------------------------------

const TRANSITION_PROMPT = `You are writing Playwright code for a SINGLE user interaction recorded in a browser session.

## Your task

You will receive the transition events between two snapshots — these show exactly what the user did (clicked, typed, checked, etc.). Your job is to:
1. Identify the target element from the transition events
2. Inspect it to understand its DOM structure
3. Write Playwright code that reproduces the interaction
4. Test the code against the recording
5. Return the tested code via done()

## Workflow

1. **Identify the target**: Review the transition events. Find the primary element the user interacted with (the ref with input events, or the clicked ref).
2. **Inspect**: Use inspect_element on the target ref to see tag, attributes, form context.
3. **Write code**: Write a Playwright async function that reproduces the interaction.
   - Text/email/tel/url/textarea: \`page.locator('...').fill(inputs.field_name)\`
   - Native <select>: \`page.locator('select').selectOption(inputs.field_name)\`
   - Custom dropdown (role=combobox): click trigger → wait for listbox → click option
   - Checkbox: \`page.locator('...').setChecked(inputs.field_name)\`
   - Radio: \`page.locator(\\\`input[type="radio"][value="\${inputs.field_name}"]\\\`).check()\`
   - Click/button: \`page.locator('...').click()\` (no inputs needed)
   - Guard optional fields: \`if (inputs.field_name !== undefined)\`
4. **Test**: Use test_code with \`verify_against_recording: true\` and \`target_refs: [ref]\`. If the test fails, inspect the element again and fix the selector.
5. **Return**: Call done(code, inputs) with your tested code and input definitions.

## Code conventions

- Code signature: \`async (page, inputs) => { ... }\`
- When testing with test_code, use hardcoded sample values: \`async (page) => { await page.locator('input').fill('test'); }\`
- For done(), pass the parameterized version: \`async (page, inputs) => { await page.locator('input').fill(inputs.name); }\`
- Use \`page.locator()\` with CSS selectors. Keep code simple and direct.
- NEVER use [href="..."] CSS attribute selectors.
- Use snake_case for input names.

## Rules

- You MUST test your code with test_code before calling done.
- Do NOT inspect elements unrelated to the transition events.
- Do NOT call done without code — if you can't write working code, call done() with no arguments.
- When calling done(), include a snake_case \`name\` (e.g., \`fill_calendar_name\`, \`click_submit_button\`, \`select_color\`) and a one-line \`description\` of what the action does.`;

// ---------------------------------------------------------------------------
// View mode prompt
// ---------------------------------------------------------------------------

const VIEW_PROMPT = `You are extracting business data views from a browser snapshot for a REST API.

## Your task

Write Playwright code that extracts EXACTLY the view described by the intent. Do NOT create additional views beyond what was requested — extract only what the intent specifies. Each view is a function: \`async (page) => { ... }\` that returns the data.

## Budget

You have a LIMITED iteration budget (~30 tool calls). Be efficient:
- **Orient phase: MAX 3 calls** — screenshot (auto-provided) + get_accessibility_tree + 1 inspect_element on a representative item.
- **Then immediately write code** — use test_code to validate, then submit_view.

## Workflow

1. **Orient** (1-3 calls): Review the screenshot (auto-provided), then get_accessibility_tree. Optionally inspect_element on ONE representative element.

2. **Extract views**: Think "what API would this site's team publish?" — extract core business data.

   **What to extract**: Products, prices, ratings, reviews, descriptions, availability, images, URLs — the core business data visible on the page.

   **What NOT to extract**: UI chrome like button labels, input placeholders, navigation links, search form state, page headers/footers.

   **Naming**: Name views after the business domain (e.g., \`products\`, \`product_details\`, \`order_summary\`).

   **Process**: Use inspect_element on a representative element, write extraction code, test it, submit_view. One view at a time.

3. **Done**: Call done() to signal completion.

## Code conventions

- View code: \`async (page) => { ... }\` — returns an object (single) or array of objects (list) with named fields
- Use \`page.locator()\` with CSS selectors. Keep code simple and direct.
- NEVER use [href="..."] CSS attribute selectors.
- Wrap each field read in try/catch so missing elements return null: \`let text; try { text = await loc.innerText(); } catch { text = null; }\`
- url_pattern must be an RFC 6570 URI template.
- Use snake_case for all names.

## Rules

- NEVER submit a view whose code hasn't been verified via test_code to return non-empty data.
- The code you submit must be EXACTLY the code you tested — do NOT modify selectors between testing and submission.
- If selectors don't work, use inspect_element on the target ref to see actual DOM structure.
- Never submit a view that returned empty data in test_code — call done instead.
- ALWAYS call done when finished.`;

// ---------------------------------------------------------------------------
// Shared: auto-inject screenshot into initial messages
// ---------------------------------------------------------------------------

function injectScreenshot(ctx, messages) {
  const screenshotResult = view_screenshot.execute(ctx);
  if (!screenshotResult.error) {
    const syntheticToolCallId = "auto_screenshot";
    messages.push(
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
}

// ---------------------------------------------------------------------------
// Transition mode: runAgent
// ---------------------------------------------------------------------------

/**
 * Run an agent that writes Playwright code for a single snapshot transition.
 * The orchestrator calls this once per transition and wraps the output into an action.
 *
 * @param {object} options
 * @param {object} options.index — SnapshotIndex for the source snapshot
 * @param {object} options.browser — PlaywrightBrowser
 * @param {Array} options.events — full rrweb event stream
 * @param {Array} options.snapshots — snapshot markers
 * @param {number} options.snapshotIndex — source snapshot (transition FROM)
 * @param {Array} options.transitionEvents — pre-computed transition events (enriched)
 * @param {object} [options.stateInfo] — { name, description }
 * @param {function} [options.onProgress]
 * @param {string} [options.sessionId]
 * @returns {Promise<{ code?: string, inputs?: Array, toolCallCount: number, error?: string }>}
 */
export async function runAgent({
  index,
  browser,
  events,
  snapshots,
  snapshotIndex,
  transitionEvents,
  stateInfo,
  eventRange,
  transitionData,
  onProgress,
  sessionId,
  model,
}) {
  if (!model) {
    return { error: "No LLM provider configured", toolCallCount: 0 };
  }

  const ctx = {
    index,
    browser,
    manifest: null,
    events,
    snapshots,
    currentSnapshotIndex: snapshotIndex,
    eventRange: eventRange || null,
    transitionData: transitionData || null,
    _done: false,
    _transitionCode: null,
    _transitionInputs: [],
  };

  let toolCallCount = 0;
  ctx._onProgress = ({ tool }) => {
    toolCallCount++;
    if (onProgress) onProgress({ tool: `transition-agent:${tool}` });
  };

  const tools = getTransitionAgentTools(ctx);
  const snapshot = snapshots[snapshotIndex];

  const agent = createReactAgent({
    llm: model,
    tools,
    prompt: TRANSITION_PROMPT,
    preModelHook: compactMessagesHook,
    name: `browserwire:transition:${snapshotIndex + 1}→${snapshotIndex + 2}`,
  });

  const eventsJson = JSON.stringify(transitionEvents, null, 2);
  const humanText =
    `## Snapshot #${snapshotIndex + 1} → #${snapshotIndex + 2}\n` +
    `URL: ${snapshot.url}\n` +
    `State: ${stateInfo?.name || "unknown"}\n\n` +
    `## Transition Events\n` +
    `\`\`\`json\n${eventsJson}\n\`\`\`\n\n` +
    `Write Playwright code that reproduces the primary interaction shown in these events. ` +
    `Inspect the target element, write code, test it, then call done(code, inputs).`;

  try {
    const initialMessages = [new HumanMessage(humanText)];
    injectScreenshot(ctx, initialMessages);

    await agent.invoke(
      { messages: initialMessages },
      { recursionLimit: 50, tags: ["pass:3", "transition-agent", `snapshot:${snapshotIndex + 1}`] }
    );
  } catch (err) {
    return { error: `Transition agent error: ${err.message}`, toolCallCount };
  }

  console.log(
    `[browserwire] transition-agent: #${snapshotIndex + 1}→#${snapshotIndex + 2} done — ` +
    `${ctx._transitionCode ? "code" : "no code"}, ${toolCallCount} tool calls`
  );

  return {
    code: ctx._transitionCode || undefined,
    inputs: ctx._transitionInputs || [],
    name: ctx._transitionName || undefined,
    description: ctx._transitionDescription || undefined,
    toolCallCount,
  };
}

// ---------------------------------------------------------------------------
// View mode: runViewAgent
// ---------------------------------------------------------------------------

/**
 * Run an agent that extracts business data views from a single snapshot/state.
 *
 * @param {object} options
 * @param {object} options.index — SnapshotIndex
 * @param {object} options.browser — PlaywrightBrowser
 * @param {Array} options.events — full rrweb event stream
 * @param {Array} options.snapshots — snapshot markers
 * @param {number} options.snapshotIndex — which snapshot
 * @param {object} [options.stateInfo] — { name, description }
 * @param {object} [options.intent] — { id, type, name, description }
 * @param {function} [options.onProgress]
 * @param {string} [options.sessionId]
 * @returns {Promise<{ pendingViews: Array, toolCallCount: number, error?: string }>}
 */
export async function runViewAgent({
  index,
  browser,
  events,
  snapshots,
  snapshotIndex,
  stateInfo,
  intent,
  onProgress,
  sessionId,
  model,
}) {
  if (!model) {
    return { error: "No LLM provider configured", toolCallCount: 0 };
  }

  const ctx = {
    index,
    browser,
    manifest: null,
    events,
    snapshots,
    currentSnapshotIndex: snapshotIndex,
    _isExistingState: false,
    _pendingViews: [],
    _done: false,
  };

  let toolCallCount = 0;
  ctx._onProgress = ({ tool }) => {
    toolCallCount++;
    if (onProgress) onProgress({ tool: `view-agent:${tool}` });
  };

  const tools = getViewAgentTools(ctx);
  const snapshot = snapshots[snapshotIndex];

  const agent = createReactAgent({
    llm: model,
    tools,
    prompt: VIEW_PROMPT,
    preModelHook: compactMessagesHook,
    name: `browserwire:view:${intent?.name || stateInfo?.name || snapshotIndex + 1}`,
  });

  const humanText =
    `## State: ${stateInfo?.name || "unknown"}\n` +
    `URL: ${snapshot.url}\n` +
    (intent ? `Intent: ${intent.name} — ${intent.description}\n` : "") +
    `\nExtract business data views from this page. Test each view, submit via submit_view, then call done.`;

  try {
    const initialMessages = [new HumanMessage(humanText)];
    injectScreenshot(ctx, initialMessages);

    await agent.invoke(
      { messages: initialMessages },
      {
        recursionLimit: 100,
        tags: ["pass:3", "view-agent", `snapshot:${snapshotIndex + 1}`],
      }
    );
  } catch (err) {
    return { error: `View agent error: ${err.message}`, toolCallCount, pendingViews: ctx._pendingViews };
  }

  console.log(
    `[browserwire] view-agent: "${stateInfo?.name || "unknown"}" done — ` +
    `${ctx._pendingViews.length} views, ${toolCallCount} tool calls`
  );

  return {
    pendingViews: ctx._pendingViews,
    toolCallCount,
  };
}
