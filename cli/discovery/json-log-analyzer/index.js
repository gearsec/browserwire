/**
 * json-log-analyzer/index.js — Stage 2 Orchestrator
 *
 * Pre-filtered JSON API logs are passed in from the caller.
 *
 * 2-step pipeline:
 *   Step 1: categorizeApis()     — LLM maps logs → Stage 1 views
 *   Step 2: extractReadContract() — LLM extracts concrete API contracts (parallel per view)
 *
 * Returns an array of { viewName, contract } pairs ready for merging.
 */

import { categorizeApis } from "./categorize-apis.js";
import { extractReadContract } from "./extract-read-contracts.js";

// ---------------------------------------------------------------------------
// View lookup helper
// ---------------------------------------------------------------------------

const findView = (siteSchema, viewName) => {
  for (const page of siteSchema.pages) {
    const view = page.views.find((v) => v.name === viewName);
    if (view) return view;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze pre-filtered JSON API logs against Stage 1 views to produce read API contracts.
 *
 * @param {{ apiLogs: object[], siteSchema: object }} input
 * @returns {Promise<Array<{ viewName: string, contract: object }>>}
 */
export const analyzeNetworkLogs = async ({ apiLogs, siteSchema }) => {
  // Early exit: no data to analyze
  if (apiLogs.length === 0) {
    console.log("[browserwire-cli] Stage 2: no API logs after filtering, skipping");
    return [];
  }

  // Step 1: Categorize logs → views (LLM)
  let categorization;
  try {
    categorization = await categorizeApis({ apiLogs, siteSchema });
  } catch (error) {
    console.warn(`[browserwire-cli] Stage 2 Step 2 failed: ${error.message}`);
    return [];
  }

  if (!categorization) return [];

  // Step 2: Extract read contracts per view (LLM, parallel)
  const mappedViews = categorization.mappings.filter((m) => !m.unmapped);

  if (mappedViews.length === 0) {
    console.log("[browserwire-cli] Stage 2: no views mapped to network sources, skipping Step 3");
    return [];
  }

  console.log(
    `[browserwire-cli] Stage 2 Step 3: extracting read contracts for ${mappedViews.length} views`
  );

  const contractPromises = mappedViews.map((mapping) => {
    const view = findView(siteSchema, mapping.viewName);
    if (!view) {
      console.warn(`[browserwire-cli] Stage 2: view "${mapping.viewName}" not found in siteSchema`);
      return Promise.resolve({ status: "rejected", reason: `view not found: ${mapping.viewName}` });
    }

    return extractReadContract({
      view,
      networkSources: mapping.networkSources,
      apiLogs,
    }).then(
      (contract) => ({ status: "fulfilled", value: { viewName: mapping.viewName, contract } }),
      (error) => ({ status: "rejected", reason: error.message })
    );
  });

  const results = await Promise.allSettled(contractPromises);

  const contracts = [];
  for (const result of results) {
    // Each promise is already wrapped to resolve with { status, value/reason }
    const inner = result.value;
    if (inner.status === "fulfilled" && inner.value.contract) {
      contracts.push(inner.value);
      console.log(
        `[browserwire-cli] Stage 2: contract extracted for "${inner.value.viewName}" ` +
        `(${inner.value.contract.dataSources.length} data sources` +
        `${inner.value.contract.discoveredFields?.length ? `, ${inner.value.contract.discoveredFields.length} discovered fields` : ""})`
      );
    } else {
      const reason = inner.reason || "unknown error";
      console.warn(`[browserwire-cli] Stage 2: contract extraction failed — ${reason}`);
    }
  }

  console.log(
    `[browserwire-cli] Stage 2 complete: ${contracts.length}/${mappedViews.length} contracts extracted`
  );

  return contracts;
};
