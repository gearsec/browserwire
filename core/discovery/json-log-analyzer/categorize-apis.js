/**
 * categorize-apis.js — Step 2: LLM-based log-to-view mapping
 *
 * Takes filtered JSON API logs + Stage 1 views,
 * asks the LLM to map which logs serve which views.
 *
 * Uses Vercel AI SDK structured output with Zod validation.
 */

import { generateText, Output } from "ai";
import { z } from "zod";
import { getModel } from "../ai-provider.js";

// ---------------------------------------------------------------------------
// Zod output schema
// ---------------------------------------------------------------------------

export const categorizationSchema = z.object({
  mappings: z.array(z.object({
    viewName: z.string(),
    networkSources: z.array(z.object({
      logIndex: z.number(),
      role: z.enum(["primary", "supplementary"]),
      confidence: z.number().min(0).max(1),
      reasoning: z.string(),
    })),
    unmapped: z.boolean(),
  })),
});

// ---------------------------------------------------------------------------
// Shape description helper (depth-limited)
// ---------------------------------------------------------------------------

const describeShape = (obj, maxDepth, depth = 0) => {
  if (obj === null) return "null";
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return `[${describeShape(obj[0], maxDepth, depth)}] (${obj.length} items)`;
  }
  if (typeof obj !== "object") return typeof obj;
  if (depth >= maxDepth) return "{...}";
  const keys = Object.keys(obj).slice(0, 12);
  const parts = keys.map((k) => `${k}: ${describeShape(obj[k], maxDepth, depth + 1)}`);
  return `{ ${parts.join(", ")}${Object.keys(obj).length > 12 ? ", ..." : ""} }`;
};

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const buildViewsSummary = (siteSchema) => {
  const lines = [];
  let viewIdx = 0;
  for (const page of siteSchema.pages) {
    for (const view of page.views) {
      const fields = view.fields.map((f) => `${f.name}(${f.type})`).join(", ");
      lines.push(
        `[View ${viewIdx}] "${view.name}" — ${view.description || "no description"}` +
        `\n  isList=${view.isList}, isDynamic=${view.isDynamic}` +
        `\n  fields: ${fields}` +
        `\n  page: ${page.routePattern}`
      );
      viewIdx++;
    }
  }
  return lines.join("\n\n");
};

const buildLogsSummary = (apiLogs) => {
  return apiLogs.map((entry, i) => {
    const parts = [`[Log ${i}] ${entry.method} ${entry.url} → ${entry.status}`];

    if (entry.queryParams && Object.keys(entry.queryParams).length > 0) {
      parts.push(`  query params: ${Object.keys(entry.queryParams).join(", ")}`);
    }

    if (entry.requestBody != null) {
      parts.push(`  request body shape: ${describeShape(entry.requestBody, 2)}`);
    }

    if (entry.responseBody != null) {
      parts.push(`  response shape: ${describeShape(entry.responseBody, 2)}`);
    }

    return parts.join("\n");
  }).join("\n\n");
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a web API analyst. You are given:

1. A list of VIEWS — structured data visible on a web page (from visual analysis)
2. A list of NETWORK LOGS — actual API requests/responses captured during browsing

Your task: map which network logs serve which views.

## Rules
- Match response data shapes to view field lists
- For GraphQL: look at data.* nesting and operation names
- REST list endpoints (response is array) likely feed isList=true views
- URL semantics help: /api/events/:id likely feeds an event_detail view
- A single log can appear in multiple view mappings (shared API)
- Mark a mapping as unmapped=true if no network source matches the view
- Set role="primary" for the main data source, "supplementary" for secondary enrichment
- Be conservative with confidence scores: 0.9+ only when response fields clearly match view fields`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Categorize filtered API logs to Stage 1 views using an LLM.
 *
 * @param {{ apiLogs: object[], siteSchema: object }} input
 * @returns {Promise<z.infer<typeof categorizationSchema>|null>}
 */
export const categorizeApis = async ({ apiLogs, siteSchema }) => {
  const model = getModel();
  if (!model) return null;

  const viewsSummary = buildViewsSummary(siteSchema);
  const logsSummary = buildLogsSummary(apiLogs);

  const userParts = [
    "## Views (from visual analysis)\n\n" + viewsSummary,
    "\n\n## Network Logs (captured API requests)\n\n" + logsSummary,
  ];

  console.log(
    `[browserwire-cli] Stage 2 Step 2: categorizing ${apiLogs.length} API logs → ` +
    `views from ${siteSchema.pages.length} pages`
  );

  const { output } = await generateText({
    model,
    output: Output.object({ schema: categorizationSchema }),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userParts.join("") },
    ],
    temperature: 0.1,
  });

  if (!output) {
    console.warn("[browserwire-cli] Stage 2 Step 2: LLM returned no structured output");
    return null;
  }

  const mappedCount = output.mappings.filter((m) => !m.unmapped).length;
  console.log(
    `[browserwire-cli] Stage 2 Step 2: ${mappedCount}/${output.mappings.length} views mapped`
  );

  return output;
};
