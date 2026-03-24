/**
 * workflow-resolver.js — Shared workflow resolution logic.
 *
 * Resolves workflow steps from a manifest: maps endpoint/view names to
 * concrete selectors and strategies. Used by both the HTTP router and
 * the Electron IPC handler.
 */

export const sanitize = (name) =>
  (name || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

/**
 * Build name→definition lookup maps from a manifest.
 */
export const buildLookups = (manifest) => {
  const workflowMap = new Map();
  const viewMap = new Map();
  const endpointMap = new Map();

  for (const page of manifest.pages || []) {
    for (const wf of page.workflows || []) {
      workflowMap.set(sanitize(wf.name), wf);
    }
    for (const v of page.views || []) {
      viewMap.set(v.name, v);
    }
    for (const ep of page.endpoints || []) {
      endpointMap.set(ep.name, ep);
    }
  }

  return { workflowMap, viewMap, endpointMap };
};

export const buildStrategies = (endpoint, inputParam) => {
  if (inputParam && endpoint.inputs) {
    const input = endpoint.inputs.find((i) => i.name === inputParam);
    if (input?.selector) return [{ kind: "css", value: input.selector, confidence: 0.90 }];
  }
  const strategies = [];
  if (endpoint.locator) {
    strategies.push({ kind: endpoint.locator.kind, value: endpoint.locator.value, confidence: 0.90 });
  }
  if (endpoint.selector) {
    strategies.push({ kind: "css", value: endpoint.selector, confidence: 0.85 });
  }
  return strategies;
};

export const toViewConfig = (view) => {
  if (!view.container_selector && !view.fields?.some(f => f.selector)) return null;
  return {
    containerLocator: view.container_selector
      ? [{ kind: "css", value: view.container_selector, confidence: 0.90 }]
      : [],
    itemContainer: view.item_selector
      ? { kind: "css", value: view.item_selector, confidence: 0.90 }
      : null,
    fields: (view.fields || [])
      .filter(f => f.selector)
      .map(f => ({
        name: f.name,
        locator: { kind: "css", value: f.selector, attribute: f.attribute || null },
      })),
    isList: view.isList || false,
  };
};

/**
 * Resolve workflow steps: map endpoint/view names to concrete selectors.
 * Returns an array of resolved steps, or { error: string } on failure.
 */
export const resolveWorkflowSteps = (workflow, viewMap, endpointMap) => {
  const resolved = [];
  for (const step of workflow.steps || []) {
    if (step.type === "navigate") {
      resolved.push({ type: "navigate", url: step.url });
      continue;
    }
    if (step.type === "read_view") {
      const view = viewMap.get(step.view_name);
      if (!view) return { error: `Unknown view: "${step.view_name}"` };
      const viewConfig = toViewConfig(view);
      if (!viewConfig) return { error: `View "${step.view_name}" has no selectors` };
      resolved.push({ type: "read_view", viewConfig });
      continue;
    }
    // Action steps: fill, select, click, submit
    const endpoint = endpointMap.get(step.endpoint_name);
    if (!endpoint) return { error: `Unknown endpoint: "${step.endpoint_name}"` };
    const strategies = buildStrategies(endpoint, step.input_param);
    if (strategies.length === 0) return { error: `No selectors for endpoint "${step.endpoint_name}"` };
    resolved.push({
      type: step.type,
      strategies,
      ...(step.input_param ? { inputParam: step.input_param } : {}),
    });
  }
  return resolved;
};
