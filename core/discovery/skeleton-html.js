/**
 * skeleton-html.js — Shared HTML skeleton utilities
 *
 * Extracted from perceive.js so both Stage 1 (perception) and Stage 3
 * (skeleton-based DOM grounding) can reuse the same skeleton builder.
 */

/**
 * Build a compact HTML skeleton string from skeleton entries.
 * Uses id="s{scanId}" as the element marker for LLM reference.
 */
export const buildHtmlSkeleton = (skeleton) => {
  const lines = [];

  for (const entry of skeleton) {
    const attrs = [`id="s${entry.scanId}"`];

    if (entry.role) attrs.push(`role="${entry.role}"`);
    if (entry.attributes?.href) {
      attrs.push(`href="${entry.attributes.href.slice(0, 80)}"`);
    }
    if (entry.attributes?.type) {
      attrs.push(`type="${entry.attributes.type}"`);
    }
    if (entry.attributes?.placeholder) {
      attrs.push(`placeholder="${entry.attributes.placeholder.slice(0, 60)}"`);
    }
    if (entry.attributes?.["aria-label"]) {
      attrs.push(`aria-label="${entry.attributes["aria-label"].slice(0, 60)}"`);
    }
    if (entry.attributes?.name) {
      attrs.push(`name="${entry.attributes.name.slice(0, 40)}"`);
    }
    if (entry.attributes?.["data-testid"]) {
      attrs.push(`data-testid="${entry.attributes["data-testid"].slice(0, 40)}"`);
    }
    if (entry.attributes?.class) {
      attrs.push(`class="${entry.attributes.class}"`);
    }

    // Include element state as state-* attributes for LLM context
    if (entry.state) {
      if (entry.state.value != null) attrs.push(`state-value="${String(entry.state.value).slice(0, 60)}"`);
      if (entry.state.checked != null) attrs.push(`state-checked="${entry.state.checked}"`);
      if (entry.state.selectedOption != null) attrs.push(`state-selectedOption="${entry.state.selectedOption.slice(0, 40)}"`);
      if (entry.state.disabled) attrs.push(`state-disabled="true"`);
      if (entry.state.expanded != null) attrs.push(`state-expanded="${entry.state.expanded}"`);
      if (entry.state.selected != null) attrs.push(`state-selected="${entry.state.selected}"`);
    }

    const attrsStr = attrs.join(" ");
    const text = entry.text ? entry.text.slice(0, 60) : "";

    // Self-closing for void / replaced elements
    if (entry.tag === "input" || entry.tag === "select") {
      lines.push(`<${entry.tag} ${attrsStr} />`);
    } else if (text) {
      lines.push(`<${entry.tag} ${attrsStr}>${text}</${entry.tag}>`);
    } else {
      lines.push(`<${entry.tag} ${attrsStr}></${entry.tag}>`);
    }
  }

  return lines.join("\n");
};

