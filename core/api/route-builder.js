/**
 * route-builder.js — Build a flat route table from a state machine manifest.
 *
 * For each view and action in the manifest, computes the shortest path
 * from the initial state via BFS through the to_state graph. Collects
 * all inputs needed along the path into a single flat input schema.
 *
 * The route table is a pure data structure — no execution logic.
 * The executor (executor.js) uses it to run paths at request time.
 */

/**
 * @typedef {object} Route
 * @property {string} name — globally unique endpoint name
 * @property {"view"|"action"} type — whether this reads data or executes an interaction
 * @property {string} stateId — the state that owns this view/action
 * @property {string} stateName — human-readable state name
 * @property {string} description — from the view/action definition
 * @property {Array<{ stateId: string, actionName: string }>} path — actions to execute to reach the state
 * @property {string} entryPointStateId — the entry point state to start navigation from
 * @property {Array<{ name: string, type: string, required: boolean, description?: string, from: string }>} inputs — all inputs (path + target)
 * @property {Array<{ name: string, type: string, description?: string }>} [returns] — for views: field schema
 * @property {boolean} isList — for views: whether it returns an array
 */

/**
 * Find all entry point states: initial_state + any state with no incoming edges.
 * States with no incoming edges are URL-navigable (reachable by their url_pattern).
 *
 * @param {object} manifest
 * @returns {Set<string>}
 */
function getEntryPoints(manifest) {
  // Collect all states that have at least one incoming edge
  const hasIncoming = new Set();
  for (const state of manifest.states) {
    for (const action of state.actions || []) {
      if (action.to_state && action.to_state !== state.id) hasIncoming.add(action.to_state);
    }
  }

  const entryPoints = new Set();
  entryPoints.add(manifest.initial_state);
  for (const state of manifest.states) {
    if (!hasIncoming.has(state.id)) entryPoints.add(state.id);
  }
  return entryPoints;
}

/**
 * Multi-source BFS to find the shortest path from any entry point to a target state.
 * Returns { path, entryPointStateId } or null if unreachable.
 *
 * @param {object} manifest — state machine manifest (with states[])
 * @param {string} targetStateId
 * @param {Set<string>} entryPoints
 * @returns {{ path: Array<{ stateId: string, actionName: string }>, entryPointStateId: string }|null}
 */
function findPath(manifest, targetStateId, entryPoints) {
  // If the target is itself an entry point, no path needed
  if (entryPoints.has(targetStateId)) {
    return { path: [], entryPointStateId: targetStateId };
  }

  // Build adjacency: stateId → [{ actionName, toStateId }]
  const adjacency = new Map();
  for (const state of manifest.states) {
    const edges = [];
    for (const action of state.actions || []) {
      if (action.to_state && action.to_state !== state.id) {
        edges.push({ actionName: action.name, toStateId: action.to_state });
      }
    }
    adjacency.set(state.id, edges);
  }

  // Multi-source BFS: seed with all entry points
  const queue = [];
  const visited = new Set();
  for (const ep of entryPoints) {
    queue.push({ stateId: ep, path: [], entryPointStateId: ep });
    visited.add(ep);
  }

  while (queue.length > 0) {
    const { stateId, path, entryPointStateId } = queue.shift();
    const edges = adjacency.get(stateId) || [];

    for (const { actionName, toStateId } of edges) {
      if (visited.has(toStateId)) continue;

      const newPath = [...path, { stateId, actionName }];
      if (toStateId === targetStateId) {
        return { path: newPath, entryPointStateId };
      }

      visited.add(toStateId);
      queue.push({ stateId: toStateId, path: newPath, entryPointStateId });
    }
  }

  return null; // unreachable
}

/**
 * Look up a state by id.
 */
function getState(manifest, stateId) {
  return manifest.states.find((s) => s.id === stateId) || null;
}

/**
 * Look up an action on a state by name.
 */
function getAction(state, actionName) {
  return state?.actions?.find((a) => a.name === actionName) || null;
}

/**
 * Extract variable names from an RFC 6570 URI template.
 * Handles {var}, {?var}, {&var}, {+var}, {#var}, {.var}, {;var}, {/var}, and {?a,b} forms.
 */
function extractUrlParams(urlTemplate) {
  const matches = urlTemplate.match(/\{[+#./;?&]?([^}]+)\}/g) || [];
  return matches.flatMap((m) => {
    const inner = m.slice(1, -1).replace(/^[+#./;?&]/, "");
    return inner.split(",").map((v) => v.replace(/[*:].*$/, "").trim());
  });
}

/**
 * Collect inputs from a path's intermediate actions + the target view/action.
 */
function collectInputs(manifest, path, targetInputs, targetName) {
  const inputs = [];
  const seen = new Set();

  // Inputs from intermediate actions along the path
  for (const step of path) {
    const state = getState(manifest, step.stateId);
    const action = getAction(state, step.actionName);
    for (const input of action?.inputs || []) {
      if (!seen.has(input.name)) {
        seen.add(input.name);
        inputs.push({
          ...input,
          from: `${state.name}.${step.actionName}`,
        });
      }
    }
  }

  // Inputs from the target itself
  for (const input of targetInputs || []) {
    if (!seen.has(input.name)) {
      seen.add(input.name);
      inputs.push({
        ...input,
        from: targetName,
      });
    }
  }

  return inputs;
}

/**
 * Build a flat route table from a state machine manifest.
 *
 * @param {object} manifest — { domain, initial_state, states[] }
 * @returns {{ views: Route[], actions: Route[], workflows: Route[], unreachable: string[] }}
 */
export function buildRouteTable(manifest) {
  if (!manifest?.states?.length || !manifest.initial_state) {
    return { views: [], actions: [], workflows: [], unreachable: [] };
  }

  const views = [];
  const actions = [];
  const unreachable = [];

  // Track used names for dedup
  const usedNames = new Set();

  function uniqueName(baseName, stateName) {
    if (!usedNames.has(baseName)) {
      usedNames.add(baseName);
      return baseName;
    }
    const prefixed = `${stateName}_${baseName}`;
    usedNames.add(prefixed);
    return prefixed;
  }

  const entryPoints = getEntryPoints(manifest);

  for (const state of manifest.states) {
    const result = findPath(manifest, state.id, entryPoints);

    if (result === null) {
      unreachable.push(`State "${state.name}" (${state.id}) is unreachable from any entry point`);
      continue;
    }

    const { path, entryPointStateId } = result;

    // If the entry point has URL params, they become required inputs
    const entryState = getState(manifest, entryPointStateId);
    const urlParams = entryState ? extractUrlParams(entryState.url_pattern || "") : [];
    const urlInputs = urlParams.map((p) => ({
      name: p,
      type: "string",
      required: true,
      from: "url",
    }));

    // Views
    for (const view of state.views || []) {
      const name = uniqueName(view.name, state.name);
      views.push({
        name,
        originalName: view.name,
        type: "view",
        stateId: state.id,
        stateName: state.name,
        description: view.description,
        path,
        entryPointStateId,
        inputs: [...urlInputs, ...collectInputs(manifest, path, [], name)],
        returns: view.returns || [],
        isList: view.isList,
      });
    }

    // Actions — exclude form-group actions (they go into workflows only)
    for (const action of state.actions || []) {
      if (action.form_group) continue; // handled by buildWorkflowRoutes below
      const name = uniqueName(action.name, state.name);
      actions.push({
        name,
        originalName: action.name,
        type: "action",
        stateId: state.id,
        stateName: state.name,
        description: action.description,
        path,
        entryPointStateId,
        inputs: [...urlInputs, ...collectInputs(manifest, path, action.inputs, name)],
        leadsTo: action.to_state,
      });
    }
  }

  const workflows = buildWorkflowRoutes(manifest, entryPoints, usedNames);

  return { views, actions, workflows, unreachable };
}

/**
 * Build workflow routes from form-group actions.
 *
 * Groups actions by state + form_group, sorts by sequence_order,
 * and creates a single workflow route that replays them in order.
 *
 * @param {object} manifest
 * @param {Set<string>} entryPoints
 * @param {Set<string>} usedNames — shared name dedup set
 * @returns {Route[]}
 */
function buildWorkflowRoutes(manifest, entryPoints, usedNames) {
  const workflows = [];

  for (const state of manifest.states) {
    // Group actions by form_group
    const formGroups = new Map();
    for (const action of state.actions || []) {
      if (!action.form_group) continue;
      if (!formGroups.has(action.form_group)) {
        formGroups.set(action.form_group, []);
      }
      formGroups.get(action.form_group).push(action);
    }

    if (formGroups.size === 0) continue;

    const result = findPath(manifest, state.id, entryPoints);
    if (!result) continue;

    const { path, entryPointStateId } = result;
    const entryState = getState(manifest, entryPointStateId);
    const urlParams = entryState ? extractUrlParams(entryState.url_pattern || "") : [];
    const urlInputs = urlParams.map((p) => ({
      name: p,
      type: "string",
      required: true,
      from: "url",
    }));

    for (const [formGroup, formActions] of formGroups) {
      // Sort by sequence_order
      formActions.sort((a, b) => (a.sequence_order ?? 0) - (b.sequence_order ?? 0));

      // Collect inputs from all constituent actions
      const allInputs = [...urlInputs];
      const seen = new Set(urlInputs.map((i) => i.name));

      // Also collect inputs from path actions
      for (const step of path) {
        const pathState = getState(manifest, step.stateId);
        const pathAction = getAction(pathState, step.actionName);
        for (const input of pathAction?.inputs || []) {
          if (!seen.has(input.name)) {
            seen.add(input.name);
            allInputs.push({ ...input, from: `${pathState.name}.${step.actionName}` });
          }
        }
      }

      for (const action of formActions) {
        for (const input of action.inputs || []) {
          if (!seen.has(input.name)) {
            seen.add(input.name);
            allInputs.push({ ...input, from: `${state.name}.${action.name}` });
          }
        }
      }

      // Find the submit action (has to_state) for the description
      const submitAction = formActions.find((a) => a.to_state) || formActions[formActions.length - 1];

      // Deduplicate name
      let name = formGroup;
      if (usedNames.has(name)) {
        name = `${state.name}_${formGroup}`;
      }
      usedNames.add(name);

      workflows.push({
        name,
        type: "workflow",
        stateId: state.id,
        stateName: state.name,
        description: `Fill and submit: ${formActions.map((a) => a.name).join(" → ")}`,
        path,
        entryPointStateId,
        inputs: allInputs,
        // Ordered list of actions to replay within the state
        actions: formActions.map((a) => ({ actionName: a.name, stateId: state.id })),
        leadsTo: submitAction.to_state,
      });
    }
  }

  return workflows;
}
