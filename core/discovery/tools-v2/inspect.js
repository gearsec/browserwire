/**
 * inspect.js — Element inspection tool (magnifying lens).
 *
 * Given a ref ID, returns:
 *   - The element itself (tag, role, name, text, attributes)
 *   - Ancestor chain going UP (containment context)
 *   - Descendant tree going DOWN (internal structure)
 *   - Form context if the element is inside a <form>
 *
 * This replaces both the old get_element_details and inspect_item_fields
 * tools. The agent doesn't need CSS selectors or locator strategies
 * (it writes Playwright code directly), but it does need structural
 * context to write good code.
 */

import { z } from "zod";

/**
 * Pick relevant attributes (skip internal/noise attributes).
 */
function pickAttributes(node) {
  const attrs = node.attributes || {};
  const picked = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class" || key === "id" || key === "name" || key === "type" ||
        key === "role" || key === "aria-label" || key === "href" || key === "action" ||
        key === "method" || key === "placeholder" || key === "data-testid" ||
        key === "value" || key === "src" || key === "alt" ||
        key.startsWith("aria-")) {
      picked[key] = value;
    }
  }
  return picked;
}

/**
 * Build the ancestor chain from a node up to the root (or up to depth limit).
 */
function getAncestorChain(index, ref, maxDepth) {
  const ancestors = [];
  let currentRef = ref;
  let depth = 0;

  while (depth < maxDepth) {
    const node = index.getNode(currentRef);
    if (!node || !node.parentRef) break;

    const parent = index.getNode(node.parentRef);
    if (!parent) break;

    ancestors.push({
      ref: node.parentRef,
      tag: parent.tag,
      role: parent.cdpRole || parent.role || null,
      name: parent.cdpName || null,
      attributes: pickAttributes(parent),
      child_count: (parent.childRefs || []).length,
    });

    currentRef = node.parentRef;
    depth++;
  }

  return ancestors;
}

/**
 * Build a compact descendant tree for an element.
 */
function getDescendantTree(index, ref, maxDepth, currentDepth = 0) {
  const node = index.getNode(ref);
  if (!node) return null;

  const entry = {
    ref,
    tag: node.tag,
    role: node.cdpRole || node.role || null,
    name: node.cdpName || null,
    text: (index.getDirectText ? index.getDirectText(ref) : (node.text || "")).slice(0, 150) || null,
    attributes: pickAttributes(node),
  };

  if (currentDepth < maxDepth && node.childRefs?.length > 0) {
    entry.children = node.childRefs
      .map((childRef) => getDescendantTree(index, childRef, maxDepth, currentDepth + 1))
      .filter(Boolean);
  }

  return entry;
}

/**
 * Build form context if the element is inside a <form>.
 */
function getFormContext(index, ref) {
  const formAncestor = index.findAncestor(ref, (n) => n.tag === "form");
  if (!formAncestor) return null;

  const formInputs = index.getSubtree(formAncestor.ref)
    .filter((n) => n.role != null && n.ref !== ref);

  return {
    form_ref: formAncestor.ref,
    form_action: formAncestor.attributes?.action || null,
    form_method: formAncestor.attributes?.method || null,
    sibling_inputs: formInputs.map((n) => ({
      ref: n.ref,
      tag: n.tag,
      role: n.cdpRole || n.role || null,
      name: n.cdpName || n.name || null,
    })),
  };
}

export const inspect_element = {
  name: "inspect_element",
  description:
    "Inspect an element and its surroundings — a magnifying lens. " +
    "Returns the element details, its ancestor chain going UP (to understand containment: " +
    "is it in a form? a list? a card?), its descendant tree going DOWN " +
    "(to understand internal structure: what fields does it contain?), " +
    "and form context if the element is inside a <form> (form action, method, sibling inputs). " +
    "Use ancestor_depth to control how far up to look (default 3), " +
    "and descendant_depth to control how far down (default 2).",
  parameters: z.object({
    ref: z.string().describe("The ref ID of the element to inspect (e.g., 'e23')"),
    ancestor_depth: z.number().optional().describe("How many ancestor levels to show (default 3)"),
    descendant_depth: z.number().optional().describe("How many descendant levels to show (default 2)"),
  }),
  execute: (ctx, { ref, ancestor_depth = 3, descendant_depth = 3 }) => {
    const { index } = ctx;
    const node = index.getNode(ref);

    if (!node) {
      return { error: `Element ${ref} not found` };
    }

    const text = index.getFullText ? index.getFullText(ref) : (node.text || "");

    return {
      element: {
        ref,
        tag: node.tag,
        role: node.cdpRole || node.role || null,
        name: node.cdpName || null,
        text: text.slice(0, 500) || null,
        attributes: pickAttributes(node),
        parent_ref: node.parentRef || null,
        child_count: (node.childRefs || []).length,
      },
      ancestors: getAncestorChain(index, ref, ancestor_depth),
      descendants: getDescendantTree(index, ref, descendant_depth),
      form_context: getFormContext(index, ref),
    };
  },
};
