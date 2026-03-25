/**
 * item-agent.js — Phase 2: Item Grounding Sub-Agent (LangGraph)
 *
 * A ReAct agent subgraph that grounds a single skeleton item (view or endpoint)
 * with tested selectors and locators. Multiple instances run in parallel via Send API.
 */

import { HumanMessage } from "@langchain/core/messages";
import { getModel } from "../ai-provider.js";
import { getViewSubAgentTools, getEndpointSubAgentTools } from "../tools/index.js";
import { createReactAgent } from "../graphs/react-agent.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a web page element grounding agent. You receive a single item (a view or endpoint) from a page skeleton, and your job is to discover its fields, find exact CSS selectors, and test them against a real browser.

You have tools to inspect the page's accessibility tree, discover elements, and test selectors via Playwright. Use the skeleton item's region_ref and hints to scope your work.

## For VIEW items (kind: "view")

You must discover what fields exist in the view AND find CSS selectors for them. The skeleton item provides hints.expected_fields as guidance, but you should verify and discover fields from the actual page data.

Follow these steps:

1. **INSPECT**: Call get_accessibility_snapshot(root_ref=region_ref) to see the data structure in the region.
2. **DISCOVER FIELDS**: For list views, call inspect_item_fields on a sample item (use hints.likely_item_ref or find one in the a11y tree) with include_ancestor_height=3 to see available content elements, their CSS selectors, text content, and ancestor chain. Use hints.expected_fields as guidance for naming, but let the actual DOM data drive what fields you include.
3. **BUILD SELECTORS**: From inspect_item_fields results:
   - Use the ancestor chain to identify container_selector and item_selector
   - For each content element that represents a meaningful data field, assign a snake_case name and its CSS selector
   - Include all substantive fields — don't skip fields just because they weren't in hints
4. **BUILD SCHEMA**: Construct an item_schema (JSON Schema) from your discovered fields:
   - type: "object" at top level
   - All property types should be "string" (DOM text extraction yields strings)
   - Mark core data fields as required
   - Set additionalProperties: true
5. **TEST**: Call test_view_extraction with your proposed selectors and expected_first_item (use actual data values you observed from the a11y snapshot). Fix failures up to 3 attempts.
6. **SUBMIT**: Call submit_item with kind="view" and the complete view object including item_schema.

View object schema:
\`\`\`
{
  name: string,              // snake_case (from skeleton)
  description: string,
  isList: boolean,
  item_schema: object,       // JSON Schema — copy from skeleton item
  fields: [{
    name: string,            // snake_case — must match item_schema.properties keys
    type: "string"|"number"|"boolean"|"date",
    selector: string,        // CSS selector within each item
    attribute: string        // Optional: extract attribute instead of text
  }],
  container_selector: string,  // CSS selector for the list/table container
  item_selector: string        // CSS selector for items within the container
}
\`\`\`

## For ENDPOINT items (kind: "endpoint")

Follow these steps:

1. **INSPECT**: Call get_accessibility_snapshot(root_ref=region_ref) to see the interactive elements.
2. **IDENTIFY**: Use get_element_details on the hints.target_ref (or find the element via find_interactive) to get its selector, locator strategies, and form context.
3. **DISCOVER INPUTS**: For form_submit/input endpoints, use find_interactive(near_ref=region_ref, kind="input") and get_element_details on each input to build the inputs array.
4. **TEST**: Call test_endpoint_grounding with the full endpoint shape:
   - trigger_locator: the locator for the trigger element
   - endpoint_kind: the endpoint kind (click, form_submit, etc.)
   - inputs: array of { name, locator, expected_type } for each input
   - expected_trigger_text: the trigger's visible text (e.g. "Submit", "Search")
   This validates: trigger resolves, kind matches, inputs resolve, types match, form coherence.
   Fix failures up to 3 attempts.
5. **SUBMIT**: Call submit_item with kind="endpoint" and the complete endpoint object.

Endpoint object schema:
\`\`\`
{
  name: string,              // snake_case (from skeleton)
  kind: "click"|"form_submit"|"navigation"|"input"|"toggle"|"select",
  description: string,
  selector: string,          // CSS selector (optional if locator provided)
  locator: {                 // Alternative locator (optional if selector provided)
    kind: "css"|"xpath"|"data_testid"|"role_name"|"attribute"|"text",
    value: string
  },
  inputs: [{                 // For forms/inputs
    name: string,
    type: string,
    required: boolean,
    selector: string
  }]
}
\`\`\`

## Rules

- Use snake_case for all names.
- Prefer CSS selectors over XPath. Use data-testid attributes when available.
- NEVER use bare positional selectors (nth-child, :first-child) for view field selectors.
- Field selectors MUST distinguish different fields within an item.
- Use inspect_item_fields to discover available selectors BEFORE proposing field selectors.
- ALWAYS pass expected values when calling test_selector or test_view_extraction.
- Fix failing assertions up to 3 attempts, then use best available and proceed.
- CRITICAL: You MUST call submit_item as your final action. Never end with a text response.
- After submit_item returns valid: true, STOP. Do not call any more tools.

## Context Management
After each tool call, briefly summarize what you've found so far. Include specific data values you'll need as expected values during testing.`;

// ---------------------------------------------------------------------------
// Main item-agent function
// ---------------------------------------------------------------------------

/**
 * Run a sub-agent to ground a single skeleton item (view or endpoint).
 *
 * @param {object} options
 * @param {object} options.item - Skeleton item (kind: "view" or "endpoint")
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} options.index
 * @param {import('../snapshot/playwright-browser.js').PlaywrightBrowser} options.browser
 * @param {function} [options.onProgress]
 * @param {string} [options.sessionId]
 * @returns {Promise<{ item: object|null, kind: string, error?: string, toolCallCount: number }>}
 */
export async function runItemAgent({ item, index, browser, onProgress, sessionId }) {
  const model = getModel();
  if (!model) {
    return { item: null, kind: item.kind, toolCallCount: 0, error: "No LLM provider configured" };
  }

  const kind = item.kind;
  const tools = kind === "view"
    ? getViewSubAgentTools(index, browser)
    : getEndpointSubAgentTools(index, browser);
  const url = index.url || "unknown";
  const title = index.title || "unknown";

  const userMessage = `Ground this ${kind} with tested selectors.

Page URL: ${url}
Page Title: ${title}

Skeleton item:
${JSON.stringify(item, null, 2)}

Use the region_ref and hints to scope your tool calls. Start by inspecting the region, then find/test selectors, then submit.`;

  let toolCallCount = 0;
  const { invoke } = createReactAgent({
    model,
    tools,
    submitToolName: "submit_item",
    systemPrompt: SYSTEM_PROMPT,
    recursionLimit: 102,
    onProgress: ({ tool }) => {
      toolCallCount++;
      if (onProgress) onProgress({ step: toolCallCount, tool });
    },
    agentRole: item.name,
  });

  try {
    const { result, done } = await invoke([new HumanMessage(userMessage)]);

    if (!done || !result?.item) {
      return {
        item: null,
        kind,
        toolCallCount,
        error: `Item agent for "${item.name}" completed ${toolCallCount} tool calls but did not produce a valid ${kind}`,
      };
    }

    return { item: result.item, kind, toolCallCount };
  } catch (err) {
    return { item: null, kind, toolCallCount, error: `Item agent error: ${err.message}` };
  }
}
