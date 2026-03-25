/**
 * index.js — Tool Registry for the Agentic Discovery System
 *
 * Exports all tools with Zod schemas for inputs/outputs and execute functions.
 * Provides LangChain tool() factories for use with LangGraph agents.
 */

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { SnapshotIndex } from "../snapshot/snapshot-index.js";
import {
  getAccessibilitySnapshot,
  getPageRegions,
  findInteractive,
  getElementDetails,
  inspectItemFields,
} from "./query-engine.js";
import {
  testSelector,
  testViewExtraction,
  testEndpointGrounding,
  submitManifest,
  manifestViewSchema,
  manifestEndpointSchema,
  manifestWorkflowSchema,
} from "./testing.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const tools = {
  // ---- Page Understanding ----

  view_screenshot: {
    name: "view_screenshot",
    description: "View the page screenshot. Returns the base64-encoded screenshot image for visual understanding of the page layout.",
    parameters: z.object({}),
    execute: (index, _params) => {
      if (!index.screenshot) {
        return { error: "No screenshot available for this snapshot" };
      }
      return { screenshot: index.screenshot, format: "base64/jpeg" };
    },
  },

  get_accessibility_snapshot: {
    name: "get_accessibility_snapshot",
    description: "Get a YAML-style accessibility tree with ref IDs. Shows: role, name, value, state, children. Each element has a stable ref ID (e.g., e23) for use in other tools. Optionally scope to a subtree by providing root_ref.",
    parameters: z.object({
      root_ref: z.string().optional().describe("Scope to subtree rooted at this ref ID"),
    }),
    execute: (index, params) => getAccessibilitySnapshot(index, params),
  },

  get_page_regions: {
    name: "get_page_regions",
    description: "Get a high-level 'table of contents' of the page — sections with their CDP accessibility roles, headings, child element counts, and whether they contain data lists. Use this first to understand page layout before drilling into specific regions.",
    parameters: z.object({}),
    execute: (index, _params) => getPageRegions(index),
  },

  // ---- Element Discovery ----

  find_interactive: {
    name: "find_interactive",
    description: "Find elements by their accessibility role, optionally filtered by kind (button/link/input/form) or text. Scope to a region with near_ref.",
    parameters: z.object({
      near_ref: z.string().optional().describe("Scope to elements within this ref's subtree"),
      kind: z.enum(["button", "link", "input", "form"]).optional().describe("Filter by element kind"),
      text: z.string().optional().describe("Filter by text content (case-insensitive substring match)"),
    }),
    execute: (index, params) => findInteractive(index, params),
  },

  get_element_details: {
    name: "get_element_details",
    description: "Get detailed information about a specific element by its ref ID. Returns: tag, role, name, text, all attributes, CSS selector, XPath, locator strategies with confidence scores, parent/children refs, and form context if inside a form.",
    parameters: z.object({
      ref: z.string().describe("The ref ID of the element (e.g., 'e23')"),
    }),
    execute: (index, params) => getElementDetails(index, params),
  },

  inspect_item_fields: {
    name: "inspect_item_fields",
    description: "Analyze the internal structure of a list/table item and return CSS selector candidates for each distinct content element within it. Also returns the item's own CSS selector and attributes. Use include_ancestor_height to see ancestor elements (their CSS classes, child counts) — this helps discover the right container_selector and item_selector. Use this on a sample item ref BEFORE proposing field selectors for test_view_extraction.",
    parameters: z.object({
      item_ref: z.string().describe("Ref ID of a list/table item to inspect (e.g., 'e42')"),
      include_ancestor_height: z.number().optional().describe(
        "How many ancestor levels to include. 0 (default) = item only, 3 = item + 3 ancestors, -1 = full branch to root"
      ),
    }),
    execute: (index, params) => inspectItemFields(index, params),
  },

  // ---- Validation / Testing ----

  test_selector: {
    name: "test_selector",
    description: 'Test a selector or locator against the page snapshot. Pass a locator object with kind and value. Supports kind: "css", "xpath", "text", "role_name" (format "role:name", e.g. "button:Submit"), "data_testid", "attribute" (format "attr=value"). Pass expected_count and/or expected_text to get strict pass/fail instead of raw data. Prefer data_testid when available, then css, then role_name/text as fallbacks. If after 3 attempts a selector cannot be validated, skip it and proceed with the best selector you have. Example: { locator: { kind: "css", value: "button.submit" }, expected_count: 1 }',
    parameters: z.object({
      locator: z.object({
        kind: z.enum(["css", "xpath", "text", "role_name", "data_testid", "attribute"]).describe("Selector/locator type"),
        value: z.string().describe("The selector or locator value to test"),
      }).describe("The locator to test"),
      expected_count: z.number().optional().describe("Assert exact match count. When provided, returns pass/fail instead of raw data."),
      expected_text: z.string().optional().describe("Assert first element's text contains this. When provided, returns pass/fail instead of raw data."),
    }),
    execute: (index, params, browser) => testSelector(index, params, browser),
  },

  test_view_extraction: {
    name: "test_view_extraction",
    description: "Simulate a complete view extraction: find a container, find items within it, extract named fields from each item. Pass expected_first_item to get strict pass/fail instead of raw sample rows. Use this to verify your view selectors work end-to-end before submitting the manifest.",
    parameters: z.object({
      container_selector: z.string().describe("CSS selector for the list/table container"),
      item_selector: z.string().optional().describe("CSS selector for individual items within the container (defaults to direct children)"),
      fields: z.array(z.object({
        name: z.string().describe("Field name"),
        selector: z.string().describe("CSS selector for the field within each item"),
        attribute: z.string().optional().describe("Extract an attribute value instead of text content"),
      })).describe("Fields to extract from each item"),
      expected_first_item: z.any().optional().describe("Field name → expected text for the first row. When provided, returns pass/fail with failures instead of raw sample rows."),
    }),
    execute: (index, params, browser) => testViewExtraction(index, params, browser),
  },

  test_endpoint_grounding: {
    name: "test_endpoint_grounding",
    description: "Structurally validate an endpoint's locators against the page snapshot. Checks: trigger resolves to a visible interactive element, trigger tag/role matches the endpoint kind, each input locator resolves, input types match expected types, and form coherence (trigger + inputs in same <form> for form_submit). Pass expected_trigger_text for strict pass/fail assertion mode.",
    parameters: z.object({
      trigger_locator: z.object({
        kind: z.enum(["css", "xpath", "text", "role_name", "data_testid", "attribute"]).describe("Locator type"),
        value: z.string().describe("Locator value"),
      }).describe("Locator for the trigger element (button, link, etc.)"),
      endpoint_kind: z.enum(["click", "form_submit", "navigation", "input", "toggle", "select"]).describe("The endpoint kind — used to validate trigger element matches"),
      inputs: z.array(z.object({
        name: z.string().describe("Input field name"),
        locator: z.object({
          kind: z.enum(["css", "xpath", "text", "role_name", "data_testid", "attribute"]),
          value: z.string(),
        }).describe("Locator for this input field"),
        expected_type: z.enum(["text", "select", "checkbox", "radio", "file", "textarea"]).optional().describe("Expected HTML input type"),
      })).optional().describe("Input fields to validate"),
      expected_trigger_text: z.string().optional().describe("Assert trigger element's text contains this. Enables pass/fail assertion mode."),
    }),
    execute: (index, params, browser) => testEndpointGrounding(index, params, browser),
  },

  submit_manifest: {
    name: "submit_manifest",
    description: "Validate and submit the final manifest. Checks schema validity (Zod), verifies endpoint references in workflows, and checks for duplicate names. Returns validation errors if any.",
    parameters: z.object({
      manifest: z.any().describe("The complete manifest object to validate"),
    }),
    execute: (_index, params) => submitManifest(params),
  },
};

// ---------------------------------------------------------------------------
// Skeleton schema for the planner agent
// ---------------------------------------------------------------------------

const skeletonViewItem = z.object({
  kind: z.literal("view"),
  name: z.string().describe("snake_case name, e.g. product_list"),
  description: z.string(),
  isList: z.boolean(),
  region_ref: z.string().describe("ref ID of the region containing this view"),
  hints: z.object({
    likely_container_ref: z.string().optional().describe("ref ID of the probable list/table container"),
    likely_item_ref: z.string().optional().describe("ref ID of a sample item within the list"),
    expected_fields: z.array(z.string()).describe("Field names the sub-agent should look for"),
  }),
});

const skeletonEndpointItem = z.object({
  kind: z.literal("endpoint"),
  name: z.string().describe("snake_case name, e.g. add_to_cart"),
  description: z.string(),
  endpoint_kind: z.enum(["click", "form_submit", "navigation", "input", "toggle", "select"]),
  region_ref: z.string().describe("ref ID of the region containing this endpoint"),
  hints: z.object({
    target_ref: z.string().optional().describe("ref ID of the interactive element"),
    related_refs: z.array(z.string()).optional().describe("refs of associated inputs/form fields"),
  }),
});

export const skeletonItemSchema = z.discriminatedUnion("kind", [
  skeletonViewItem,
  skeletonEndpointItem,
]);

const skeletonWorkflowStep = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string() }),
  z.object({ type: z.literal("read_view"), view_name: z.string() }),
  z.object({ type: z.literal("fill"), endpoint_name: z.string(), input_param: z.string() }),
  z.object({ type: z.literal("select"), endpoint_name: z.string(), input_param: z.string() }),
  z.object({ type: z.literal("click"), endpoint_name: z.string() }),
  z.object({ type: z.literal("submit"), endpoint_name: z.string() }),
]);

const skeletonWorkflowOutcome = z.object({
  kind: z.enum(["url_change", "element_appears", "text_contains", "element_disappears"]),
  value: z.string(),
});

const skeletonWorkflowPagination = z.object({
  kind: z.enum(["click_next", "scroll"]),
  endpoint_name: z.string().optional().describe("For click_next: which endpoint to click for the next page"),
});

const skeletonWorkflow = z.object({
  name: z.string(),
  kind: z.enum(["read", "write", "mixed"]),
  description: z.string(),
  inputs: z.array(z.object({
    name: z.string(),
    type: z.string(),
    required: z.boolean(),
    description: z.string().optional(),
  })).optional(),
  steps: z.array(skeletonWorkflowStep).min(1),
  outcomes: z.object({
    success: skeletonWorkflowOutcome.optional(),
    failure: skeletonWorkflowOutcome.optional(),
  }).optional(),
  pagination: skeletonWorkflowPagination.optional(),
});

export const skeletonSchema = z.object({
  domain: z.string(),
  domainDescription: z.string(),
  page: z.object({
    name: z.string(),
    routePattern: z.string(),
    description: z.string(),
  }),
  items: z.array(skeletonItemSchema).min(1),
  workflows: z.array(skeletonWorkflow).optional().default([]),
});

// ---------------------------------------------------------------------------
// Planner-only tool: submit_skeleton
// ---------------------------------------------------------------------------

const submitSkeletonTool = {
  name: "submit_skeleton",
  description: "Validate and submit the page skeleton. The skeleton describes what views and endpoints exist on the page, with ref IDs for sub-agents to ground. Returns { valid: true, skeleton } on success or { valid: false, errors } on failure.",
  parameters: z.object({
    skeleton: z.any().describe("The complete skeleton object"),
  }),
  execute: (_index, { skeleton }) => {
    const result = skeletonSchema.safeParse(skeleton);
    if (!result.success) {
      const errors = result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      );
      return { valid: false, errors };
    }

    // Semantic checks
    const errors = [];
    const data = result.data;
    const names = data.items.map((i) => i.name);
    const dups = names.filter((n, i) => names.indexOf(n) !== i);
    if (dups.length > 0) {
      errors.push(`Duplicate item names: ${dups.join(", ")}`);
    }

    // Validate workflow references against item names
    const viewNames = new Set(data.items.filter((i) => i.kind === "view").map((i) => i.name));
    const endpointNames = new Set(data.items.filter((i) => i.kind === "endpoint").map((i) => i.name));
    for (const wf of data.workflows || []) {
      const wfInputNames = new Set((wf.inputs || []).map((i) => i.name));

      if (wf.steps[0]?.type !== "navigate") {
        errors.push(`Workflow "${wf.name}": first step must be "navigate"`);
      }
      if ((wf.kind === "read" || wf.kind === "mixed") && wf.steps[wf.steps.length - 1]?.type !== "read_view") {
        errors.push(`Workflow "${wf.name}": ${wf.kind} workflows must end with "read_view"`);
      }

      for (const step of wf.steps) {
        if (step.view_name && !viewNames.has(step.view_name)) {
          errors.push(`Workflow "${wf.name}" references unknown view: "${step.view_name}"`);
        }
        if (step.endpoint_name && !endpointNames.has(step.endpoint_name)) {
          errors.push(`Workflow "${wf.name}" references unknown endpoint: "${step.endpoint_name}"`);
        }
        if (step.input_param && !wfInputNames.has(step.input_param)) {
          errors.push(`Workflow "${wf.name}" step references unknown input_param: "${step.input_param}"`);
        }
        if (step.type === "navigate") {
          const params = (step.url || "").match(/:[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
          for (const param of params) {
            if (!wfInputNames.has(param.slice(1))) {
              errors.push(`Workflow "${wf.name}" navigate URL has ${param} but no matching input`);
            }
          }
        }
      }

      // Validate click_next pagination: endpoint must be in the same region as the view
      if (wf.pagination?.kind === "click_next" && wf.pagination.endpoint_name) {
        const viewStep = wf.steps.find((s) => s.type === "read_view");
        const viewItem = viewStep ? data.items.find((i) => i.kind === "view" && i.name === viewStep.view_name) : null;
        const paginationEndpoint = data.items.find((i) => i.kind === "endpoint" && i.name === wf.pagination.endpoint_name);
        if (viewItem && paginationEndpoint && viewItem.region_ref !== paginationEndpoint.region_ref) {
          errors.push(
            `Workflow "${wf.name}": click_next endpoint "${wf.pagination.endpoint_name}" is in region ${paginationEndpoint.region_ref} ` +
            `but view "${viewStep.view_name}" is in region ${viewItem.region_ref}. ` +
            `Use { kind: "scroll" } instead — click_next is only for pagination buttons inside the list container.`
          );
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true, skeleton: data };
  },
};

// ---------------------------------------------------------------------------
// Sub-agent tool: submit_item
// ---------------------------------------------------------------------------

const submitItemTool = {
  name: "submit_item",
  description: "Validate and submit a completed manifest fragment (a view or endpoint). Pass kind='view' or kind='endpoint' along with the item object. Returns { valid: true, item } on success or { valid: false, errors } on failure.",
  parameters: z.object({
    kind: z.enum(["view", "endpoint"]).describe("Whether this is a view or endpoint fragment"),
    item: z.any().describe("The complete view or endpoint object"),
  }),
  execute: (_index, { kind, item }) => {
    const schema = kind === "view" ? manifestViewSchema : manifestEndpointSchema;
    const result = schema.safeParse(item);
    if (!result.success) {
      const errors = result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      );
      return { valid: false, errors };
    }
    // List views must have container_selector to avoid page-wide fallback matching
    if (kind === "view" && result.data.isList && !result.data.container_selector) {
      return { valid: false, errors: ["List views require container_selector — re-submit with the container selector you tested"] };
    }
    return { valid: true, item: result.data };
  },
};

// ---------------------------------------------------------------------------
// Convenience: create index + bind tools
// ---------------------------------------------------------------------------

/**
 * Create a SnapshotIndex from raw snapshot data.
 *
 * @param {object} options
 * @param {object} options.rrwebSnapshot - Parsed rrweb snapshot tree
 * @param {import('../snapshot/playwright-browser.js').PlaywrightBrowser} options.browser - Playwright browser instance (required)
 * @param {string|null} [options.screenshot] - Base64 screenshot
 * @param {object[]} [options.networkLogs] - Raw network logs
 * @param {string} [options.url] - Page URL
 * @param {string} [options.title] - Page title
 * @returns {SnapshotIndex}
 */
export const createIndex = (options) => new SnapshotIndex(options);

// ---------------------------------------------------------------------------
// LangChain tool factories — create bound tool() instances for LangGraph agents
// ---------------------------------------------------------------------------

/**
 * Convert a raw tool definition to a LangChain tool() bound to index/browser.
 */
const toLangChainTool = (def, index, browser) =>
  tool(
    async (params) => {
      const result = await def.execute(index, params, browser);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
    { name: def.name, description: def.description, schema: def.parameters }
  );

/**
 * Get planner tools as LangChain tool() instances.
 */
export const getPlannerTools = (index, browser) => [
  toLangChainTool(tools.view_screenshot, index, browser),
  toLangChainTool(tools.get_page_regions, index, browser),
  toLangChainTool(tools.get_accessibility_snapshot, index, browser),
  toLangChainTool(tools.find_interactive, index, browser),
  toLangChainTool(submitSkeletonTool, index, browser),
];

/**
 * Get view sub-agent tools as LangChain tool() instances.
 * View agents get inspect_item_fields + test_view_extraction (not useful for endpoints).
 */
export const getViewSubAgentTools = (index, browser) => [
  toLangChainTool(tools.view_screenshot, index, browser),
  toLangChainTool(tools.get_accessibility_snapshot, index, browser),
  toLangChainTool(tools.get_element_details, index, browser),
  toLangChainTool(tools.inspect_item_fields, index, browser),
  toLangChainTool(tools.test_selector, index, browser),
  toLangChainTool(tools.test_view_extraction, index, browser),
  toLangChainTool(submitItemTool, index, browser),
];

/**
 * Get endpoint sub-agent tools as LangChain tool() instances.
 * Endpoint agents get find_interactive + test_endpoint_grounding (not useful for views).
 */
export const getEndpointSubAgentTools = (index, browser) => [
  toLangChainTool(tools.view_screenshot, index, browser),
  toLangChainTool(tools.get_accessibility_snapshot, index, browser),
  toLangChainTool(tools.get_element_details, index, browser),
  toLangChainTool(tools.find_interactive, index, browser),
  toLangChainTool(tools.test_selector, index, browser),
  toLangChainTool(tools.test_endpoint_grounding, index, browser),
  toLangChainTool(submitItemTool, index, browser),
];

/**
 * Create merge-agent tools as LangChain tool() instances.
 */
export const getMergeTools = (snapshots) => {
  const mergeTools = {
    get_snapshot_manifest: {
      name: "get_snapshot_manifest",
      description: "Fetch the full manifest for a snapshot by its 0-based index.",
      parameters: z.object({ index: z.number().describe("0-based snapshot index") }),
      execute: (_index, { index: idx }) => {
        if (idx < 0 || idx >= snapshots.length) {
          return { error: `Index ${idx} out of range. Valid range: 0–${snapshots.length - 1}` };
        }
        const s = snapshots[idx];
        if (!s.apiSchema) return { error: `Snapshot at index ${idx} has no manifest` };
        return { index: idx, snapshotId: s.snapshotId, url: s.url, title: s.title, trigger: s.trigger?.kind || "unknown", manifest: s.apiSchema };
      },
    },
    submit_site_manifest: {
      name: "submit_site_manifest",
      description: "Validate and submit the merged site-level manifest.",
      parameters: z.object({ manifest: z.any().describe("The complete site-level manifest object") }),
      execute: (_index, { manifest }) => {
        const result = siteManifestSchema.safeParse(manifest);
        if (!result.success) {
          return { valid: false, errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
        }
        // Semantic checks (same as merge-agent.js)
        const errors = [];
        const data = result.data;
        const routes = data.pages.map((p) => p.routePattern);
        const dupRoutes = routes.filter((r, i) => routes.indexOf(r) !== i);
        if (dupRoutes.length > 0) errors.push(`Duplicate routePatterns: ${dupRoutes.join(", ")}`);
        for (const page of data.pages) {
          const vn = page.views.map((v) => v.name);
          const dv = vn.filter((n, i) => vn.indexOf(n) !== i);
          if (dv.length > 0) errors.push(`Page "${page.name}": duplicate views: ${dv.join(", ")}`);
          const en = page.endpoints.map((e) => e.name);
          const de = en.filter((n, i) => en.indexOf(n) !== i);
          if (de.length > 0) errors.push(`Page "${page.name}": duplicate endpoints: ${de.join(", ")}`);
          const viewSet = new Set(vn);
          const epSet = new Set(en);
          for (const wf of page.workflows || []) {
            for (const step of wf.steps) {
              if (step.view_name && !viewSet.has(step.view_name)) errors.push(`Page "${page.name}" workflow "${wf.name}" references unknown view: "${step.view_name}"`);
              if (step.endpoint_name && !epSet.has(step.endpoint_name)) errors.push(`Page "${page.name}" workflow "${wf.name}" references unknown endpoint: "${step.endpoint_name}"`);
            }
          }
        }
        if (errors.length > 0) return { valid: false, errors };
        return { valid: true, manifest: data };
      },
    },
  };

  return Object.values(mergeTools).map((def) =>
    tool(
      async (params) => {
        const result = await def.execute(null, params);
        return typeof result === "string" ? result : JSON.stringify(result);
      },
      { name: def.name, description: def.description, schema: def.parameters }
    )
  );
};

// Site manifest schema (for merge agent validation)
const sitePageSchema = z.object({
  name: z.string(),
  routePattern: z.string(),
  description: z.string(),
  views: z.array(manifestViewSchema),
  endpoints: z.array(manifestEndpointSchema),
  workflows: z.array(manifestWorkflowSchema).optional().default([]),
});

export const siteManifestSchema = z.object({
  domain: z.string(),
  domainDescription: z.string().optional(),
  pages: z.array(sitePageSchema).min(1),
});

export { SnapshotIndex };
