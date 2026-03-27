/**
 * submit.js — Incremental submission tools.
 *
 * The agent submits state, views, and actions individually as it
 * discovers them. This keeps each submission small and avoids the
 * agent needing to hold everything in context at once.
 *
 * Flow:
 *   1. submit_state — register the state (existing id OR new identity)
 *   2. submit_view — one view at a time (only for new states)
 *   3. submit_action — one action at a time
 *
 * All views and actions auto-attach to the current state.
 * The signature is derived by the orchestrator from submitted views/actions.
 * The orchestrator handles all manifest mutations after the agent finishes.
 */

import { z } from "zod";
import {
  viewSchema,
  actionSchema,
} from "../../manifest/schema.js";

// ---------------------------------------------------------------------------
// done — signal agent completion
// ---------------------------------------------------------------------------

export const done = {
  name: "done",
  description:
    "Signal that you have finished processing this snapshot. " +
    "Call this after you have submitted the state and all views/actions. " +
    "CRITICAL: You MUST call this tool to complete your task.",
  parameters: z.object({}),
  execute: (ctx) => {
    ctx._done = true;
    return { valid: true };
  },
};

// ---------------------------------------------------------------------------
// submit_state — register the state for this snapshot
// ---------------------------------------------------------------------------

const newStateSchema = z.object({
  existing_state_id: z.undefined().optional(),
  name: z.string().describe("snake_case semantic state name, e.g. product_list"),
  description: z.string().describe("What this state represents"),
  url_pattern: z.string().describe("URL pattern at this state, e.g. /products/:id"),
  page_purpose: z.string().describe("Short purpose for dedup, e.g. 'browse products'"),
  domain: z.string().optional().describe("Site domain, e.g. ecommerce (first snapshot only)"),
  domainDescription: z.string().optional().describe("1-2 sentences about the site (first snapshot only)"),
});

const existingStateSchema = z.object({
  existing_state_id: z.string().describe("The id of the existing state, e.g. 's2'"),
});

const submitStateParams = z.union([newStateSchema, existingStateSchema]);

export const submit_state = {
  name: "submit_state",
  description:
    "Register the state for this snapshot. Two cases:\n" +
    "- Existing state: pass { existing_state_id: 's2' } if you recognized it from get_state_machine.\n" +
    "- New state: pass { name, description, url_pattern, page_purpose, domain?, domainDescription? }.\n" +
    "For existing states, skip view discovery (views already in manifest). " +
    "For new states, proceed to submit_view and submit_action.",
  parameters: z.object({
    state: submitStateParams,
  }),
  execute: (ctx, { state }) => {
    if (state.existing_state_id) {
      // Existing state
      const existingState = ctx.manifest?.getState(state.existing_state_id);
      if (!existingState) {
        return { error: `State "${state.existing_state_id}" not found in manifest` };
      }

      ctx._currentStateId = state.existing_state_id;
      ctx._isExistingState = true;
      ctx._pendingState = null;
      ctx._pendingViews = [];
      ctx._pendingActions = [];

      return { submitted: true, state_id: state.existing_state_id };
    }

    // New state
    if (state.domain && ctx.manifest && !ctx.manifest.domain) {
      ctx.manifest.domain = state.domain;
      ctx.manifest.domainDescription = state.domainDescription || null;
    }

    ctx._currentStateId = null;
    ctx._isExistingState = false;
    ctx._pendingState = {
      name: state.name,
      description: state.description,
      url_pattern: state.url_pattern,
      page_purpose: state.page_purpose,
    };
    ctx._pendingViews = [];
    ctx._pendingActions = [];

    return { submitted: true };
  },
};

// ---------------------------------------------------------------------------
// submit_view — submit a single view (only for new states)
// ---------------------------------------------------------------------------

export const submit_view = {
  name: "submit_view",
  description:
    "Submit a single view for the current state with its Playwright extraction code. " +
    "Only for NEW states — for existing states, views are already discovered. " +
    "Call once per view. The view auto-attaches to the current state.",
  parameters: z.object({
    view: viewSchema,
  }),
  execute: (ctx, { view }) => {
    if (ctx._isExistingState) {
      return { error: "Cannot submit views for an existing state — views are already discovered" };
    }

    if (!ctx._pendingState) {
      return { error: "Call submit_state first before submitting views" };
    }

    if (ctx._pendingViews.some((v) => v.name === view.name)) {
      return { error: `View "${view.name}" already submitted` };
    }

    if (!view.code || view.code.trim().length === 0) {
      return { error: `View "${view.name}" has empty code` };
    }

    ctx._pendingViews.push(view);
    return { submitted: true, view_count: ctx._pendingViews.length };
  },
};

// ---------------------------------------------------------------------------
// submit_action — submit a single action
// ---------------------------------------------------------------------------

export const submit_action = {
  name: "submit_action",
  description:
    "Submit a single action for the current state with its Playwright interaction code. " +
    "For existing states, only submit NEW actions not already on the state. " +
    "Call once per action. The action auto-attaches to the current state.",
  parameters: z.object({
    action: actionSchema,
  }),
  execute: (ctx, { action }) => {
    if (!ctx._pendingState && !ctx._isExistingState) {
      return { error: "Call submit_state first before submitting actions" };
    }

    if (!action.code || action.code.trim().length === 0) {
      return { error: `Action "${action.name}" has empty code` };
    }

    // For existing states, check if action already exists
    if (ctx._isExistingState && ctx._currentStateId) {
      const existingState = ctx.manifest?.getState(ctx._currentStateId);
      if (existingState?.actions.some((a) => a.name === action.name)) {
        return { error: `Action "${action.name}" already exists on this state` };
      }
    }

    // Check for duplicate in pending
    if (ctx._pendingActions.some((a) => a.name === action.name)) {
      return { error: `Action "${action.name}" already submitted` };
    }

    ctx._pendingActions.push(action);
    return { submitted: true, action_count: ctx._pendingActions.length };
  },
};
