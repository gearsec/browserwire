/**
 * testing.js — Validation/Testing Tools for the Agent
 *
 * Implements tools to close the SeeAct grounding gap:
 * - test_selector: Test selectors/locators via Playwright (real Chromium)
 * - test_view_extraction: Simulate extraction pipeline via Playwright
 * - submit_manifest: Validate a manifest against the Zod schema
 *
 * All selector testing runs through Playwright's Chromium engine.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// test_selector
// ---------------------------------------------------------------------------

/**
 * Test a selector/locator against the indexed snapshot via Playwright.
 *
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} index
 * @param {{ selector: string, kind: string }} params
 * @param {import('../snapshot/playwright-browser.js').PlaywrightBrowser} browser
 * @returns {Promise<{ matches: number, elements: Array<{ ref: string, tag: string, text: string, visible: boolean }> }>}
 */
export const testSelector = async (index, { locator, expected_count, expected_text }, browser) => {
  const { kind, value: selector } = locator;
  try {
    const rrwebIds = (kind === "css")
      ? await browser.querySelectorAll(browser.page, selector)
      : await browser.locateElements(browser.page, kind, selector);

    const elements = rrwebIds.map((id) => {
      const ref = index.rrwebIdToRef.get(id);
      return ref ? index.getNode(ref) : null;
    }).filter(Boolean);

    const base = _formatResult(index, elements);

    // If no assertions requested, return raw result (backward compat)
    if (expected_count == null && expected_text == null) return base;

    // Assertion mode
    const failures = [];

    if (expected_count != null && base.matches !== expected_count) {
      failures.push({ assertion: "expected_count", expected: expected_count, actual: base.matches });
    }

    if (expected_text != null) {
      const firstText = base.elements[0]?.text || "";
      if (!assertContains(firstText, expected_text)) {
        failures.push({ assertion: "expected_text", expected: expected_text, actual: firstText });
      }
    }

    return { pass: failures.length === 0, matches: base.matches, ...(failures.length > 0 ? { failures } : {}) };
  } catch (e) {
    const hasAssertions = expected_count != null || expected_text != null;
    if (hasAssertions) {
      return { pass: false, matches: 0, failures: [{ assertion: "selector_error", expected: selector, actual: e.message }] };
    }
    return { matches: 0, elements: [], error: `Selector error: ${e.message}` };
  }
};

/**
 * Format matched nodes into the standard result shape.
 */
const _formatResult = (index, nodes) => {
  const elements = nodes.map((node) => ({
    ref: node.ref,
    tag: node.tag,
    text: index.getFullText(node.ref).slice(0, 100),
    visible: true,
  }));
  return { matches: elements.length, elements };
};

// ---------------------------------------------------------------------------
// test_view_extraction
// ---------------------------------------------------------------------------

/**
 * Simulate a view extraction pipeline against the snapshot via Playwright.
 * Agent proposes selectors → this tool verifies they work and returns sample data.
 *
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} index
 * @param {{ container_selector: string, item_selector?: string, fields: Array<{ name: string, selector: string, attribute?: string }> }} params
 * @param {import('../snapshot/playwright-browser.js').PlaywrightBrowser} browser
 * @returns {Promise<{ success: boolean, item_count: number, sample_rows: Array<Record<string, string>>, errors: string[] }>}
 */
export const testViewExtraction = async (index, { container_selector, item_selector, fields, expected_first_item }, browser) => {
  const errors = [];

  // Helper: resolve CSS selector to IndexedNodes via Playwright
  const resolveSelector = async (selector, scopeRef) => {
    try {
      const rrwebIds = scopeRef
        ? await browser.page.evaluate(({ sel, scopeRrwebId }) => {
            const mirror = window.__rrwebMirror;
            let scope = document;
            if (scopeRrwebId > 0) {
              const scopeEl = mirror.getNode(scopeRrwebId);
              if (scopeEl) scope = scopeEl;
            }
            const elements = scope.querySelectorAll(sel);
            const ids = [];
            for (const el of elements) {
              const id = mirror.getId(el);
              if (id > 0) ids.push(id);
            }
            return ids;
          }, { sel: selector, scopeRrwebId: _refToRrwebId(index, scopeRef) })
        : await browser.querySelectorAll(browser.page, selector);

      const nodes = rrwebIds.map((id) => {
        const ref = index.rrwebIdToRef.get(id);
        return ref ? index.getNode(ref) : null;
      }).filter(Boolean);

      return { nodes };
    } catch (e) {
      return { nodes: [], error: `Selector error: ${e.message}` };
    }
  };

  // 1. Find container
  const containerResult = await resolveSelector(container_selector);
  if (containerResult.error) {
    return { success: false, item_count: 0, sample_rows: [], errors: [containerResult.error] };
  }
  if (containerResult.nodes.length === 0) {
    return { success: false, item_count: 0, sample_rows: [], errors: [`Container selector "${container_selector}" matched 0 elements`] };
  }
  if (containerResult.nodes.length > 1) {
    errors.push(`Container selector "${container_selector}" matched ${containerResult.nodes.length} elements, using first`);
  }

  const containerRef = containerResult.nodes[0].ref;

  // 2. Find items within container
  let itemNodes;
  if (item_selector) {
    const itemResult = await resolveSelector(item_selector, containerRef);
    if (itemResult.error) {
      return { success: false, item_count: 0, sample_rows: [], errors: [itemResult.error] };
    }
    itemNodes = itemResult.nodes;
  } else {
    itemNodes = index.getChildren(containerRef);
  }

  if (itemNodes.length === 0) {
    return { success: false, item_count: 0, sample_rows: [], errors: [`No items found within container. ${item_selector ? `Item selector "${item_selector}" matched 0 elements.` : "Container has no children."}`] };
  }

  // 3. Extract fields from each item (sample first 5)
  const sampleRows = [];
  const fieldErrors = new Set();

  for (const item of itemNodes.slice(0, 5)) {
    const row = {};

    for (const field of fields) {
      const fieldResult = await resolveSelector(field.selector, item.ref);
      if (fieldResult.error) {
        fieldErrors.add(`Invalid field selector "${field.selector}": ${fieldResult.error}`);
        continue;
      }

      const fieldNode = fieldResult.nodes?.[0] || null;
      if (!fieldNode) {
        fieldErrors.add(`Field "${field.name}" selector "${field.selector}" matched 0 elements in item`);
        row[field.name] = null;
      } else {
        if (field.attribute) {
          row[field.name] = fieldNode.attributes[field.attribute] || null;
        } else {
          row[field.name] = index.getFullText(fieldNode.ref).slice(0, 200);
        }
      }
    }

    sampleRows.push(row);
  }

  errors.push(...fieldErrors);

  // Determine success: at least one row with at least one non-null field
  const hasData = sampleRows.some((row) =>
    Object.values(row).some((v) => v !== null && v !== "")
  );

  // Check for naive positional selectors and warn
  const warnings = [];
  for (const field of fields) {
    if (isPositionalOnly(field.selector)) {
      warnings.push(`Field "${field.name}" uses positional selector "${field.selector}" — use inspect_item_fields to find class/attribute-based selectors`);
    }
  }

  // If no assertions requested, return raw result (backward compat)
  if (!expected_first_item) {
    return {
      success: hasData && fieldErrors.size === 0,
      item_count: itemNodes.length,
      sample_rows: sampleRows,
      errors,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  // Assertion mode: compare expected_first_item against sampleRows[0]
  const firstRow = sampleRows[0] || {};
  const failures = [];

  for (const [field, expectedValue] of Object.entries(expected_first_item)) {
    const actualValue = firstRow[field] ?? "";
    if (!assertContains(String(actualValue), expectedValue)) {
      failures.push({ field, expected: expectedValue, actual: String(actualValue) });
    }
  }

  return {
    pass: failures.length === 0 && hasData && fieldErrors.size === 0,
    item_count: itemNodes.length,
    ...(failures.length > 0 ? { failures } : {}),
    ...(errors.length > 0 ? { errors } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

const normalize = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

const assertContains = (actual, expected) => {
  const a = normalize(actual);
  const e = normalize(expected);
  if (!a || !e) return a === e; // both empty = pass, one empty = fail
  return a.includes(e) || e.includes(a); // bidirectional for truncation
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if a CSS selector consists only of bare tags and positional
 * pseudo-classes (nth-child, nth-of-type, first-child, last-child) without
 * any class (.), id (#), or attribute ([) selectors.
 *
 * Examples:
 *   "div > div:nth-child(1)" → true (positional only)
 *   "div.event-card h3" → false (has class)
 *   "a[href]" → false (has attribute)
 *   "h3" → false (semantic tag alone is fine)
 */
const isPositionalOnly = (selector) => {
  if (!selector) return false;
  // If it contains class, id, or attribute selectors, it's not positional-only
  if (/[.#\[]/.test(selector)) return false;
  // If it contains positional pseudo-classes, it's positional
  if (/:nth-child|:nth-of-type|:first-child|:last-child/.test(selector)) return true;
  // If it's just chained bare tags with combinators (e.g. "div > div > div"), flag it
  // But a single semantic tag like "h3" or "p" is fine
  const segments = selector.split(/\s*>\s*|\s+/).filter(Boolean);
  if (segments.length >= 2 && segments.every((s) => /^\w+$/.test(s))) {
    // All bare tags with combinators — likely fragile if more than 2 levels
    return segments.length > 2;
  }
  return false;
};

/**
 * Convert a ref ID to its rrweb ID for Playwright scoping.
 */
const _refToRrwebId = (index, ref) => {
  if (!ref) return -1;
  const node = index.getNode(ref);
  return node?.rrwebId ?? -1;
};

// ---------------------------------------------------------------------------
// submit_manifest — Zod validation
// ---------------------------------------------------------------------------

/**
 * Manifest schema for validation. Based on extract-api-schema.js + grounding fields.
 */
const manifestViewSchema = z.object({
  name: z.string(),
  description: z.string(),
  isList: z.boolean(),
  isDynamic: z.boolean().optional(),
  fields: z.array(z.object({
    name: z.string(),
    type: z.enum(["string", "number", "boolean", "date"]),
    selector: z.string().optional(),
    attribute: z.string().optional(),
  })),
  container_selector: z.string().optional(),
  item_selector: z.string().optional(),
});

const manifestEndpointSchema = z.object({
  name: z.string(),
  kind: z.enum(["click", "form_submit", "navigation", "input", "toggle", "select"]),
  description: z.string(),
  selector: z.string().optional(),
  locator: z.object({
    kind: z.enum(["css", "xpath", "data_testid", "role_name", "attribute", "text"]),
    value: z.string(),
  }).optional(),
  inputs: z.array(z.object({
    name: z.string(),
    type: z.string(),
    required: z.boolean(),
    selector: z.string().optional(),
  })).optional(),
});

const workflowStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string() }),
  z.object({ type: z.literal("read_view"), view_name: z.string() }),
  z.object({ type: z.literal("fill"), endpoint_name: z.string(), input_param: z.string() }),
  z.object({ type: z.literal("select"), endpoint_name: z.string(), input_param: z.string() }),
  z.object({ type: z.literal("click"), endpoint_name: z.string() }),
  z.object({ type: z.literal("submit"), endpoint_name: z.string() }),
]);

const workflowOutcomeSignal = z.object({
  kind: z.enum(["url_change", "element_appears", "text_contains", "element_disappears"]),
  value: z.string(),
});

const manifestWorkflowSchema = z.object({
  name: z.string(),
  kind: z.enum(["read", "write", "mixed"]),
  description: z.string(),
  inputs: z.array(z.object({
    name: z.string(),
    type: z.string(),
    required: z.boolean(),
    description: z.string().optional(),
  })).optional(),
  steps: z.array(workflowStepSchema).min(1),
  outcomes: z.object({
    success: workflowOutcomeSignal.optional(),
    failure: workflowOutcomeSignal.optional(),
  }).optional(),
});

const manifestSchema = z.object({
  domain: z.string(),
  domainDescription: z.string().optional(),
  page: z.object({
    name: z.string(),
    routePattern: z.string(),
    description: z.string(),
  }),
  views: z.array(manifestViewSchema),
  endpoints: z.array(manifestEndpointSchema),
  workflows: z.array(manifestWorkflowSchema).optional(),
});

/**
 * Validate a manifest against the schema.
 *
 * @param {{ manifest: object }} params
 * @returns {{ valid: boolean, errors?: string[] }}
 */
export const submitManifest = ({ manifest }) => {
  const result = manifestSchema.safeParse(manifest);
  if (result.success) {
    // Additional semantic checks
    const errors = [];

    // Validate workflows
    const endpointNames = new Set(result.data.endpoints.map((e) => e.name));
    const viewNames_ = new Set(result.data.views.map((v) => v.name));
    for (const workflow of result.data.workflows || []) {
      const wfInputNames = new Set((workflow.inputs || []).map((i) => i.name));

      // First step must be navigate
      if (workflow.steps[0]?.type !== "navigate") {
        errors.push(`Workflow "${workflow.name}": first step must be "navigate"`);
      }

      // read/mixed workflows must end with read_view
      if ((workflow.kind === "read" || workflow.kind === "mixed") &&
          workflow.steps[workflow.steps.length - 1]?.type !== "read_view") {
        errors.push(`Workflow "${workflow.name}": ${workflow.kind} workflows must end with "read_view"`);
      }

      // write workflows must have at least one interaction step
      if (workflow.kind === "write") {
        const hasInteraction = workflow.steps.some((s) =>
          ["fill", "select", "click", "submit"].includes(s.type));
        if (!hasInteraction) {
          errors.push(`Workflow "${workflow.name}": write workflows must have at least one interaction step`);
        }
      }

      for (const step of workflow.steps) {
        // endpoint_name references must exist
        if (step.endpoint_name && !endpointNames.has(step.endpoint_name)) {
          errors.push(`Workflow "${workflow.name}" references unknown endpoint: "${step.endpoint_name}"`);
        }
        // view_name references must exist
        if (step.view_name && !viewNames_.has(step.view_name)) {
          errors.push(`Workflow "${workflow.name}" references unknown view: "${step.view_name}"`);
        }
        // input_param on fill/select must match inputs[]
        if (step.input_param && !wfInputNames.has(step.input_param)) {
          errors.push(`Workflow "${workflow.name}" step references unknown input_param: "${step.input_param}"`);
        }
        // Navigate URL :param placeholders must match inputs[]
        if (step.type === "navigate") {
          const params = (step.url || "").match(/:[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
          for (const param of params) {
            const paramName = param.slice(1);
            if (!wfInputNames.has(paramName)) {
              errors.push(`Workflow "${workflow.name}" navigate URL has :${paramName} but no matching input`);
            }
          }
        }
      }
    }

    // Check for duplicate names
    const viewNames = result.data.views.map((v) => v.name);
    const dupViews = viewNames.filter((n, i) => viewNames.indexOf(n) !== i);
    if (dupViews.length > 0) {
      errors.push(`Duplicate view names: ${dupViews.join(", ")}`);
    }

    const epNames = result.data.endpoints.map((e) => e.name);
    const dupEps = epNames.filter((n, i) => epNames.indexOf(n) !== i);
    if (dupEps.length > 0) {
      errors.push(`Duplicate endpoint names: ${dupEps.join(", ")}`);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true, manifest: result.data };
  }

  // Parse Zod errors into readable messages
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return `${path}: ${issue.message}`;
  });

  return { valid: false, errors };
};

export { manifestSchema, manifestViewSchema, manifestEndpointSchema, manifestWorkflowSchema };
