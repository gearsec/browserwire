/**
 * ground-endpoint.js — Stage 3: DOM-based grounding for endpoints
 *
 * One LLM call per endpoint. Produces locators for the trigger element
 * and any input fields.
 */

import { generateText, Output } from "ai";
import { z } from "zod";
import { getModel } from "../ai-provider.js";

// ---------------------------------------------------------------------------
// Zod output schema
// ---------------------------------------------------------------------------

export const endpointGroundingSchema = z.object({
  triggerLocator: z.object({
    kind: z.enum(["css", "xpath"]),
    value: z.string(),
    reasoning: z.string(),
  }),
  inputLocators: z.array(z.object({
    name: z.string(),
    kind: z.enum(["css", "xpath"]),
    value: z.string(),
    inputType: z.enum(["text", "select", "checkbox", "radio", "file", "textarea"]),
    reasoning: z.string(),
  })).optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a DOM grounding specialist. You are given:

1. An ENDPOINT definition — describes an interactive action on a web page (name, kind, visualContext, inputs)
2. A COMPACT DOM representation — a preprocessed version of the page's real DOM structure
3. The page URL

Your task: produce locators for the trigger element and any input fields.

## Output

Provide:
- triggerLocator: the locator for the element that triggers this action (button, link, etc.)
- inputLocators: (optional) for each endpoint input, a locator for its form field
- confidence: 0-1 how confident you are in the locators
- reasoning: brief explanation of your approach

## CRITICAL Rules

- All attributes in the DOM representation are real DOM attributes — use them directly
- Use the endpoint's visualContext to disambiguate elements on the page
- Prefer locators in this order: data-testid > name attribute > aria-label > placeholder > visible text > class-based
- For XPath, use semantic paths: //button[normalize-space()='Submit'], //label[contains(.,'Email')]/following-sibling::input
- For CSS, use: [data-testid="login-btn"], input[name="email"], [aria-label="Search"]
- NEVER use absolute XPath paths like /html/body/div[3]/... or positional indexes like //div[5]
- Match inputLocator names to the endpoint's input names
- Set inputType to the actual HTML input type (text, select, checkbox, radio, file, textarea)`;

// ---------------------------------------------------------------------------
// Build prompt
// ---------------------------------------------------------------------------

const buildPrompt = ({ endpoint, htmlSkeleton, url }) => {
  const parts = [
    `## Endpoint: "${endpoint.name}"`,
    `Kind: ${endpoint.kind}`,
    `Description: ${endpoint.description || "none"}`,
    `Visual context: ${endpoint.visualContext || "unknown"}`,
  ];

  if (endpoint.inputs?.length > 0) {
    const inputs = endpoint.inputs.map((i) =>
      `  - ${i.name} (${i.type}, ${i.required ? "required" : "optional"})`
    ).join("\n");
    parts.push(`Inputs:\n${inputs}`);
  }

  parts.push(`\nPage URL: ${url}`);
  parts.push(`\n## DOM Tree (rrweb JSON)\n${htmlSkeleton}`);

  return parts.join("\n");
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ground a single endpoint to DOM locators using the compact DOM.
 *
 * @param {{ endpoint: object, htmlSkeleton: string, url: string }} input
 * @returns {Promise<z.infer<typeof endpointGroundingSchema>|null>}
 */
export const groundEndpoint = async ({ endpoint, htmlSkeleton, url }) => {
  const model = getModel();
  if (!model) return null;

  const userPrompt = buildPrompt({ endpoint, htmlSkeleton, url });

  const { output } = await generateText({
    model,
    output: Output.object({ schema: endpointGroundingSchema }),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
  });

  if (!output) {
    console.warn(`[browserwire-cli] Stage 3: no grounding for endpoint "${endpoint.name}"`);
    return null;
  }

  return output;
};
