/**
 * field-type.js — Deterministic type inference from rrweb DOM nodes.
 *
 * Given a SnapshotIndex and a ref ID, inspects the HTML element's tag
 * and attributes to infer the API parameter type. For <select> elements,
 * walks child <option> nodes to extract enum values.
 *
 * Returns { type: "string"|"number"|"boolean", options?: string[] }.
 */

/**
 * Infer the API field type from a DOM element in the snapshot index.
 *
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} index
 * @param {string} ref - Element ref ID (e.g., "e23")
 * @returns {{ type: "string"|"number"|"boolean", options?: string[] } | null}
 *   null if the ref doesn't exist in the index
 */
export function inferFieldType(index, ref) {
  const node = index.getNode(ref);
  if (!node) return null;

  const tag = node.tag;
  const inputType = (node.attributes?.type || "").toLowerCase();

  // <select> → string with enum options from child <option> nodes
  if (tag === "select") {
    const options = extractSelectOptions(index, ref);
    return { type: "string", ...(options.length > 0 ? { options } : {}) };
  }

  // <textarea> → string
  if (tag === "textarea") {
    return { type: "string" };
  }

  // <input> — type attribute determines the field type
  if (tag === "input") {
    switch (inputType) {
      case "number":
      case "range":
        return { type: "number" };
      case "checkbox":
        return { type: "boolean" };
      case "radio":
        return { type: "boolean" };
      default:
        // text, email, password, tel, url, date, time, search, hidden, etc.
        return { type: "string" };
    }
  }

  // Any other element (custom components, div-based inputs, etc.) → string
  return { type: "string" };
}

/**
 * Extract option values from a <select> element's child <option> nodes.
 *
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} index
 * @param {string} selectRef
 * @returns {string[]}
 */
function extractSelectOptions(index, selectRef) {
  const children = index.getChildren(selectRef);
  const options = [];

  for (const child of children) {
    if (child.tag === "option") {
      // Prefer the value attribute; fall back to text content
      const value = child.attributes?.value;
      if (value !== undefined && value !== "") {
        options.push(value);
      } else {
        const text = index.getDirectText(child.ref);
        if (text) options.push(text);
      }
    }
    // Handle <optgroup> — walk its children too
    if (child.tag === "optgroup") {
      const groupChildren = index.getChildren(child.ref);
      for (const opt of groupChildren) {
        if (opt.tag === "option") {
          const value = opt.attributes?.value;
          if (value !== undefined && value !== "") {
            options.push(value);
          } else {
            const text = index.getDirectText(opt.ref);
            if (text) options.push(text);
          }
        }
      }
    }
  }

  return options;
}
