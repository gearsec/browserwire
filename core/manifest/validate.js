/**
 * validate.js — Semantic validation for state machine manifests.
 *
 * Validates beyond what Zod catches: referential integrity, duplicates,
 * signature consistency, to_state graph validity, and code presence.
 */

import { stateMachineManifestSchema } from "./schema.js";

/**
 * Validate a state machine manifest.
 *
 * Performs:
 *   1. Zod schema validation (structure + types)
 *   2. Semantic validation:
 *      - initial_state references a valid state id
 *      - No duplicate state ids
 *      - No duplicate view names within a state
 *      - No duplicate action names within a state
 *      - Signature views[] match actual views[].name
 *      - Signature actions[] match actual actions[].name
 *      - All to_state references point to valid state ids
 *      - All views and actions have non-empty code
 *
 * @param {object} manifest
 * @returns {{ valid: boolean, errors?: string[], manifest?: object }}
 */
export function validateManifest(manifest) {
  const result = stateMachineManifestSchema.safeParse(manifest);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return `${path}: ${issue.message}`;
    });
    return { valid: false, errors };
  }

  const data = result.data;
  const errors = [];

  // Collect all state ids
  const stateIds = new Set();
  const dupStateIds = [];
  for (const state of data.states) {
    if (stateIds.has(state.id)) {
      dupStateIds.push(state.id);
    }
    stateIds.add(state.id);
  }
  if (dupStateIds.length > 0) {
    errors.push(`Duplicate state ids: ${dupStateIds.join(", ")}`);
  }

  // initial_state must exist
  if (!stateIds.has(data.initial_state)) {
    errors.push(`initial_state "${data.initial_state}" does not reference a valid state id`);
  }

  // Per-state validation
  for (const state of data.states) {
    const prefix = `State "${state.name}" (${state.id})`;

    // Duplicate view names
    const viewNames = state.views.map((v) => v.name);
    const dupViews = viewNames.filter((n, i) => viewNames.indexOf(n) !== i);
    if (dupViews.length > 0) {
      errors.push(`${prefix}: duplicate view names: ${dupViews.join(", ")}`);
    }

    // Duplicate action names
    const actionNames = state.actions.map((a) => a.name);
    const dupActions = actionNames.filter((n, i) => actionNames.indexOf(n) !== i);
    if (dupActions.length > 0) {
      errors.push(`${prefix}: duplicate action names: ${dupActions.join(", ")}`);
    }

    // Signature views must match actual views
    const viewNameSet = new Set(viewNames);
    for (const sigView of state.signature.views) {
      if (!viewNameSet.has(sigView)) {
        errors.push(`${prefix}: signature references view "${sigView}" not found in views[]`);
      }
    }

    // Signature actions must match actual actions
    const actionNameSet = new Set(actionNames);
    for (const sigAction of state.signature.actions) {
      if (!actionNameSet.has(sigAction)) {
        errors.push(`${prefix}: signature references action "${sigAction}" not found in actions[]`);
      }
    }

    // to_state must reference valid state ids
    for (const action of state.actions) {
      if (!stateIds.has(action.to_state)) {
        errors.push(`${prefix}: action "${action.name}" to_state "${action.to_state}" is not a valid state id`);
      }
    }

    // Views must have non-empty code
    for (const view of state.views) {
      if (!view.code || view.code.trim().length === 0) {
        errors.push(`${prefix}: view "${view.name}" has empty code`);
      }
    }

    // Actions must have non-empty code
    for (const action of state.actions) {
      if (!action.code || action.code.trim().length === 0) {
        errors.push(`${prefix}: action "${action.name}" has empty code`);
      }
    }
  }

  // Workflow validation
  const stateNameSet = new Set(data.states.map((s) => s.name));
  const stateByName = new Map(data.states.map((s) => [s.name, s]));
  const workflowNames = new Set();

  for (const workflow of data.workflows || []) {
    if (workflowNames.has(workflow.name)) {
      errors.push(`Duplicate workflow name: "${workflow.name}"`);
    }
    workflowNames.add(workflow.name);

    for (const step of workflow.steps) {
      if (!stateNameSet.has(step.state)) {
        errors.push(`Workflow "${workflow.name}": step references unknown state "${step.state}"`);
        continue;
      }

      if (!step.action && !step.view) {
        errors.push(`Workflow "${workflow.name}": step in state "${step.state}" must have an action or view`);
      }
      if (step.action && step.view) {
        errors.push(`Workflow "${workflow.name}": step in state "${step.state}" must have action or view, not both`);
      }

      const state = stateByName.get(step.state);
      if (step.action && state) {
        if (!state.actions.some((a) => a.name === step.action)) {
          errors.push(`Workflow "${workflow.name}": unknown action "${step.action}" in state "${step.state}"`);
        }
      }
      if (step.view && state) {
        if (!state.views.some((v) => v.name === step.view)) {
          errors.push(`Workflow "${workflow.name}": unknown view "${step.view}" in state "${step.state}"`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, manifest: data };
}
