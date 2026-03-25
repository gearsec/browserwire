/**
 * merge-agent.js — AI Merge Agent (LangGraph)
 *
 * Merges per-snapshot apiSchemas into a unified site-level manifest.
 * Uses a ReAct agent subgraph with two tools:
 *   - get_snapshot_manifest: fetch a snapshot's manifest by index
 *   - submit_site_manifest: validate and submit the merged site manifest
 */

import { HumanMessage } from "@langchain/core/messages";
import { getModel } from "./ai-provider.js";
import { getMergeTools } from "./tools/index.js";
import { createReactAgent } from "./graphs/react-agent.js";

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
5. Pick ONE consistent domain and domainDescription for the entire site. All snapshots are from the same site — different snapshots may have used different labels (e.g. "social_news" vs "news_aggregator") but you must normalize to a single value. Use the most descriptive and accurate label.
6. Submit the merged manifest via \`submit_site_manifest\`.
7. If validation fails, fix the errors and resubmit.
8. Once \`submit_site_manifest\` returns valid: true, stop immediately.

## Rules

- Use snake_case for all names.
- No duplicate routePatterns across pages.
- No duplicate view or endpoint names within a page.
- Workflow references (view_name, endpoint_name) must be valid within their page.
- Preserve all tested selectors and locators from the original manifests.
- Do NOT invent new views, endpoints, or workflows — only merge what exists.
- CRITICAL: You MUST call submit_site_manifest to complete your task. Text responses are ignored.`;

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
  const tools = getMergeTools(withManifests);

  console.log(
    `[browserwire-cli] merge agent starting: session=${sessionId} snapshots=${withManifests.length}`
  );

  let toolCallCount = 0;
  const { invoke } = createReactAgent({
    model,
    tools,
    submitToolName: "submit_site_manifest",
    systemPrompt: SYSTEM_PROMPT,
    recursionLimit: 62,
    onProgress: ({ tool }) => {
      toolCallCount++;
      console.log(`[browserwire-cli]   merge agent: ${tool}`);
    },
    agentRole: "merge",
  });

  try {
    const { result, done } = await invoke([
      new HumanMessage(
        `Merge ${withManifests.length} snapshot manifests into a single site-level manifest. Fetch each one using get_snapshot_manifest (indices 0 through ${withManifests.length - 1}), then merge and submit.`
      ),
    ]);

    if (!done || !result?.manifest) {
      return {
        siteManifest: null,
        error: `Merge agent completed ${toolCallCount} tool calls but did not produce a valid site manifest`,
      };
    }

    const siteManifest = result.manifest;
    console.log(
      `[browserwire-cli] merge agent done: ${siteManifest.pages.length} pages, ${toolCallCount} tool calls`
    );

    return { siteManifest };
  } catch (err) {
    return { siteManifest: null, error: `Merge agent error: ${err.message}` };
  }
}
