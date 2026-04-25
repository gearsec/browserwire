/**
 * convert-events.js — Convert raw rrweb events to transition interaction events.
 *
 * Takes raw rrweb events captured during a manual user action and extracts
 * the interaction events (mouse interactions + input changes) in the same
 * format that segment.js produces for the discovery pipeline.
 *
 * The output can be passed directly to runAgent() as transitionEvents
 * (after resolveTransitionRefs in the SnapshotIndex context).
 */

import { EventType, IncrementalSource, MouseInteraction } from "../recording/rrweb-constants.js";

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

/**
 * Convert raw rrweb events into the interactionEvents format used by the
 * transition agent. Extracts mouse interactions and input changes.
 *
 * Output format matches segment.js extractInteractions():
 *   { eventIndex, type: "mouse_interaction"|"input", rrwebNodeId, timestamp, ... }
 *
 * @param {object[]} rrwebEvents — raw rrweb events from the browser
 * @returns {object[]} interaction events in the same shape as buildTransitions() produces
 */
export function convertRrwebToTransitionEvents(rrwebEvents) {
  const interactions = [];

  for (let i = 0; i < rrwebEvents.length; i++) {
    const event = rrwebEvents[i];
    if (event.type !== EventType.IncrementalSnapshot) continue;

    const source = event.data?.source;

    if (source === IncrementalSource.MouseInteraction) {
      interactions.push({
        eventIndex: i,
        type: "mouse_interaction",
        interaction: MOUSE_INTERACTION_NAMES[event.data.type] || `unknown(${event.data.type})`,
        rrwebNodeId: event.data.id,
        timestamp: event.timestamp,
      });
    } else if (source === IncrementalSource.Input) {
      interactions.push({
        eventIndex: i,
        type: "input",
        text: event.data.text || null,
        isChecked: event.data.isChecked ?? null,
        rrwebNodeId: event.data.id,
        timestamp: event.timestamp,
      });
    }
  }

  return interactions;
}
