/**
 * skeleton-analyzer/index.js — Stage 3 Orchestrator
 *
 * Analyzes DOM skeletons to ground ungrounded views (CSS selectors) and
 * all endpoints (trigger + input locators) via focused LLM calls.
 *
 * Pipeline:
 *   1. Select best skeleton per page (most skeleton entries per route)
 *   2. Collect work items: views without readContract + all endpoints
 *   3. Execute groundView + groundEndpoint in parallel
 *   4. Return { viewGroundings, endpointGroundings }
 */

import { buildHtmlSkeleton } from "../skeleton-html.js";
import { groundView } from "./ground-view.js";
import { groundEndpoint } from "./ground-endpoint.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * For each page route, find the snapshot with the richest DOM data.
 * Prefers domHtml over legacy skeleton entries.
 * Returns Map<routePattern, { htmlSkeleton: string, url: string }>.
 */
const selectBestSnapshots = (siteSchema, snapshots) => {
  const byRoute = new Map();

  for (const page of siteSchema.pages) {
    const route = page.routePattern;

    let bestSnapshot = null;
    let bestScore = 0;

    for (const snap of snapshots) {
      const hasDomHtml = snap.domHtml && snap.domHtml.length > 0;
      const hasSkeleton = snap.skeleton && snap.skeleton.length > 0;
      if (!hasDomHtml && !hasSkeleton) continue;

      // Score: domHtml gets a large bonus over skeleton
      const score = hasDomHtml ? snap.domHtml.length + 1_000_000 : snap.skeleton.length;

      if (score > bestScore) {
        bestScore = score;
        bestSnapshot = snap;
      }
    }

    if (bestSnapshot) {
      // Build the HTML skeleton string: prefer preprocessed domHtml
      let htmlSkeleton;
      if (bestSnapshot.domHtml && bestSnapshot.domHtml.length > 0) {
        htmlSkeleton = bestSnapshot.domHtml;
      } else {
        htmlSkeleton = buildHtmlSkeleton(bestSnapshot.skeleton);
      }

      byRoute.set(route, {
        htmlSkeleton,
        url: bestSnapshot.url,
      });
    }
  }

  return byRoute;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze skeletons to ground views and endpoints to DOM selectors/locators.
 *
 * @param {{ siteSchema: object, snapshots: object[] }} input
 * @returns {Promise<{ viewGroundings: Array, endpointGroundings: Array }>}
 */
export const analyzeSkeletons = async ({ siteSchema, snapshots }) => {
  const bestSnapshots = selectBestSnapshots(siteSchema, snapshots);

  if (bestSnapshots.size === 0) {
    console.log("[browserwire-cli] Stage 3: no DOM data available, skipping");
    return { viewGroundings: [], endpointGroundings: [] };
  }

  // Collect work items
  const viewWork = [];
  const endpointWork = [];

  for (const page of siteSchema.pages) {
    const snapData = bestSnapshots.get(page.routePattern);
    if (!snapData) continue;

    const htmlSkeleton = snapData.htmlSkeleton;
    const url = snapData.url;

    // Views without readContract need DOM grounding
    for (const view of page.views) {
      if (view.readContract) continue;
      viewWork.push({ view, htmlSkeleton, url });
    }

    // All endpoints get DOM locators
    for (const endpoint of page.endpoints) {
      endpointWork.push({ endpoint, htmlSkeleton, url });
    }
  }

  if (viewWork.length === 0 && endpointWork.length === 0) {
    console.log("[browserwire-cli] Stage 3: nothing to ground, skipping");
    return { viewGroundings: [], endpointGroundings: [] };
  }

  console.log(
    `[browserwire-cli] Stage 3: grounding ${viewWork.length} views + ${endpointWork.length} endpoints`
  );

  // Execute all in parallel
  const allPromises = [
    ...viewWork.map((w) =>
      groundView(w).then(
        (grounding) => ({ type: "view", viewName: w.view.name, grounding }),
        (error) => {
          console.warn(`[browserwire-cli] Stage 3: view "${w.view.name}" failed: ${error.message}`);
          return { type: "view", viewName: w.view.name, grounding: null };
        }
      )
    ),
    ...endpointWork.map((w) =>
      groundEndpoint(w).then(
        (grounding) => ({ type: "endpoint", endpointName: w.endpoint.name, grounding }),
        (error) => {
          console.warn(`[browserwire-cli] Stage 3: endpoint "${w.endpoint.name}" failed: ${error.message}`);
          return { type: "endpoint", endpointName: w.endpoint.name, grounding: null };
        }
      )
    ),
  ];

  const results = await Promise.allSettled(allPromises);

  const viewGroundings = [];
  const endpointGroundings = [];

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const item = result.value;
    if (!item.grounding) continue;

    if (item.type === "view") {
      viewGroundings.push({ viewName: item.viewName, grounding: item.grounding });
    } else {
      endpointGroundings.push({ endpointName: item.endpointName, grounding: item.grounding });
    }
  }

  console.log(
    `[browserwire-cli] Stage 3 complete: ${viewGroundings.length}/${viewWork.length} views, ` +
    `${endpointGroundings.length}/${endpointWork.length} endpoints grounded`
  );

  return { viewGroundings, endpointGroundings };
};
