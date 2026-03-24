/**
 * ground-view.js — Stage 3: DOM-based grounding for views
 *
 * One LLM call per view that lacks a readContract. Uses compact DOM HTML
 * to produce CSS selectors for DOM-based data extraction.
 */

import { generateText, Output } from "ai";
import { z } from "zod";
import { getModel } from "../ai-provider.js";

// ---------------------------------------------------------------------------
// Zod output schema
// ---------------------------------------------------------------------------

export const viewGroundingSchema = z.object({
  containerSelector: z.string(),
  itemContainerSelector: z.string().optional(),
  fields: z.array(z.object({
    name: z.string(),
    selector: z.string(),
    attribute: z.string().optional(),
  })),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a DOM grounding specialist. You are given:

1. A VIEW definition — describes structured data visible on a web page (name, fields, isList)
2. A COMPACT DOM representation — a preprocessed version of the page's real DOM structure
3. The page URL

Your task: produce CSS selectors that can extract the view's data from the real DOM.

## Output

Provide:
- containerSelector: CSS selector for the outermost element containing this view's data
- itemContainerSelector: (REQUIRED for isList=true views) CSS selector for the repeating item containers within the container. This MUST always be provided when isList=true — do NOT omit it.
- fields: for each view field, a CSS selector relative to the item (for lists) or container (for single views)
- confidence: 0-1 how confident you are in the selectors
- reasoning: brief explanation of your approach

## CRITICAL Rules

- All attributes in the DOM representation are real DOM attributes — use them directly
- Use class names, data-* attributes, ARIA roles, tag+attribute combos, or semantic HTML elements
- Prefer selectors in this order: data-testid > name attribute > aria-label > class-based > tag-based
- For lists, itemContainerSelector must be relative to containerSelector; field selectors relative to each item
- For single views, field selectors are relative to containerSelector
- Omit fields where no reliable selector can be determined — better to skip than guess wrong
- Do NOT use :contains() pseudo-class — it is not standard CSS
- Do NOT use absolute paths or positional indexes like div:nth-child(5) unless truly structural
- Field selectors MUST be specific enough to distinguish different fields within an item`;

// ---------------------------------------------------------------------------
// Build prompt
// ---------------------------------------------------------------------------

const buildPrompt = ({ view, htmlSkeleton, url }) => {
  const fields = view.fields.map((f) => `  - ${f.name} (${f.type})`).join("\n");

  return [
    `## View: "${view.name}"`,
    `Description: ${view.description || "none"}`,
    `isList: ${view.isList}, isDynamic: ${view.isDynamic}`,
    `Fields:\n${fields}`,
    `\nPage URL: ${url}`,
    `\n## DOM Tree (rrweb JSON)\n${htmlSkeleton}`,
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ground a single view to CSS selectors using the compact DOM.
 *
 * @param {{ view: object, htmlSkeleton: string, url: string }} input
 * @returns {Promise<z.infer<typeof viewGroundingSchema>|null>}
 */
export const groundView = async ({ view, htmlSkeleton, url }) => {
  const model = getModel();
  if (!model) return null;

  const userPrompt = buildPrompt({ view, htmlSkeleton, url });

  const { output } = await generateText({
    model,
    output: Output.object({ schema: viewGroundingSchema }),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
  });

  if (!output) {
    console.warn(`[browserwire-cli] Stage 3: no grounding for view "${view.name}"`);
    return null;
  }

  if (!output.fields || output.fields.length === 0) {
    console.warn(`[browserwire-cli] Stage 3: view "${view.name}" grounding has no fields`);
    return null;
  }

  if (view.isList && !output.itemContainerSelector) {
    console.warn(`[browserwire-cli] Stage 3: view "${view.name}" is a list but LLM did not provide itemContainerSelector`);
  }

  // Convert to viewConfig format consumable by pollReadView / PAGE_READ_VIEW
  return {
    containerLocator: [{ kind: "css", value: output.containerSelector, confidence: output.confidence }],
    itemContainer: output.itemContainerSelector
      ? { kind: "css", value: output.itemContainerSelector, confidence: output.confidence }
      : null,
    fields: output.fields.map(f => ({
      name: f.name,
      locator: { kind: "css", value: f.selector, attribute: f.attribute || null },
    })),
    isList: view.isList || !!output.itemContainerSelector,
  };
};
