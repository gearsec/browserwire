/**
 * context.js — State machine context tool.
 *
 * Returns the accumulated state machine summary so the agent can
 * determine if the current snapshot is a new state or a revisit.
 * Omits code to keep context compact.
 */

import { z } from "zod";

export const get_state_machine = {
  name: "get_state_machine",
  description:
    "Get the state machine built so far from previous snapshots. " +
    "Shows all states with their signatures (page_purpose, view names, action names), " +
    "and action leads_to links. Use this to determine if the current snapshot " +
    "is a state you've already seen or a new one.",
  parameters: z.object({}),
  execute: (ctx) => {
    const { manifest } = ctx;

    if (!manifest) {
      return { states: [], initial_state: null };
    }

    return manifest.toSummary();
  },
};
