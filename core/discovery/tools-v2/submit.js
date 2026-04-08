/**
 * submit.js — Incremental submission tools.
 *
 * The agent submits views and actions individually as it discovers them.
 * State identity is determined by the classifier before the agent runs.
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
  returnDirect: true,
  description:
    "Signal that you have finished processing this snapshot. " +
    "Call this after you have submitted all views/actions. " +
    "CRITICAL: You MUST call this tool to complete your task.",
  parameters: z.object({}),
  execute: (ctx) => {
    ctx._done = true;
    return { valid: true };
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

    if (ctx._pendingViews.some((v) => v.name === view.name)) {
      return { error: `View "${view.name}" already submitted` };
    }

    if (!view.code || view.code.trim().length === 0) {
      return { error: `View "${view.name}" has empty code` };
    }

    // Tag with snapshot index so assembler can resolve which state this belongs to
    view._snapshotIndex = ctx.currentSnapshotIndex;
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
    if (!action.code || action.code.trim().length === 0) {
      return { error: `Action "${action.name}" has empty code` };
    }

    // Reject [href="..."] selectors — they break at runtime
    const HREF_SELECTOR_RE = /\[href[\s]*[~|^$*]?=/i;
    if (HREF_SELECTOR_RE.test(action.code)) {
      return { error: `Action "${action.name}" contains [href="..."] selector which breaks at runtime. Use page.getByRole('link', { name: '...' }) or page.locator('a', { hasText: '...' })` };
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

    // Tag with snapshot index so assembler can resolve which state this belongs to
    action._snapshotIndex = ctx.currentSnapshotIndex;
    ctx._pendingActions.push(action);
    return { submitted: true, action_count: ctx._pendingActions.length };
  },
};
