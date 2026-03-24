/**
 * extract-read-contracts.js — Step 3: LLM-based read API contract extraction
 *
 * For each view with mapped network sources, asks the LLM to produce
 * a hardened read API contract: URL patterns, response paths, field mappings,
 * pagination, and discovered fields.
 *
 * One LLM call per view — executed in parallel via Promise.allSettled.
 */

import { generateText, Output } from "ai";
import { z } from "zod";
import { getModel } from "../ai-provider.js";

// ---------------------------------------------------------------------------
// Zod output schema
// ---------------------------------------------------------------------------

export const readContractSchema = z.object({
  dataSources: z.array(z.object({
    kind: z.enum(["rest", "graphql"]),
    method: z.string(),
    urlPattern: z.string(),
    queryParams: z.array(z.object({
      name: z.string(),
      required: z.boolean(),
      description: z.string(),
      exampleValue: z.string().optional(),
    })).optional(),
    operationName: z.string().optional(),
    responsePath: z.string(),
    fieldMappings: z.array(z.object({
      viewField: z.string(),
      jsonPath: z.string(),
      type: z.enum(["string", "number", "boolean", "date", "array", "object"]),
      nullable: z.boolean(),
      example: z.string().optional(),
    })),
    pagination: z.object({
      style: z.enum(["offset", "cursor", "page_number", "none"]),
      pageParam: z.string().optional(),
      limitParam: z.string().optional(),
      cursorParam: z.string().optional(),
      totalPath: z.string().optional(),
      nextCursorPath: z.string().optional(),
    }).optional(),
    role: z.enum(["primary", "supplementary"]),
  })),
  discoveredFields: z.array(z.object({
    name: z.string(),
    jsonPath: z.string(),
    type: z.enum(["string", "number", "boolean", "date", "array", "object"]),
    description: z.string(),
  })).optional(),
});

// ---------------------------------------------------------------------------
// Body truncation helper
// ---------------------------------------------------------------------------

const truncateBody = (body, maxChars) => {
  if (body == null) return "null";
  const str = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + "\n... (truncated)";
};

// ---------------------------------------------------------------------------
// Normalize URL to pattern
// ---------------------------------------------------------------------------

const toUrlPattern = (url) => {
  try {
    const u = new URL(url);
    return u.pathname
      .replace(/\/[0-9a-f]{8,}(?:-[0-9a-f]{4,}){0,4}/gi, "/:id")
      .replace(/\/\d+/g, "/:id");
  } catch {
    return url;
  }
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a web API contract analyst. You are given:

1. A VIEW — structured data visible on a web page, with field names and types
2. NETWORK SOURCES — actual API responses that feed this view

Your task: produce a hardened read API contract that documents exactly how to fetch the data this view displays.

## Rules
- For each data source, identify the JSON path from root to the data (e.g., "data.events", "results", "data.user.profile")
- Map view fields to specific JSON paths relative to the data path
- For list endpoints, the responsePath should point to the array
- Detect pagination: look for page/offset/cursor/limit params in query strings and next/total fields in responses
- For GraphQL: always include the operationName
- discoveredFields: list useful fields in the API response that are NOT in the view's field list (e.g., IDs, timestamps, slugs). These are "bonus" fields the API provides
- Be precise with JSON paths — use dot notation (data.events[0].name → responsePath="data.events", fieldMapping jsonPath="name")
- Set nullable=true only when the response shows actual null values or the field is optional
- type should reflect the actual JSON type, not the display format`;

// ---------------------------------------------------------------------------
// Build prompt for a single view
// ---------------------------------------------------------------------------

const buildViewPrompt = ({ view, networkSources, apiLogs }) => {
  const fields = view.fields.map((f) => `  - ${f.name} (${f.type})`).join("\n");

  const parts = [
    `## View: "${view.name}"`,
    `Description: ${view.description || "none"}`,
    `isList: ${view.isList}, isDynamic: ${view.isDynamic}`,
    `Fields:\n${fields}`,
  ];

  // Network sources
  if (networkSources.length > 0) {
    parts.push("\n## Network Sources");
    for (const src of networkSources) {
      const entry = apiLogs[src.logIndex];
      if (!entry) continue;

      const maxChars = src.role === "primary" ? 4000 : 1500;
      const urlPattern = toUrlPattern(entry.url);

      const srcParts = [
        `### [${src.role}] ${entry.method} ${entry.url}`,
        `URL pattern: ${urlPattern}`,
        `Status: ${entry.status}`,
      ];

      if (entry.queryParams && Object.keys(entry.queryParams).length > 0) {
        srcParts.push(`Query params: ${JSON.stringify(entry.queryParams)}`);
      }

      if (entry.requestBody != null) {
        srcParts.push(`Request body:\n${truncateBody(entry.requestBody, 1000)}`);
      }

      srcParts.push(`Response body:\n${truncateBody(entry.responseBody, maxChars)}`);
      parts.push(srcParts.join("\n"));
    }
  }

  return parts.join("\n");
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract a read contract for a single view.
 *
 * @param {{ view: object, networkSources: object[], apiLogs: object[] }} input
 * @returns {Promise<z.infer<typeof readContractSchema>|null>}
 */
export const extractReadContract = async ({ view, networkSources, apiLogs }) => {
  const model = getModel();
  if (!model) return null;

  const userPrompt = buildViewPrompt({ view, networkSources, apiLogs });

  const { output } = await generateText({
    model,
    output: Output.object({ schema: readContractSchema }),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
  });

  if (!output) {
    console.warn(`[browserwire-cli] Stage 2 Step 3: no contract for view "${view.name}"`);
    return null;
  }

  return output;
};
