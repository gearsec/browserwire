/**
 * merge-agent.js — AI Merge Agent
 *
 * Merges per-snapshot apiSchemas into a unified site-level manifest.
 * Uses a tool-loop agent with two tools:
 *   - get_snapshot_manifest: fetch a snapshot's manifest by index
 *   - submit_site_manifest: validate and submit the merged site manifest
 */

import { z } from "zod";
import { stepCountIs, pruneMessages } from "ai";
import { getModel } from "./ai-provider.js";
import { getGenerateText } from "../telemetry.js";
import {
  manifestViewSchema,
  manifestEndpointSchema,
  manifestWorkflowSchema,
} from "./tools/testing.js";

// ---------------------------------------------------------------------------
// Site-level manifest schema
// ---------------------------------------------------------------------------

const sitePageSchema = z.object({
  name: z.string(),
  routePattern: z.string(),
  description: z.string(),
  views: z.array(manifestViewSchema),
  endpoints: z.array(manifestEndpointSchema),
  workflows: z.array(manifestWorkflowSchema).optional().default([]),
});

const siteManifestSchema = z.object({
  domain: z.string(),
  domainDescription: z.string().optional(),
  pages: z.array(sitePageSchema).min(1),
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a manifest merge agent. You have multiple per-page snapshot manifests from a web application discovery session. Your job is to merge them into a single site-level manifest.

## Site Manifest Structure

\`\`\`
{
  domain: string,           // e.g. "ecommerce", "project_management"
  domainDescription: string, // 1-2 sentences about the site
  pages: [{
    name: string,           // e.g. "Product List"
    routePattern: string,   // e.g. "/products", "/products/:id"
    description: string,
    views: [{ name, description, isList, fields, container_selector, item_selector }],
    endpoints: [{ name, kind, description, selector, locator, inputs }],
    workflows: [{ name, kind, description, inputs, steps, outcomes }]
  }]
}
\`\`\`

## Instructions

1. Call \`get_snapshot_manifest\` for each snapshot index (starting from 0) to fetch all manifests.
2. Identify snapshots that represent the **same route** (same or similar routePattern).
3. For same-route snapshots, merge intelligently:
   - Deduplicate views by name — keep the version with more fields or better selectors.
   - Deduplicate endpoints by name — keep the version with more inputs or better locators.
   - Deduplicate workflows by name — keep the more complete version.
   - Combine complementary data (e.g., one snapshot found views the other missed).
4. For different routes, include each as a separate page.
5. Pick the best domain and domainDescription from all snapshots.
6. Submit the merged manifest via \`submit_site_manifest\`.
7. If validation fails, fix the errors and resubmit.
8. Once \`submit_site_manifest\` returns valid: true, stop immediately.

## Rules

- Use snake_case for all names.
- No duplicate routePatterns across pages.
- No duplicate view or endpoint names within a page.
- Workflow references (view_name, endpoint_name) must be valid within their page.
- Preserve all tested selectors and locators from the original manifests.
- Do NOT invent new views, endpoints, or workflows — only merge what exists.`;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const createTools = (snapshots) => ({
  get_snapshot_manifest: {
    description:
      "Fetch the full manifest for a snapshot by its 0-based index. Returns the apiSchema, snapshotId, url, title, and trigger kind.",
    parameters: z.object({
      index: z.number().describe("0-based snapshot index"),
    }),
    execute: ({ index }) => {
      if (index < 0 || index >= snapshots.length) {
        return {
          error: `Index ${index} out of range. Valid range: 0–${snapshots.length - 1}`,
        };
      }
      const s = snapshots[index];
      if (!s.apiSchema) {
        return {
          error: `Snapshot at index ${index} has no manifest`,
        };
      }
      return {
        index,
        snapshotId: s.snapshotId,
        url: s.url,
        title: s.title,
        trigger: s.trigger?.kind || "unknown",
        manifest: s.apiSchema,
      };
    },
  },

  submit_site_manifest: {
    description:
      "Validate and submit the merged site-level manifest. Returns { valid: true, manifest } on success or { valid: false, errors } on failure.",
    parameters: z.object({
      manifest: z.any().describe("The complete site-level manifest object"),
    }),
    execute: ({ manifest }) => {
      const result = siteManifestSchema.safeParse(manifest);
      if (!result.success) {
        const errors = result.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`
        );
        return { valid: false, errors };
      }

      // Semantic checks
      const errors = [];
      const data = result.data;

      // No duplicate routePatterns across pages
      const routes = data.pages.map((p) => p.routePattern);
      const dupRoutes = routes.filter((r, i) => routes.indexOf(r) !== i);
      if (dupRoutes.length > 0) {
        errors.push(`Duplicate routePatterns across pages: ${dupRoutes.join(", ")}`);
      }

      for (const page of data.pages) {
        // No duplicate view names within a page
        const viewNames = page.views.map((v) => v.name);
        const dupViews = viewNames.filter((n, i) => viewNames.indexOf(n) !== i);
        if (dupViews.length > 0) {
          errors.push(`Page "${page.name}": duplicate view names: ${dupViews.join(", ")}`);
        }

        // No duplicate endpoint names within a page
        const epNames = page.endpoints.map((e) => e.name);
        const dupEps = epNames.filter((n, i) => epNames.indexOf(n) !== i);
        if (dupEps.length > 0) {
          errors.push(`Page "${page.name}": duplicate endpoint names: ${dupEps.join(", ")}`);
        }

        // Workflow references must be valid within their page
        const viewNameSet = new Set(viewNames);
        const epNameSet = new Set(epNames);
        for (const wf of page.workflows || []) {
          for (const step of wf.steps) {
            if (step.view_name && !viewNameSet.has(step.view_name)) {
              errors.push(
                `Page "${page.name}" workflow "${wf.name}" references unknown view: "${step.view_name}"`
              );
            }
            if (step.endpoint_name && !epNameSet.has(step.endpoint_name)) {
              errors.push(
                `Page "${page.name}" workflow "${wf.name}" references unknown endpoint: "${step.endpoint_name}"`
              );
            }
          }
        }
      }

      if (errors.length > 0) {
        return { valid: false, errors };
      }

      return { valid: true, manifest: data };
    },
  },
});

// ---------------------------------------------------------------------------
// Main merge agent function
// ---------------------------------------------------------------------------

/**
 * Run the merge agent to combine multiple snapshot manifests into a site manifest.
 *
 * @param {object} options
 * @param {Array} options.snapshots - Array of snapshot objects with apiSchema
 * @param {string} options.sessionId - Session ID for logging
 * @returns {Promise<{ siteManifest: object|null, error?: string }>}
 */
export async function runMergeAgent({ snapshots, sessionId }) {
  const model = getModel();
  if (!model) {
    return { siteManifest: null, error: "No LLM provider configured" };
  }

  const withManifests = snapshots.filter((s) => s.apiSchema);
  const tools = createTools(withManifests);

  console.log(
    `[browserwire-cli] merge agent starting: session=${sessionId} snapshots=${withManifests.length}`
  );

  const generateText = getGenerateText();

  let toolCallCount = 0;
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    tools,
    stopWhen: [
      ({ steps }) => {
        const lastStep = steps[steps.length - 1];
        return (
          lastStep?.toolResults?.some(
            (r) => r.toolName === "submit_site_manifest" && r.output?.valid === true
          ) ?? false
        );
      },
      stepCountIs(30),
    ],
    temperature: 0.1,
    messages: [
      {
        role: "user",
        content: `Merge ${withManifests.length} snapshot manifests into a single site-level manifest. Fetch each one using get_snapshot_manifest (indices 0 through ${withManifests.length - 1}), then merge and submit.`,
      },
    ],
    prepareStep: ({ stepNumber, messages }) => {
      if (stepNumber < 4) return {};
      const pruned = pruneMessages({
        messages,
        toolCalls: "before-last-3-messages",
        reasoning: "before-last-message",
        emptyMessages: "remove",
      });
      return { messages: pruned };
    },
    onStepFinish: ({ toolCalls }) => {
      if (toolCalls) {
        for (const tc of toolCalls) {
          toolCallCount++;
          console.log(`[browserwire-cli]   merge agent: ${tc.toolName}`);
        }
      }
    },
  });

  // Extract site manifest from result
  const siteManifest = extractSiteManifest(result);

  if (!siteManifest) {
    return {
      siteManifest: null,
      error: `Merge agent completed ${toolCallCount} tool calls but did not produce a valid site manifest`,
    };
  }

  console.log(
    `[browserwire-cli] merge agent done: ${siteManifest.pages.length} pages, ${toolCallCount} tool calls`
  );

  return { siteManifest };
}

/**
 * Extract site manifest from agent result.
 */
const extractSiteManifest = (result) => {
  // Primary: last step
  const lastStep = result.steps[result.steps.length - 1];
  const submitResult = lastStep?.toolResults?.find(
    (r) => r.toolName === "submit_site_manifest" && r.output?.valid === true
  );
  if (submitResult) return submitResult.output.manifest;

  // Fallback: reverse scan
  for (let i = result.steps.length - 2; i >= 0; i--) {
    const step = result.steps[i];
    for (const toolResult of step.toolResults || []) {
      if (toolResult.toolName === "submit_site_manifest" && toolResult.output?.valid === true) {
        return toolResult.output.manifest;
      }
    }
  }
  return null;
};
