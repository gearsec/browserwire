/**
 * agent.js — Agentic Discovery System
 *
 * Replaces the 3-stage pipeline (vision → network → skeleton) with a single
 * agent that has tools to inspect screenshots, DOM, and network logs together.
 *
 * Uses Vercel AI SDK's ToolLoopAgent for the agent loop.
 */

import { stepCountIs, pruneMessages } from "ai";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getModel } from "./ai-provider.js";
import { createIndex, getToolsForSDK } from "./tools/index.js";
import { getGenerateText } from "../telemetry.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a web page analyzer. Your job is to produce a structured manifest describing the data views, interactive endpoints, and workflows visible on a web page.

You have tools to inspect the page's DOM and accessibility tree. The page screenshot is provided in the user message — use it for visual context. You can call view_screenshot to see it again at any time.

## Workflow

Follow these phases in order:

### 1. ORIENT
- Call get_page_regions to see the page's major sections.
- Look at the screenshot. Identify the domain (e.g. "ecommerce", "project_management") and page purpose.

### 2. MAP DATA
- For regions that contain data (has_data_list: true from get_page_regions):
  1. Call get_accessibility_snapshot(root_ref) scoped to that region.
  2. Identify the list container, item elements, and what fields each item contains.
  3. Call inspect_item_fields on the first item with include_ancestor_height=3 (or -1 for full branch)
     to see the item's CSS selector, attributes, and ancestor chain — use this to identify the
     right container_selector and item_selector from actual CSS classes.
  4. Use the relative_selector values from inspect_item_fields as your field selectors.
- For single-record data (user profiles, detail pages), use get_accessibility_snapshot
  to read the structure directly.
- Use get_element_details(ref) to inspect specific elements when needed (pass the ref ID directly, e.g. ref="e23").

### 3. MAP INTERACTIONS
- Call find_interactive to discover elements by their accessibility roles in each region.
- Use get_element_details for form elements to understand their inputs.
- Identify endpoints: clicks, form submissions, navigations, toggles.
- For each form or interactive group, identify all required inputs:
  - Form fields (text inputs, selects, checkboxes)
  - What data the user must provide to use this endpoint
- Record input names, types, and whether they're required — you'll need these for workflows.

### 4. GROUND & TEST
- Before testing, review your get_accessibility_snapshot and inspect_item_fields results.
  You already know the actual data — use it as expected values.
- Before calling test_view_extraction, use inspect_item_fields on a sample item ref
  to get proper field selectors. Never guess selectors from the accessibility tree.
- For every list view:
  1. Call test_view_extraction with expected_first_item containing the field values
     you observed from get_accessibility_snapshot for the first item.
  2. The tool returns pass: true/false. If false, examine failures and fix selectors.
- If test_view_extraction returns warnings about positional selectors, call inspect_item_fields
  to find better selectors and re-test before submitting.
- For every endpoint:
  1. Call test_selector with a locator object and expected values, e.g.:
     test_selector({ locator: { kind: "css", value: "button.submit" }, expected_count: 1, expected_text: "Submit" })
  2. The tool returns pass: true/false. If false, fix the selector.
- NEVER call test tools without expected values.
- Use get_element_details(ref) on container/item refs to see their CSS selector and attributes before testing. Don't guess class-based selectors from the screenshot.
- Fix failing assertions up to 3 attempts, then use best available and proceed to SUBMIT.
- All selectors must be tested before submission.

### 4.5. SYNTHESIZE WORKFLOWS
- From the views and endpoints you discovered and tested, synthesize workflows.
- Three kinds:
  - **read**: navigate to page → read_view. One per data view.
  - **write**: navigate → fill/select inputs → submit/click. One per form or mutation.
  - **mixed**: navigate → interact (search/filter) → read_view for results.
- **INPUTS — CRITICAL**:
  - Every workflow MUST declare all inputs the caller needs to provide.
  - For parameterized routes: if the page URL contains dynamic segments (IDs, slugs),
    use :param placeholders in the navigate URL (e.g. "/products/:product_id")
    and add a matching input { name: "product_id", type: "string", required: true }.
  - For forms: every fill/select step needs input_param matching an entry in inputs[].
    Derive inputs from the form fields you discovered in MAP INTERACTIONS.
  - For search/filter: the search query or filter value must be an input.
  - Ask yourself: "If an API consumer calls this workflow, what data do they need to provide?"
    Every piece of required data must be in inputs[].
- Rules:
  - First step MUST be { type: "navigate", url: "<routePattern>" }
  - Use parameterized route patterns, not concrete URLs. Replace dynamic segments
    with :param_name (e.g. "/users/:user_id/posts", not "/users/42/posts").
  - read_view MUST be the last step for read/mixed workflows
  - view_name must match a view you defined; endpoint_name must match an endpoint you defined
  - Every :param in navigate URL → matching entry in inputs[]
  - Every fill/select step needs input_param → matching entry in inputs[]
  - Include outcomes (success/failure signals) for write/mixed workflows
  - Skip cosmetic/utility actions (toggle dark mode, close modal, etc.)
- Do NOT call any tools — synthesize from your context summaries.

### 5. SUBMIT
- Call submit_manifest with the complete manifest.
- If it returns errors, fix them and resubmit.
- Once submit_manifest returns valid: true, stop immediately.

## Manifest Schema

\`\`\`
{
  domain: string,           // e.g. "ecommerce", "project_management"
  domainDescription: string, // 1-2 sentences about the site
  page: {
    name: string,           // e.g. "Product List", "Dashboard"
    routePattern: string,   // Parameterized route, e.g. "/products", "/products/:id", "/users/:user_id/posts"
                            // Replace dynamic URL segments with :param_name placeholders
    description: string
  },
  views: [{                 // Data displays (lists, tables, cards, single records)
    name: string,           // snake_case, e.g. "product_list"
    description: string,
    isList: boolean,
    fields: [{
      name: string,         // snake_case
      type: "string"|"number"|"boolean"|"date",
      selector: string,     // CSS selector for the field within each item (optional)
      attribute: string     // Extract attribute instead of text (optional)
    }],
    container_selector: string,  // CSS selector for the list/table container
    item_selector: string        // CSS selector for items within the container
  }],
  endpoints: [{             // Interactive elements (buttons, links, forms)
    name: string,           // snake_case, e.g. "submit_form", "delete_item"
    kind: "click"|"form_submit"|"navigation"|"input"|"toggle"|"select",
    description: string,
    selector: string,       // CSS selector (optional if locator provided)
    locator: {              // Alternative locator (optional if selector provided)
      kind: "css"|"xpath"|"data_testid"|"role_name"|"attribute"|"text",
      value: string
    },
    inputs: [{              // For forms/inputs
      name: string,
      type: string,
      required: boolean,
      selector: string
    }]
  }],
  workflows: [{             // Multi-step user flows
    name: string,
    kind: "read"|"write"|"mixed",
    description: string,
    inputs: [{              // ALL data the caller must provide
      name: string,         // snake_case, e.g. "product_id", "search_query"
      type: string,         // "string", "number", "boolean"
      required: boolean,
      description: string   // What this input is for
    }],
    steps: [               // Ordered steps — first must be "navigate"
      { type: "navigate", url: string },        // route pattern, e.g. "/products/:id"
      { type: "read_view", view_name: string }, // must match a view name
      { type: "fill", endpoint_name: string, input_param: string },
      { type: "select", endpoint_name: string, input_param: string },
      { type: "click", endpoint_name: string },
      { type: "submit", endpoint_name: string }
    ],
    outcomes: {            // Optional success/failure signals
      success: { kind: "url_change"|"element_appears"|"text_contains"|"element_disappears", value: string },
      failure: { kind: "url_change"|"element_appears"|"text_contains"|"element_disappears", value: string }
    }
  }]
}
\`\`\`

## Rules

- Use snake_case for all names (views, endpoints, fields, workflows).
- Every list view MUST have container_selector and item_selector tested via test_view_extraction.
- Every endpoint MUST have a selector or locator tested via test_selector.
- You can call view_screenshot at any time to re-examine the page visually.
- Prefer CSS selectors over XPath. Use data-testid attributes when available.
- Be thorough but efficient — test selectors as you discover them.
- NEVER use bare positional selectors (nth-child, :first-child) for view field selectors.
  Use class names, data-* attributes, tag names, or ARIA roles instead.
- Field selectors MUST distinguish different fields within an item — never use the same
  selector for multiple fields.
- Use inspect_item_fields to discover available selectors before proposing field selectors.
- For dynamic list views, never hardcode specific values in selectors.
- ALWAYS pass expected values when calling test_selector or test_view_extraction.
- ALWAYS use :param placeholders for dynamic URL segments in routePattern and workflow
  navigate URLs. Never use concrete values from the snapshot (e.g., use "/products/:id"
  not "/products/42").
- Every workflow must declare inputs[] for all data the caller needs to provide.
- CRITICAL: You MUST call submit_manifest as your final action. Never end with a text response.
- After submit_manifest returns valid: true, STOP. Do not call any more tools.

## Context Management
After each discovery phase, briefly summarize what you've found so far before your next
tool call. This summary persists even when older tool results are pruned from context.
Include: domain, views found (names + key fields), endpoints found (names + kinds + selectors),
and any selectors that failed testing.
Include specific data values (e.g., first item's field values) in your summaries —
you will need them as expected values during GROUND & TEST.
Include endpoint kinds (click, form_submit, input, etc.) so you can synthesize workflows later.`;

// ---------------------------------------------------------------------------
// Result extraction helper
// ---------------------------------------------------------------------------

/**
 * Extract manifest from agent result. Primary path: last step contains
 * submit_manifest (guaranteed by hasToolCall stop condition). Fallback:
 * reverse-scan all steps if agent hit stepCountIs limit instead.
 */
const extractManifestFromResult = (result) => {
  // Primary path: last step should have submit_manifest
  const lastStep = result.steps[result.steps.length - 1];
  const submitResult = lastStep?.toolResults?.find(
    (r) => r.toolName === "submit_manifest" && r.output?.valid === true
  );
  if (submitResult) return submitResult.output.manifest;

  // Fallback: reverse-scan all steps (agent may have hit step limit)
  for (let i = result.steps.length - 2; i >= 0; i--) {
    const step = result.steps[i];
    for (const toolResult of step.toolResults || []) {
      if (toolResult.toolName === "submit_manifest" && toolResult.output?.valid === true) {
        return toolResult.output.manifest;
      }
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Main agent function
// ---------------------------------------------------------------------------

/**
 * Run the agentic discovery pipeline on a single snapshot.
 *
 * @param {object} options
 * @param {object} options.snapshot - Raw snapshot payload from the extension
 * @param {import('./snapshot/playwright-browser.js').PlaywrightBrowser} options.browser - Playwright browser instance (required)
 * @param {function} [options.onProgress] - Called with { step, tool } on each agent step
 * @returns {Promise<{ manifest: object|null, toolCallCount: number, error?: string }>}
 */
export async function runDiscoveryAgent({ snapshot, browser, onProgress, sessionId }) {
  const model = getModel();
  if (!model) {
    return { manifest: null, toolCallCount: 0, error: "No LLM provider configured" };
  }

  // Parse rrweb snapshot and build index
  let index;
  try {
    const rrwebSnapshot = typeof snapshot.domHtml === "string"
      ? JSON.parse(snapshot.domHtml)
      : snapshot.domHtml;

    index = createIndex({
      rrwebSnapshot,
      browser,
      screenshot: snapshot.screenshot || null,
      networkLogs: snapshot.networkLog || [],
      url: snapshot.url || "",
      title: snapshot.title || "",
    });

    // Enrich with CDP accessibility tree
    await index.enrichWithCDP();

    // Write accessibility tree and rrweb snapshot to logs (fire-and-forget)
    const snapLogDir = resolve(homedir(), ".browserwire", `logs/session-${sessionId}`);
    const snapName = snapshot.snapshotId || "snap";
    mkdir(snapLogDir, { recursive: true })
      .then(() => Promise.all([
        writeFile(
          resolve(snapLogDir, `${snapName}-accessibility-tree.txt`),
          index.toAccessibilityTree(),
          "utf8"
        ),
        writeFile(
          resolve(snapLogDir, `${snapName}-rrweb-snapshot.json`),
          JSON.stringify(rrwebSnapshot, null, 2),
          "utf8"
        ),
      ]))
      .catch((err) => console.error(`[browserwire-cli] failed to write snapshot logs:`, err));
  } catch (err) {
    return { manifest: null, toolCallCount: 0, error: `Failed to build snapshot index: ${err.message}` };
  }

  // Load snapshot into Playwright browser for selector testing (fresh page after CDP enrichment)
  const rrwebSnapshotForPage = typeof snapshot.domHtml === "string"
    ? JSON.parse(snapshot.domHtml)
    : snapshot.domHtml;
  await browser.loadSnapshot(rrwebSnapshotForPage, snapshot.url);

  // Get tools pre-bound to the index (and optional browser)
  const tools = getToolsForSDK(index, browser);

  // Build user message parts
  const userParts = [];

  // Screenshot as vision image
  if (snapshot.screenshot) {
    userParts.push({
      type: "image",
      image: Buffer.from(snapshot.screenshot, "base64"),
    });
  }

  // Text context
  const url = snapshot.url || "unknown";
  const title = snapshot.title || "unknown";

  userParts.push({
    type: "text",
    text: `Analyze this web page and produce a manifest.

URL: ${url}
Title: ${title}`,
  });

  // Run the agent loop
  let toolCallCount = 0;

  const generateText = getGenerateText();
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    tools,
    stopWhen: [
      ({ steps }) => {
        const lastStep = steps[steps.length - 1];
        return lastStep?.toolResults?.some(
          (r) => r.toolName === "submit_manifest" && r.output?.valid === true
        ) ?? false;
      },
      stepCountIs(50),
    ],
    temperature: 0.1,
    messages: [{ role: "user", content: userParts }],
    experimental_context: { domain: null, views: [], endpoints: [], notes: "" },
    prepareStep: ({ stepNumber, messages }) => {
      // First few steps: let context accumulate naturally
      if (stepNumber < 4) return {};

      // Prune tool calls/results from older messages, keep last 3
      const pruned = pruneMessages({
        messages,
        toolCalls: "before-last-3-messages",
        reasoning: "before-last-message",
        emptyMessages: "remove",
      });

      return { messages: pruned };
    },
    experimental_telemetry: {
      isEnabled: true,
      metadata: {
        sessionId: sessionId || "unknown",
        url: snapshot.url || "unknown",
      },
    },
    onStepFinish: ({ toolCalls }) => {
      if (toolCalls) {
        for (const tc of toolCalls) {
          toolCallCount++;
          if (onProgress) {
            onProgress({ step: toolCallCount, tool: tc.toolName });
          }
        }
      }
    },
  });

  // Extract manifest from result
  const manifest = extractManifestFromResult(result);

  if (!manifest) {
    return {
      manifest: null,
      toolCallCount,
      error: `Agent completed ${toolCallCount} tool calls but did not produce a valid manifest`,
    };
  }

  return { manifest, toolCallCount };
}
