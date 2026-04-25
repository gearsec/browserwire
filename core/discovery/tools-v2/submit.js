/**
 * submit.js — Agent submission tools.
 *
 * - done: Signal completion. In transition mode, returns tested code + inputs.
 * - submit_view: Submit a single view (view mode only).
 *
 * Actions are built by the orchestrator from transition agent output —
 * no submit_action tool exists.
 */

import { z } from "zod";
import {
  viewSchema,
  actionInputSchema,
} from "../../manifest/schema.js";

// ---------------------------------------------------------------------------
// done — signal agent completion
// ---------------------------------------------------------------------------

export const done = {
  name: "done",
  returnDirect: true,
  description:
    "Signal that you have finished. " +
    "In transition mode, code is normally taken from your last successful test_code call. " +
    "If test_code is not available (healing without recording), pass code directly. " +
    "CRITICAL: You MUST call this tool to complete your task.",
  parameters: z.object({
    code: z.string().optional().describe("The Playwright code. Pass this directly when test_code is not available (healing without recording). Otherwise omit — code is taken from your last test_code call."),
    inputs: z.array(actionInputSchema).optional().describe("Input parameter definitions for the action. Required in transition mode."),
    name: z.string().optional().describe("Short snake_case name for this action, e.g., fill_calendar_name, click_submit_button"),
    description: z.string().optional().describe("One-line description of what this action does"),
  }),
  execute: (ctx, { code: passedCode, inputs, name, description } = {}) => {
    ctx._done = true;
    const code = passedCode || ctx._lastTestedCode || ctx._lastAttemptedCode;
    if (code) {
      ctx._transitionCode = code;
      ctx._transitionInputs = inputs || [];
      ctx._transitionName = name || null;
      ctx._transitionDescription = description || null;
    }
    return { valid: true };
  },
};

// ---------------------------------------------------------------------------
// submit_view — submit a single view (view mode only)
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
