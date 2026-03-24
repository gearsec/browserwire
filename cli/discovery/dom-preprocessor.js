/**
 * dom-preprocessor.js — Raw DOM HTML → Compact Nested HTML for LLM
 *
 * Parses raw HTML (from the extension's serializeDom()) and produces a
 * compact nested HTML representation suitable for LLM consumption.
 *
 * D2Snap-inspired element classification:
 *   - Interactive: button, a, input, select, textarea, summary → full HTML with semantic attrs
 *   - Content: h1-h6, p, label, img with alt → markdown-style text
 *   - Landmark: nav, main, header, footer, section, article, form, dialog, aside → HTML wrapper
 *   - Web Component: tags containing "-" → HTML wrapper
 *   - Generic: div, span, etc. → omitted unless has semantic attr; children bubble up
 *
 * No scan IDs. Output uses only real DOM attributes. Caps at ~16K tokens.
 */

import { parseDocument } from "htmlparser2";

// ---------------------------------------------------------------------------
// Classification sets
// ---------------------------------------------------------------------------

const INTERACTIVE_TAGS = new Set([
  "button", "a", "input", "select", "textarea", "summary"
]);

const CONTENT_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "label", "img", "li", "td", "th", "caption", "figcaption"
]);

const LANDMARK_TAGS = new Set([
  "nav", "main", "header", "footer", "section", "article", "form", "dialog", "aside"
]);

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "svg", "template", "path", "meta", "link", "br", "hr"
]);

// Attributes worth keeping on interactive/landmark elements
const SEMANTIC_ATTRS = new Set([
  "data-testid", "aria-label", "role", "href", "type", "placeholder",
  "name", "id", "aria-expanded", "aria-selected", "aria-checked",
  "aria-disabled", "value", "alt", "title", "action", "method",
  "for", "aria-haspopup", "aria-controls", "tabindex"
]);

// Attributes that make a generic element worth keeping
const PROMOTING_ATTRS = new Set([
  "role", "aria-label", "data-testid"
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isWebComponent = (tag) => tag.includes("-");

const hasSemantic = (attribs) => {
  for (const key of Object.keys(attribs || {})) {
    if (PROMOTING_ATTRS.has(key)) return true;
    // Meaningful id (not random hashes)
    if (key === "id" && attribs.id && !/^[a-f0-9]{8,}$/i.test(attribs.id) && attribs.id.length < 60) {
      return true;
    }
  }
  return false;
};

const filterAttrs = (attribs) => {
  const result = {};
  for (const [key, val] of Object.entries(attribs || {})) {
    if (SEMANTIC_ATTRS.has(key)) {
      // Truncate long values
      result[key] = val.length > 100 ? val.slice(0, 100) : val;
    }
  }
  return result;
};

const attrsToString = (attribs) => {
  const filtered = filterAttrs(attribs);
  const parts = [];
  for (const [key, val] of Object.entries(filtered)) {
    parts.push(`${key}="${val.replace(/"/g, "&quot;")}"`);
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
};

const getTextContent = (node) => {
  if (node.type === "text") return (node.data || "").trim();
  if (!node.children) return "";
  return node.children
    .map(getTextContent)
    .filter(Boolean)
    .join(" ")
    .trim();
};

const HEADING_LEVEL = { h1: "#", h2: "##", h3: "###", h4: "####", h5: "#####", h6: "######" };

// ---------------------------------------------------------------------------
// Core Processor
// ---------------------------------------------------------------------------

/**
 * Process a parsed DOM node, returning compact HTML lines.
 */
const processNode = (node, depth, ctx) => {
  if (ctx.length >= ctx.maxLength) return;

  // Text node
  if (node.type === "text") {
    const text = (node.data || "").trim();
    if (text && text.length > 0) {
      const truncated = text.length > 200 ? text.slice(0, 200) + "…" : text;
      ctx.lines.push(truncated);
      ctx.length += truncated.length;
    }
    return;
  }

  // Element node
  if (node.type !== "tag" && node.type !== "script" && node.type !== "style") return;
  const tag = (node.name || "").toLowerCase();
  if (!tag || SKIP_TAGS.has(tag)) return;

  const attribs = node.attribs || {};
  const children = node.children || [];

  // Interactive elements → full HTML tag with semantic attrs
  if (INTERACTIVE_TAGS.has(tag) || attribs.role === "button" || attribs.role === "link" ||
      attribs.role === "textbox" || attribs.role === "combobox" || attribs.role === "tab" ||
      attribs.role === "menuitem" || attribs.role === "option") {
    const attrStr = attrsToString(attribs);
    const text = getTextContent(node).slice(0, 100);

    if (tag === "input" || tag === "select") {
      const line = `<${tag}${attrStr} />`;
      ctx.lines.push(line);
      ctx.length += line.length;
    } else if (text) {
      const line = `<${tag}${attrStr}>${text}</${tag}>`;
      ctx.lines.push(line);
      ctx.length += line.length;
    } else {
      const line = `<${tag}${attrStr}></${tag}>`;
      ctx.lines.push(line);
      ctx.length += line.length;
    }
    return;
  }

  // Content elements → markdown-style
  if (CONTENT_TAGS.has(tag)) {
    const text = getTextContent(node).slice(0, 200);
    if (!text && tag !== "img") return;

    if (HEADING_LEVEL[tag]) {
      const line = `${HEADING_LEVEL[tag]} ${text}`;
      ctx.lines.push(line);
      ctx.length += line.length;
    } else if (tag === "img") {
      const alt = attribs.alt || "";
      const src = attribs.src ? attribs.src.slice(0, 80) : "";
      if (alt || src) {
        const line = `![${alt}](${src})`;
        ctx.lines.push(line);
        ctx.length += line.length;
      }
    } else if (tag === "label") {
      const forAttr = attribs.for ? ` for="${attribs.for}"` : "";
      const line = `<label${forAttr}>${text}</label>`;
      ctx.lines.push(line);
      ctx.length += line.length;
    } else if (text) {
      ctx.lines.push(text);
      ctx.length += text.length;
    }
    return;
  }

  // Landmark elements → HTML wrapper, recurse into children
  if (LANDMARK_TAGS.has(tag)) {
    const attrStr = attrsToString(attribs);
    ctx.lines.push(`<${tag}${attrStr}>`);
    ctx.length += tag.length + 2;

    for (const child of children) {
      processNode(child, depth + 1, ctx);
    }

    ctx.lines.push(`</${tag}>`);
    ctx.length += tag.length + 3;
    return;
  }

  // Web components → HTML wrapper, recurse
  if (isWebComponent(tag)) {
    const attrStr = attrsToString(attribs);
    ctx.lines.push(`<${tag}${attrStr}>`);
    ctx.length += tag.length + 2;

    for (const child of children) {
      processNode(child, depth + 1, ctx);
    }

    ctx.lines.push(`</${tag}>`);
    ctx.length += tag.length + 3;
    return;
  }

  // Generic elements with semantic attrs → keep as wrapper
  if (hasSemantic(attribs)) {
    const attrStr = attrsToString(attribs);
    ctx.lines.push(`<${tag}${attrStr}>`);
    ctx.length += tag.length + 2;

    for (const child of children) {
      processNode(child, depth + 1, ctx);
    }

    ctx.lines.push(`</${tag}>`);
    ctx.length += tag.length + 3;
    return;
  }

  // Generic elements without semantic attrs → bubble up children
  for (const child of children) {
    processNode(child, depth + 1, ctx);
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Token estimate: ~4 chars per token */
const MAX_OUTPUT_CHARS = 64_000; // ~16K tokens

/**
 * Preprocess raw DOM HTML into compact nested HTML for LLM consumption.
 *
 * @param {string} domHtml - Raw HTML string from extension's serializeDom()
 * @returns {string} Compact nested HTML suitable for LLM context
 */
export const preprocessDom = (domHtml) => {
  if (!domHtml || typeof domHtml !== "string") return "";

  const doc = parseDocument(domHtml);

  const ctx = {
    lines: [],
    length: 0,
    maxLength: MAX_OUTPUT_CHARS,
  };

  for (const child of doc.children || []) {
    processNode(child, 0, ctx);
  }

  return ctx.lines.join("\n");
};
