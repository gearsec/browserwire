/**
 * planner.js — Phase 1: Skeleton Planner Agent (LangGraph)
 *
 * A ReAct agent subgraph that inspects the page via read-only tools and
 * produces a structured skeleton describing views, endpoints, and workflows.
 */

import { HumanMessage } from "@langchain/core/messages";
import { getModel } from "./ai-provider.js";
import { getPlannerTools } from "./tools/index.js";
import { createReactAgent } from "./graphs/react-agent.js";

// ---------------------------------------------------------------------------
// System prompt (unchanged from before)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a web page structure analyzer. Your job is to inspect a web page and produce a structured skeleton describing the data views and interactive endpoints visible on it.

You have tools to inspect the page — use them to understand the layout, identify data regions, and discover interactive elements. You do NOT need to test selectors or extract field details — sub-agents will handle that.

## Workflow

### 1. ORIENT
- Call view_screenshot to see the page visually.
- Call get_page_regions to see the page's major sections (roles, headings, data lists).
- Identify the domain (e.g. "ecommerce", "project_management") and page purpose.

### 2. IDENTIFY VIEWS
- For regions with has_data_list: true, call get_accessibility_snapshot(root_ref) to understand the data structure.
- Identify each distinct data display: lists, tables, card grids, detail records.
- For each view, note:
  - A descriptive snake_case name (e.g. "product_list", "user_profile")
  - Whether it's a list (isList: true) or single record (isList: false)
  - The region_ref (ref ID of the containing region)
  - Hints: likely_container_ref, likely_item_ref (from the a11y tree), and expected field names

### 3. IDENTIFY ENDPOINTS
- Call find_interactive to discover buttons, links, inputs, and forms.
- For complex regions, call get_accessibility_snapshot(root_ref) to understand form structures.
- For each interactive element or group, note:
  - A descriptive snake_case name (e.g. "add_to_cart", "search_form")
  - The endpoint_kind (click, form_submit, navigation, input, toggle, select)
  - The region_ref
  - Hints: target_ref (the interactive element), related_refs (associated form inputs)
- Skip cosmetic/utility interactions (dark mode toggles, cookie banners, etc.)

### 4. SYNTHESIZE WORKFLOWS
- From the views and endpoints you identified, synthesize workflows. Do NOT call any tools — synthesize from your context summaries.
- Three kinds:
  - **read**: navigate to page → read_view. One per data view.
  - **write**: navigate → fill/select inputs → submit/click. One per form or mutation endpoint.
  - **mixed**: navigate → interact (search/filter) → read_view for results.
- **INPUTS — CRITICAL**:
  - Every workflow MUST declare all inputs the caller needs to provide.
  - For parameterized routes: use :param placeholders in the navigate URL and add matching inputs.
  - For forms: every fill/select step needs input_param matching an entry in inputs[].
  - For search/filter: the search query or filter value must be an input.
- **PAGINATION — for read workflows that read list views**:
  - MUST include an optional limit input: { name: "limit", type: "number", required: false, description: "Maximum number of items to return" }
  - MUST include a pagination object describing how to get more results:
    - Use { kind: "click_next", endpoint_name: "<the_pagination_endpoint>" } ONLY if there is a "Next" / "Load More" / numbered-page button that is **directly associated with the view's data list** (i.e., inside or immediately adjacent to the list container — NOT a carousel arrow, slider control, or navigation for a different section of the page)
    - Use { kind: "scroll" } for infinite-scroll feeds, or when no pagination button is directly tied to the list view. When in doubt, prefer "scroll" — most modern feeds use infinite scroll.
  - The execution engine will use pagination to fetch more items until the limit is reached
- Rules:
  - First step MUST be { type: "navigate", url: "<routePattern>" }
  - read_view MUST be the last step for read/mixed workflows
  - view_name must match a view item you defined; endpoint_name must match an endpoint item you defined
  - Every :param in navigate URL → matching entry in inputs[]
  - Every fill/select step needs input_param → matching entry in inputs[]
  - Include outcomes (success/failure signals) for write/mixed workflows
  - Skip cosmetic/utility actions (toggle dark mode, close modal, etc.)

### 5. SUBMIT
- Call submit_skeleton with the complete skeleton (including workflows).
- If it returns errors, fix them and resubmit.
- Once submit_skeleton returns valid: true, stop immediately.

## Skeleton Schema

\`\`\`
{
  domain: string,              // e.g. "ecommerce", "project_management"
  domainDescription: string,   // 1-2 sentences about the site
  page: {
    name: string,              // e.g. "Product List", "Dashboard"
    routePattern: string,      // Parameterized route, e.g. "/products", "/products/:id"
    description: string
  },
  items: [
    // For data views:
    {
      kind: "view",
      name: string,            // snake_case
      description: string,
      isList: boolean,
      region_ref: string,      // ref ID of containing region
      hints: {
        likely_container_ref?: string,
        likely_item_ref?: string,
        expected_fields: string[]   // field names to look for
      }
    },
    // For interactive endpoints:
    {
      kind: "endpoint",
      name: string,            // snake_case
      description: string,
      endpoint_kind: "click"|"form_submit"|"navigation"|"input"|"toggle"|"select",
      region_ref: string,
      hints: {
        target_ref?: string,        // ref of the interactive element
        related_refs?: string[]     // refs of associated inputs
      }
    }
  ],
  workflows: [                   // Multi-step user flows
    {
      name: string,              // snake_case
      kind: "read"|"write"|"mixed",
      description: string,
      inputs: [{                 // ALL data the caller must provide
        name: string,
        type: string,            // "string", "number", "boolean"
        required: boolean,
        description: string
      }],
      steps: [                   // Ordered steps — first must be "navigate"
        { type: "navigate", url: string },
        { type: "read_view", view_name: string },
        { type: "fill", endpoint_name: string, input_param: string },
        { type: "select", endpoint_name: string, input_param: string },
        { type: "click", endpoint_name: string },
        { type: "submit", endpoint_name: string }
      ],
      outcomes: {                // Optional success/failure signals
        success: { kind: "url_change"|"element_appears"|"text_contains"|"element_disappears", value: string },
        failure: { kind: ..., value: string }
      },
      pagination: {              // For read/mixed list workflows — how to get more results
        kind: "click_next"|"scroll",
        endpoint_name: string    // For click_next: which endpoint to click
      }
    }
  ]
}
\`\`\`

## Rules

- Use snake_case for all names.
- Use :param placeholders for dynamic URL segments in routePattern (e.g. "/products/:id", not "/products/42").
- Include ALL visible data views — don't skip small or single-record views.
- Include ALL meaningful interactive elements — buttons, forms, search, filters, navigation links.
- Skip cosmetic/utility interactions (theme toggles, cookie banners, scroll-to-top, etc.).
- Every item MUST have a valid region_ref from the accessibility tree.
- Provide helpful hints (container refs, item refs, target refs) from what you see in the a11y tree — these help sub-agents work faster.
- Workflow view_name and endpoint_name references MUST match item names you defined.
- CRITICAL: You MUST call submit_skeleton to complete your task. The ONLY way to finish is by calling this tool. Do NOT output the skeleton as text — text responses are ignored. If you respond without calling submit_skeleton, your work is lost.
- After submit_skeleton returns valid: true, STOP. Do not call any more tools.
- If submit_skeleton returns errors, fix them and call submit_skeleton again.

## Context Management
After each tool call, briefly summarize what you've found so far before your next tool call. Include: domain, views identified (name + region_ref), endpoints identified (name + kind + region_ref).
Include endpoint kinds (click, form_submit, input, etc.) so you can synthesize workflows later.`;

// ---------------------------------------------------------------------------
// Main planner function
// ---------------------------------------------------------------------------

/**
 * Run the planner agent to produce a skeleton for a snapshot.
 *
 * @param {object} options
 * @param {import('./snapshot/snapshot-index.js').SnapshotIndex} options.index
 * @param {object} options.snapshot - Raw snapshot payload
 * @param {import('./snapshot/playwright-browser.js').PlaywrightBrowser} options.browser
 * @param {function} [options.onProgress]
 * @param {string} [options.sessionId]
 * @returns {Promise<{ skeleton: object|null, toolCallCount: number, error?: string }>}
 */
export async function runPlanner({ index, snapshot, browser, onProgress, sessionId }) {
  const model = getModel();
  if (!model) {
    return { skeleton: null, toolCallCount: 0, error: "No LLM provider configured" };
  }

  const tools = getPlannerTools(index, browser);
  const url = snapshot.url || "unknown";
  const title = snapshot.title || "unknown";

  let toolCallCount = 0;
  const { invoke } = createReactAgent({
    model,
    tools,
    submitToolName: "submit_skeleton",
    systemPrompt: SYSTEM_PROMPT,
    recursionLimit: 42,
    onProgress: ({ tool }) => {
      toolCallCount++;
      if (onProgress) onProgress({ step: toolCallCount, tool });
    },
    agentRole: "planner",
  });

  try {
    const { result, done } = await invoke([
      new HumanMessage(`Analyze this web page and produce a skeleton describing its views and endpoints.\n\nURL: ${url}\nTitle: ${title}`),
    ]);

    if (!done || !result?.skeleton) {
      return {
        skeleton: null,
        toolCallCount,
        error: `Planner completed ${toolCallCount} tool calls but did not produce a valid skeleton`,
      };
    }

    return { skeleton: result.skeleton, toolCallCount };
  } catch (err) {
    return { skeleton: null, toolCallCount, error: `Planner error: ${err.message}` };
  }
}
