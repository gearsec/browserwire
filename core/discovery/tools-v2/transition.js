/**
 * transition.js — Transition event ref resolution.
 *
 * Takes pre-computed interaction events (from segmentation) and resolves
 * rrweb node IDs to accessibility tree ref IDs using the loaded SnapshotIndex.
 *
 * The event SELECTION (which events belong to which transition) is fixed
 * during segmentation in segment.js. This module only adds ref mappings
 * needed by the transition agent.
 */

import { z } from "zod";
import { inferFieldType } from "./field-type.js";

/**
 * Resolve rrweb node IDs to accessibility tree refs on pre-computed
 * interaction events. Enriches Input events with field_type.
 *
 * @param {Array} interactionEvents — pre-computed from buildTransitions()
 * @param {import('../snapshot/snapshot-index.js').SnapshotIndex} index — snapshot index for ref mapping
 * @returns {Array} interaction events with refs resolved
 */
export function resolveTransitionRefs(interactionEvents, index) {
  return interactionEvents.map((event) => {
    const ref = index.rrwebIdToRef?.get(event.rrwebNodeId) || null;

    if (event.type === "mouse_interaction") {
      return {
        type: event.type,
        interaction: event.interaction,
        rrweb_node_id: event.rrwebNodeId,
        ref,
        timestamp: event.timestamp,
      };
    } else if (event.type === "input") {
      const field_type = ref ? inferFieldType(index, ref) : null;
      return {
        type: event.type,
        text: event.text,
        is_checked: event.isChecked ?? null,
        rrweb_node_id: event.rrwebNodeId,
        ref,
        field_type,
        timestamp: event.timestamp,
      };
    }

    return { ...event, ref };
  });
}

export const get_transition_events = {
  name: "get_transition_events",
  description:
    "Get the user interaction events between this snapshot and the next snapshot. " +
    "These are the actions the user performed to leave this state: clicks, form inputs, etc. " +
    "Each event includes the target element's ref ID so you can inspect it with inspect_element. " +
    "Returns empty for the last snapshot (terminal state — no forward transition).",
  parameters: z.object({}),
  execute: (ctx) => {
    const { currentSnapshotIndex, snapshots, index, transitionData } = ctx;

    if (currentSnapshotIndex >= snapshots.length - 1) {
      return { events: [], terminal: true };
    }

    if (transitionData?.interactionEvents) {
      return {
        events: resolveTransitionRefs(transitionData.interactionEvents, index),
        terminal: false,
      };
    }

    return { events: [], terminal: false };
  },
};
