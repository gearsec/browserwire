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

  // Helper: resolve sibling-relative selectors (+ or ~ combinators)
  // e.g. "+ tr > td.subtext > span.score" starts from the item element and
  // navigates to its sibling, then queries within that sibling.
  const resolveSiblingSelector = async (selector, itemRef) => {
    try {
      const rrwebIds = await browser.page.evaluate(({ sel, itemRrwebId }) => {
        const mirror = window.__rrwebMirror;
        const itemEl = mirror.getNode(itemRrwebId);
        if (!itemEl) return [];

        // Build a temporary wrapper approach: create a CSS selector that
        // chains from the item. We use the item as the starting point.
        // For "+ selector", we need the item's next sibling, then query within.
        // For "~ selector", we need any following sibling.
        let target = null;
        const trimmed = sel.trimStart();

        if (trimmed.startsWith("+")) {
          // Adjacent sibling: get the remainder after "+"
          const remainder = trimmed.slice(1).trimStart();
          // Split into the sibling selector and the descendant part
          // e.g. "tr > td.subtext > span.score" → sibling is next element, query "td.subtext > span.score" in it
          // But we can also let the browser handle it by querying from the parent
          // using :scope to reference the item
          const parent = itemEl.parentElement;
          if (parent) {
            // Find the item's index among siblings, then use nth-child to scope
            const siblings = Array.from(parent.children);
            const idx = siblings.indexOf(itemEl);
            if (idx >= 0 && idx < siblings.length - 1) {
              // Query the remainder relative to the next sibling
              const nextSibling = siblings[idx + 1];
              // If remainder starts with a tag/selector, check if the sibling matches
              // Then query descendants within it
              // Simplest: use the full selector from parent context
              // Build: itemEl + remainder as a CSS selector from parent scope
              // But CSS doesn't let us scope to a specific child easily.
              // Instead: navigate manually.
              const parts = remainder.split(/\s*>\s*|\s+/);
              // The first part might be a tag/class matching the sibling itself
              const siblingSelector = parts[0];
              if (nextSibling.matches(siblingSelector)) {
                if (parts.length === 1) {
                  target = nextSibling;
                } else {
                  // Query the rest within the sibling
                  const restSelector = parts.slice(1).join(" > ");
                  target = nextSibling.querySelector(restSelector);
                }
              }
            }
          }
        }

        if (!target) return [];
        const id = mirror.getId(target);
        return id > 0 ? [id] : [];
      }, { sel: selector, itemRrwebId: _refToRrwebId(index, itemRef) });

      const nodes = rrwebIds.map((id) => {
        const ref = index.rrwebIdToRef.get(id);
        return ref ? index.getNode(ref) : null;
      }).filter(Boolean);

      return { nodes };
    } catch (e) {
      return { nodes: [], error: `Sibling selector error: ${e.message}` };
    }
  };

  const isSiblingSelector = (sel) => /^\s*[+~]/.test(sel);

  // 3. Extract fields from each item (sample first 5)
  const sampleRows = [];
  const fieldErrors = new Set();

  for (const item of itemNodes.slice(0, 5)) {
    const row = {};

    for (const field of fields) {
      // Use sibling-aware resolution if selector starts with + or ~
      const fieldResult = isSiblingSelector(field.selector)
        ? await resolveSiblingSelector(field.selector, item.ref)
        : await resolveSelector(field.selector, item.ref);
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

  // If no assertions requested, return raw result
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
  item_schema: z.any().optional().describe("JSON Schema defining the structure of each extracted item"),
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

const workflowPaginationSchema = z.object({
  kind: z.enum(["click_next", "scroll"]),
  endpoint_name: z.string().optional().describe("For click_next: which endpoint to click for the next page"),
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
  pagination: workflowPaginationSchema.optional(),
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

// ---------------------------------------------------------------------------
// test_endpoint_grounding
// ---------------------------------------------------------------------------

/**
 * Resolve a locator to rrweb IDs using the same paths as testSelector.
 */
const _resolveLocator = async (browser, { kind, value }) => {
  return (kind === "css")
    ? browser.querySelectorAll(browser.page, value)
    : browser.locateElements(browser.page, kind, value);
};

/**
 * Gather element metadata from reconstructed DOM for a set of rrweb IDs.
 * Returns tag, type, role, text, visibility, and form ancestor rrwebId.
 */
const _getElementMeta = async (browser, rrwebIds) => {
  return browser.page.evaluate((ids) => {
    const mirror = window.__rrwebMirror;
    return ids.map((id) => {
      const el = mirror.getNode(id);
      if (!el || el.nodeType !== 1) return null;
      const cs = getComputedStyle(el);
      // Walk up to find <form> ancestor
      let formRrwebId = null;
      let p = el.parentElement;
      while (p) {
        if (p.tagName === "FORM") { formRrwebId = mirror.getId(p); break; }
        p = p.parentElement;
      }
      return {
        rrwebId: id,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type"),
        role: el.getAttribute("role"),
        text: (el.textContent || "").trim().slice(0, 100),
        visible: cs.display !== "none" && cs.visibility !== "hidden",
        formRrwebId,
      };
    }).filter(Boolean);
  }, rrwebIds);
};

/**
 * Check if an element tag/role is interactive (clickable trigger).
 */
const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea", "summary"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "tab", "menuitem", "switch", "checkbox", "radio", "option"]);

const _isInteractive = (meta) => {
  if (!meta) return false;
  return INTERACTIVE_TAGS.has(meta.tag) ||
    INTERACTIVE_ROLES.has(meta.role) ||
    meta.type === "submit";
};

/**
 * Expected trigger tags/roles by endpoint kind.
 */
const TRIGGER_KIND_MATCH = {
  click: { tags: ["button", "a", "div", "span", "img", "summary"], roles: ["button", "link", "tab", "menuitem", "switch"] },
  form_submit: { tags: ["button", "input", "form"], roles: ["button"], types: ["submit"] },
  navigation: { tags: ["a", "button"], roles: ["link", "button"] },
  input: { tags: ["input", "textarea", "select"], roles: ["textbox", "combobox", "searchbox", "spinbutton"] },
  toggle: { tags: ["button", "input", "div", "span"], roles: ["switch", "checkbox", "button"] },
  select: { tags: ["select", "input", "div", "ul"], roles: ["combobox", "listbox", "radiogroup"] },
};

const _triggerKindMatches = (meta, endpointKind) => {
  if (!meta) return true;
  const expected = TRIGGER_KIND_MATCH[endpointKind];
  if (!expected) return true; // unknown kind — skip check
  if (expected.tags.includes(meta.tag)) return true;
  if (expected.roles?.includes(meta.role)) return true;
  if (expected.types?.includes(meta.type)) return true;
  return false;
};

/**
 * Expected input element types.
 */
const INPUT_TYPE_MATCH = {
  text: { tags: ["input", "textarea"], types: ["text", "email", "password", "search", "tel", "url", "number", null] },
  select: { tags: ["select"], roles: ["combobox", "listbox"] },
  checkbox: { tags: ["input"], types: ["checkbox"], roles: ["checkbox"] },
  radio: { tags: ["input"], types: ["radio"], roles: ["radio"] },
  file: { tags: ["input"], types: ["file"] },
  textarea: { tags: ["textarea"] },
};

const _inputTypeMatches = (meta, expectedType) => {
  if (!meta) return false;
  const expected = INPUT_TYPE_MATCH[expectedType];
  if (!expected) return true; // unknown type — skip check
  if (expected.tags?.includes(meta.tag)) {
    // For tags that need further type checking (input)
    if (meta.tag === "input" && expected.types) {
      return expected.types.includes(meta.type);
    }
    return true;
  }
  if (expected.roles?.includes(meta.role)) return true;
  return false;
};

/**
 * Structurally validate an endpoint's locators against the rrweb snapshot.
 *
 * Checks: trigger resolves, kind matches, inputs resolve, input types match,
 * form coherence (trigger + inputs in same <form>).
 *
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} index
 * @param {{ trigger_locator: object, endpoint_kind: string, inputs?: Array, expected_trigger_text?: string }} params
 * @param {import('../snapshot/playwright-browser.js').PlaywrightBrowser} browser
 */
export const testEndpointGrounding = async (index, { trigger_locator, endpoint_kind, inputs, expected_trigger_text }, browser) => {
  const failures = [];
  const warnings = [];

  // --- Resolve trigger ---
  let triggerMeta = null;
  try {
    const triggerIds = await _resolveLocator(browser, trigger_locator);
    if (triggerIds.length === 0) {
      failures.push({ check: "trigger_not_found", locator: trigger_locator });
    } else if (triggerIds.length > 1) {
      warnings.push(`Trigger locator matched ${triggerIds.length} elements, using first`);
    }

    if (triggerIds.length > 0) {
      const metas = await _getElementMeta(browser, [triggerIds[0]]);
      triggerMeta = metas[0] || null;
    }
  } catch (e) {
    failures.push({ check: "trigger_error", message: e.message });
  }

  let triggerResult = null;
  if (triggerMeta) {
    const ref = index.rrwebIdToRef.get(triggerMeta.rrwebId) || null;
    triggerResult = {
      found: true,
      tag: triggerMeta.tag,
      text: triggerMeta.text,
      ref,
      visible: triggerMeta.visible,
      interactive: _isInteractive(triggerMeta),
    };

    if (!triggerMeta.visible) {
      failures.push({ check: "trigger_not_visible" });
    }
    if (!_isInteractive(triggerMeta)) {
      warnings.push(`Trigger element <${triggerMeta.tag}> may not be interactive`);
    }
    if (!_triggerKindMatches(triggerMeta, endpoint_kind)) {
      failures.push({
        check: "trigger_kind_mismatch",
        endpoint_kind,
        actual_tag: triggerMeta.tag,
        actual_role: triggerMeta.role,
      });
    }
  }

  // --- Resolve inputs ---
  const inputResults = [];
  const inputFormIds = [];

  for (const input of inputs || []) {
    const { name, locator, expected_type } = input;
    try {
      const ids = await _resolveLocator(browser, locator);
      if (ids.length === 0) {
        failures.push({ check: "input_not_found", input: name, locator });
        inputResults.push({ name, found: false });
        continue;
      }

      const metas = await _getElementMeta(browser, [ids[0]]);
      const meta = metas[0];
      if (!meta) {
        failures.push({ check: "input_not_found", input: name });
        inputResults.push({ name, found: false });
        continue;
      }

      const ref = index.rrwebIdToRef.get(meta.rrwebId) || null;
      const typeMatched = expected_type ? _inputTypeMatches(meta, expected_type) : true;
      if (expected_type && !typeMatched) {
        failures.push({
          check: "input_type_mismatch",
          input: name,
          expected: expected_type,
          actual: meta.tag + (meta.type ? `[type=${meta.type}]` : ""),
        });
      }

      inputFormIds.push(meta.formRrwebId);
      inputResults.push({
        name,
        found: true,
        tag: meta.tag,
        inputType: meta.type || meta.tag,
        ref,
        matched_type: typeMatched,
      });
    } catch (e) {
      failures.push({ check: "input_error", input: name, message: e.message });
      inputResults.push({ name, found: false });
    }
  }

  // --- Form coherence ---
  let formCoherence = true;
  if (endpoint_kind === "form_submit" && triggerMeta && inputFormIds.length > 0) {
    const triggerFormId = triggerMeta.formRrwebId;
    for (let i = 0; i < inputFormIds.length; i++) {
      const inputFormId = inputFormIds[i];
      if (triggerFormId !== inputFormId) {
        formCoherence = false;
        const inputName = inputResults[i]?.name || `input[${i}]`;
        failures.push({
          check: "form_coherence",
          message: `trigger and input '${inputName}' not in same form`,
        });
      }
    }
  }

  // --- Assertion: expected_trigger_text ---
  if (expected_trigger_text && triggerMeta) {
    if (!assertContains(triggerMeta.text, expected_trigger_text)) {
      failures.push({
        check: "trigger_text_mismatch",
        expected: expected_trigger_text,
        actual: triggerMeta.text,
      });
    }
  }

  // --- Return ---
  if (expected_trigger_text != null) {
    // Assertion mode
    return {
      pass: failures.length === 0,
      ...(failures.length > 0 ? { failures } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  // Raw mode
  return {
    trigger: triggerResult || { found: false },
    inputs: inputResults,
    form_coherence: formCoherence,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(failures.length > 0 ? { errors: failures } : {}),
  };
};

export { manifestSchema, manifestViewSchema, manifestEndpointSchema, manifestWorkflowSchema };
