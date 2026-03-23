/**
 * query-engine.js — Semantic Query Engine for Agent Tools
 *
 * Implements the agent-facing query tools that operate on a SnapshotIndex:
 * - get_accessibility_snapshot: YAML-style accessibility tree with ref IDs
 * - get_page_regions: Table of contents — major sections on the page
 * - find_interactive: Find interactive elements, optionally scoped
 * - get_element_details: Drill down into a specific element
 * - inspect_item_fields: CSS selector candidates for list item content
 */

// ---------------------------------------------------------------------------
// get_accessibility_snapshot
// ---------------------------------------------------------------------------

/**
 * Returns a YAML-style accessibility tree with ref IDs.
 * Optionally scoped to a subtree.
 *
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} index
 * @param {{ root_ref?: string }} params
 * @returns {{ tree: string }}
 */
export const getAccessibilitySnapshot = (index, { root_ref } = {}) => {
  const tree = index.toAccessibilityTree({ rootRef: root_ref });
  return { tree };
};

// ---------------------------------------------------------------------------
// get_page_regions
// ---------------------------------------------------------------------------

/**
 * Returns a high-level "table of contents" — structural sections on the page
 * based on CDP roles. The agent decides what constitutes a landmark or region.
 *
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} index
 * @returns {{ regions: Array<{ ref: string, tag: string, role: string, heading: string|null, summary: string, child_count: number, has_data_list: boolean }> }}
 */
export const getPageRegions = (index) => {
  const regions = [];

  // Find all nodes with a non-null CDP role that have children (structural nodes)
  const allNodes = index.getAllNodes();
  const structuralNodes = allNodes.filter((n) => n.role && n.childRefs.length > 0);

  for (const node of structuralNodes) {
    // Only include top-level structural nodes (no ancestor with a non-null role that indicates structure)
    const hasStructuralParent = node.parentRef
      ? index.findAncestor(node.ref, (n) => n.role != null && n.childRefs.length > 0) !== null
      : false;

    // Include top-level structural nodes and forms/dialogs (always notable)
    if (hasStructuralParent && node.tag !== "form" && node.tag !== "dialog") {
      continue;
    }

    const subtree = index.getSubtree(node.ref);

    // Find heading within this region
    let heading = null;
    for (const child of subtree) {
      if (child.role === "heading" && child.name) {
        heading = child.name.slice(0, 80);
        break;
      }
    }

    // Count elements with a non-null CDP role
    const childCount = subtree.filter((n) => n.role != null).length;

    // Check for data list (list/table with multiple items, or div-based repeating structures)
    const hasDataList = subtree.some((n) => {
      // Standard lists/tables
      if (n.role === "list" || n.tag === "table" || n.role === "table") {
        const children = index.getChildren(n.ref);
        return children.filter((c) => c.role === "listitem" || c.tag === "tr" || c.tag === "li").length >= 2;
      }
      // Div-based repeating structures: parent has 3+ children with the same tag+class signature
      if (n.childRefs && n.childRefs.length >= 3) {
        const children = index.getChildren(n.ref);
        const signatures = children.map((c) => `${c.tag}.${c.attributes.class || ""}`);
        const freq = {};
        for (const s of signatures) freq[s] = (freq[s] || 0) + 1;
        const maxFreq = Math.max(...Object.values(freq));
        const mostCommon = Object.keys(freq).find((k) => freq[k] === maxFreq);
        return maxFreq >= 3 && mostCommon !== "div.";
      }
      return false;
    });

    // Generate summary from first few named nodes
    const textParts = [];
    for (const child of subtree.slice(0, 20)) {
      if (child.name) {
        textParts.push(child.name);
        if (textParts.join(" ").length > 100) break;
      }
    }
    const summary = textParts.join(" ").slice(0, 120) || `${node.tag} region`;

    regions.push({
      ref: node.ref,
      tag: node.tag,
      role: node.role,
      heading,
      summary,
      child_count: childCount,
      has_data_list: hasDataList,
    });
  }

  return { regions };
};

// ---------------------------------------------------------------------------
// inspect_item_fields
// ---------------------------------------------------------------------------

/**
 * Pick relevant attributes for field candidate output.
 * Includes class, data-*, aria-*, href, src — omits style, event handlers, etc.
 */
const pickRelevantAttrs = (attributes) => {
  const result = {};
  for (const [key, val] of Object.entries(attributes)) {
    if (
      key === "class" || key === "href" || key === "src" || key === "alt" ||
      key.startsWith("data-") || key.startsWith("aria-")
    ) {
      result[key] = typeof val === "string" ? val.slice(0, 200) : val;
    }
  }
  return result;
};

/**
 * Analyze an item's internal structure and return CSS selector candidates
 * for each distinct content element within it.
 *
 * This is the critical tool for view field selectors — it tells the agent
 * what CSS selectors are actually available for elements inside list items,
 * instead of letting it guess from the accessibility tree.
 *
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} index
 * @param {{ item_ref: string }} params
 * @returns {{ item_ref: string, field_candidates: Array<{ ref: string, tag: string, role: string|null, text: string, relative_selector: string|null, attributes: object }> } | { error: string }}
 */
export const inspectItemFields = (index, { item_ref, include_ancestor_height = 0 }) => {
  const item = index.getNode(item_ref);
  if (!item) return { error: `Item not found: ${item_ref}` };

  // Build ancestor branch
  const ancestors = [];
  if (include_ancestor_height !== 0) {
    let current = item;
    let depth = 0;
    while (current.parentRef) {
      if (include_ancestor_height > 0 && depth >= include_ancestor_height) break;
      const parent = index.getNode(current.parentRef);
      if (!parent) break;
      ancestors.push({
        ref: parent.ref,
        tag: parent.tag,
        css_selector: index.buildCssSelector(parent.ref),
        attributes: pickRelevantAttrs(parent.attributes),
        child_count: index.getChildren(parent.ref).length,
      });
      current = parent;
      depth++;
    }
  }

  // Item's own info
  const itemSelector = index.buildCssSelector(item_ref);
  const itemAttrs = pickRelevantAttrs(item.attributes);

  const subtree = index.getSubtree(item_ref);
  const fields = [];

  for (const node of subtree) {
    if (node.ref === item_ref) continue;

    const text = index.getFullText(node.ref);
    if (!text && !node.attributes.href && !node.attributes.src) continue;

    fields.push({
      ref: node.ref,
      tag: node.tag,
      role: node.role,
      text: text.slice(0, 200),
      relative_selector: index.buildRelativeCssSelector(item_ref, node.ref),
      attributes: pickRelevantAttrs(node.attributes),
    });
  }

  return {
    item_ref,
    item_tag: item.tag,
    item_css_selector: itemSelector,
    item_attributes: itemAttrs,
    ancestors,
    field_candidates: fields,
  };
};

// ---------------------------------------------------------------------------
// find_interactive
// ---------------------------------------------------------------------------

/**
 * Find interactive elements, optionally scoped to a region.
 *
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} index
 * @param {{ near_ref?: string, kind?: string, text?: string }} params
 * @returns {{ elements: Array<{ ref: string, role: string|null, name: string|null, kind: string, tag: string, context: string }> }}
 */
export const findInteractive = (index, { near_ref, kind, text } = {}) => {
  // Get all nodes with a non-null CDP role — the agent's filters narrow from there
  let candidates;

  if (near_ref) {
    candidates = index.getSubtree(near_ref).filter((n) => n.role != null);
  } else {
    candidates = index.getAllNodes().filter((n) => n.role != null);
  }

  // Filter by kind (maps agent query parameter to CDP role values)
  if (kind) {
    const kindMap = {
      button: (n) => n.role === "button",
      link: (n) => n.role === "link",
      input: (n) => ["textbox", "searchbox", "combobox", "spinbutton", "slider"].includes(n.role),
      form: (n) => n.role === "form",
    };
    const filter = kindMap[kind];
    if (filter) {
      candidates = candidates.filter(filter);
    }
  }

  // Filter by text
  if (text) {
    const lowerText = text.toLowerCase();
    candidates = candidates.filter((n) => {
      const fullText = index.getFullText(n.ref).toLowerCase();
      const name = (n.name || "").toLowerCase();
      return fullText.includes(lowerText) || name.includes(lowerText);
    });
  }

  const elements = candidates.map((n) => {
    // Determine kind
    let elementKind;
    if (n.tag === "a" || n.role === "link") elementKind = "link";
    else if (n.tag === "button" || n.role === "button") elementKind = "button";
    else if (n.tag === "input" || n.tag === "textarea") elementKind = "input";
    else if (n.tag === "select" || n.role === "combobox" || n.role === "listbox") elementKind = "select";
    else elementKind = n.tag;

    // Context: find nearest ancestor with a non-null CDP role
    let context = "";
    const ancestor = index.findAncestor(n.ref, (a) => a.role != null);
    if (ancestor) {
      const heading = index.getSubtree(ancestor.ref)
        .find((c) => c.role === "heading" && c.name);
      context = heading ? `${ancestor.role} "${heading.name.slice(0, 40)}"` : ancestor.role;
    }

    return {
      ref: n.ref,
      role: n.role,
      name: n.name,
      kind: elementKind,
      tag: n.tag,
      context,
    };
  });

  return { elements };
};

// ---------------------------------------------------------------------------
// get_element_details
// ---------------------------------------------------------------------------

/**
 * Get detailed information about a specific element.
 *
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} index
 * @param {{ ref: string }} params
 * @returns {{ found: boolean, tag?: string, role?: string, name?: string, text?: string, attributes?: object, css_selector?: string, xpath?: string, parent_ref?: string, children_refs?: string[], form_context?: object }}
 */
export const getElementDetails = (index, { ref }) => {
  const node = index.getNode(ref);
  if (!node) {
    return { found: false, error: `No element with ref=${ref}` };
  }

  const text = index.getFullText(ref);
  const cssSelector = index.buildCssSelector(ref);
  const xpath = index.buildXPath(ref);

  // Build locator strategies (similar to locators.js)
  const strategies = [];

  if (node.attributes["data-testid"]) {
    strategies.push({ kind: "data_testid", value: node.attributes["data-testid"], confidence: 0.95 });
  }
  if (node.role && node.name) {
    strategies.push({ kind: "role_name", value: `${node.role} "${node.name}"`, confidence: 0.90 });
  }
  if (node.attributes["aria-label"]) {
    strategies.push({ kind: "attribute", value: `aria-label:${node.attributes["aria-label"]}`, confidence: 0.80 });
  }
  if (node.attributes.id && !/^[a-f0-9]{8,}$/i.test(node.attributes.id)) {
    strategies.push({ kind: "attribute", value: `id:${node.attributes.id}`, confidence: 0.85 });
  }
  if (cssSelector && cssSelector !== node.tag) {
    strategies.push({ kind: "css", value: cssSelector, confidence: 0.60 });
  }
  if (xpath) {
    strategies.push({ kind: "xpath", value: xpath, confidence: 0.30 });
  }

  strategies.sort((a, b) => b.confidence - a.confidence);

  // Form context — if inside a form, gather its details
  let formContext = null;
  const formAncestor = index.findAncestor(ref, (n) => n.tag === "form");
  if (formAncestor) {
    const formInputs = index.getSubtree(formAncestor.ref)
      .filter((n) => n.role != null && n.ref !== ref);
    formContext = {
      form_ref: formAncestor.ref,
      form_action: formAncestor.attributes.action || null,
      form_method: formAncestor.attributes.method || null,
      sibling_inputs: formInputs.map((n) => ({
        ref: n.ref,
        role: n.role,
        name: n.name,
      })),
    };
  }

  return {
    found: true,
    ref: node.ref,
    tag: node.tag,
    role: node.role,
    name: node.name,
    text: text.slice(0, 500),
    attributes: node.attributes,
    css_selector: cssSelector,
    xpath,
    parent_ref: node.parentRef,
    children_refs: node.childRefs,
    strategies,
    form_context: formContext,
    in_shadow: node.inShadow,
  };
};
