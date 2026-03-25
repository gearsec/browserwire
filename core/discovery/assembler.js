/**
 * assembler.js — Phase 3: Manifest Assembler (pure code, no LLM)
 *
 * Takes the planner's skeleton (with workflows) + grounded views and endpoints
 * from sub-agents and assembles the final validated manifest.
 *
 * Workflows come from the planner skeleton — they reference view/endpoint names.
 * Invalid workflow references (e.g. a sub-agent failed to ground an item) are
 * filtered out rather than failing the whole assembly.
 */

import { submitManifest } from "./tools/testing.js";

// ---------------------------------------------------------------------------
// Main assembler function
// ---------------------------------------------------------------------------

/**
 * Assemble the final manifest from skeleton + grounded items.
 *
 * @param {object} options
 * @param {object} options.skeleton - Planner skeleton (domain, page, items, workflows)
 * @param {object[]} options.views - Grounded view objects from sub-agents
 * @param {object[]} options.endpoints - Grounded endpoint objects from sub-agents
 * @returns {{ manifest: object, error?: string }}
 */
export function runAssembler({ skeleton, views, endpoints }) {
  const viewNames = new Set(views.map((v) => v.name));
  const endpointNames = new Set(endpoints.map((e) => e.name));

  // Filter workflows to only those whose references are all grounded
  const validWorkflows = [];
  const droppedWorkflows = [];

  for (const wf of skeleton.workflows || []) {
    const missingRefs = [];

    for (const step of wf.steps) {
      if (step.view_name && !viewNames.has(step.view_name)) {
        missingRefs.push(`view "${step.view_name}"`);
      }
      if (step.endpoint_name && !endpointNames.has(step.endpoint_name)) {
        missingRefs.push(`endpoint "${step.endpoint_name}"`);
      }
    }

    if (missingRefs.length === 0) {
      validWorkflows.push(wf);
    } else {
      droppedWorkflows.push({ name: wf.name, missing: missingRefs });
    }
  }

  if (droppedWorkflows.length > 0) {
    for (const d of droppedWorkflows) {
      console.warn(
        `[browserwire-cli]   assembler: dropped workflow "${d.name}" — missing: ${d.missing.join(", ")}`
      );
    }
  }

  const manifest = {
    domain: skeleton.domain,
    domainDescription: skeleton.domainDescription,
    page: skeleton.page,
    views,
    endpoints,
    workflows: validWorkflows,
  };

  // Run full validation
  const validation = submitManifest({ manifest });
  if (validation.valid) {
    return { manifest: validation.manifest };
  }

  // Validation failed — return manifest anyway with error info
  console.warn("[browserwire-cli]   assembler: validation errors:", validation.errors);
  return {
    manifest,
    error: `Validation errors: ${validation.errors.join("; ")}`,
  };
}
