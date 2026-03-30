/**
 * transition.js — Transition understanding tool.
 *
 * Returns the rrweb interaction events between the current snapshot and
 * the next snapshot — the user actions that caused the transition OUT
 * of this state. Events are filtered to MouseInteraction and Input only,
 * and mapped to element ref IDs via the rrweb mirror.
 *
 * For the last snapshot (terminal state), returns an empty array.
 */

import { z } from "zod";
import { EventType, IncrementalSource, MouseInteraction } from "../../recording/rrweb-constants.js";

const MOUSE_INTERACTION_NAMES = {
  [MouseInteraction.MouseUp]: "mouseup",
  [MouseInteraction.MouseDown]: "mousedown",
  [MouseInteraction.Click]: "click",
  [MouseInteraction.ContextMenu]: "contextmenu",
  [MouseInteraction.DblClick]: "dblclick",
  [MouseInteraction.Focus]: "focus",
  [MouseInteraction.Blur]: "blur",
  [MouseInteraction.TouchStart]: "touchstart",
  [MouseInteraction.TouchEnd]: "touchend",
};

export const get_transition_events = {
  name: "get_transition_events",
  description:
    "Get the user interaction events between this snapshot and the next snapshot. " +
    "These are the actions the user performed to leave this state: clicks, form inputs, etc. " +
    "Each event includes the target element's ref ID so you can inspect it with inspect_element. " +
    "Returns empty for the last snapshot (terminal state — no forward transition).",
  parameters: z.object({}),
  execute: (ctx) => {
    const { events, currentSnapshotIndex, snapshots, index } = ctx;

    // Terminal state — no forward transition
    if (currentSnapshotIndex >= snapshots.length - 1) {
      return { events: [], terminal: true };
    }

    const currentSnapshot = snapshots[currentSnapshotIndex];
    const nextSnapshot = snapshots[currentSnapshotIndex + 1];

    // Slice events between current and next snapshot
    const startIdx = currentSnapshot.eventIndex + 1;
    const endIdx = nextSnapshot.eventIndex;
    const transitionSlice = events.slice(startIdx, endIdx);

    // Filter to interaction events and map to ref IDs
    const interactions = [];
    for (const event of transitionSlice) {
      if (event.type !== EventType.IncrementalSnapshot) continue;
      const source = event.data?.source;

      if (source === IncrementalSource.MouseInteraction) {
        const nodeId = event.data.id;
        const ref = index.rrwebIdToRef?.get(nodeId) || null;
        interactions.push({
          type: "mouse_interaction",
          interaction: MOUSE_INTERACTION_NAMES[event.data.type] || `unknown(${event.data.type})`,
          rrweb_node_id: nodeId,
          ref,
          timestamp: event.timestamp,
        });
      } else if (source === IncrementalSource.Input) {
        const nodeId = event.data.id;
        const ref = index.rrwebIdToRef?.get(nodeId) || null;
        interactions.push({
          type: "input",
          text: event.data.text || null,
          is_checked: event.data.isChecked ?? null,
          rrweb_node_id: nodeId,
          ref,
          timestamp: event.timestamp,
        });
      }
    }

    return { events: interactions, terminal: false };
  },
};
