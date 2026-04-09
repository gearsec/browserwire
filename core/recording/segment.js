/**
 * segment.js — Trigger boundary parser for rrweb event streams.
 *
 * Only user-initiated actions create triggers: Click, DblClick, Touch,
 * ContextMenu, Navigation. Input/Scroll/Drag events are NOT triggers —
 * they're captured as transition events between snapshots.
 *
 * N triggers produce N+1 snapshots. Each snapshot boundary is placed
 * one event before the trigger (so the snapshot DOM is the state right
 * before the user acted).
 */

import {
  EventType,
  IncrementalSource,
  MouseInteraction,
} from "./rrweb-constants.js";

// ---------------------------------------------------------------------------
// Trigger detection helpers
// ---------------------------------------------------------------------------

function isClick(event) {
  return (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.MouseInteraction &&
    event.data.type === MouseInteraction.Click
  );
}

function isDblClick(event) {
  return (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.MouseInteraction &&
    event.data.type === MouseInteraction.DblClick
  );
}

function isContextMenu(event) {
  return (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.MouseInteraction &&
    event.data.type === MouseInteraction.ContextMenu
  );
}

function isTouch(event) {
  return (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.MouseInteraction &&
    (event.data.type === MouseInteraction.TouchStart ||
      event.data.type === MouseInteraction.TouchEnd)
  );
}

function isFocus(event) {
  return (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.MouseInteraction &&
    event.data.type === MouseInteraction.Focus
  );
}

function isMetaFollowedByFullSnapshot(events, index) {
  return (
    events[index].type === EventType.Meta &&
    index + 1 < events.length &&
    events[index + 1].type === EventType.FullSnapshot
  );
}

// ---------------------------------------------------------------------------
// Main segmentation logic
// ---------------------------------------------------------------------------

/**
 * Walk the event stream and return user action trigger indexes.
 *
 * Triggers: Click, DblClick, Touch, ContextMenu, Navigation,
 * and first Input on a new element (detects typing in auto-focused fields).
 *
 * @param {object[]} events - Array of rrweb events
 * @returns {{ index: number, kind: string }[]}
 */
function detectTriggers(events) {
  const triggers = [];
  let seenInitialNavigation = false;
  let lastInteractionNodeId = null;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (isClick(event)) {
      triggers.push({ index: i, kind: "click" });
      lastInteractionNodeId = event.data.id;
    } else if (isDblClick(event)) {
      triggers.push({ index: i, kind: "dblclick" });
      lastInteractionNodeId = event.data.id;
    } else if (isContextMenu(event)) {
      triggers.push({ index: i, kind: "context-menu" });
      lastInteractionNodeId = event.data.id;
    } else if (isTouch(event)) {
      triggers.push({ index: i, kind: "touch" });
      lastInteractionNodeId = event.data.id;
    } else if (isInputOnNewElement(event, lastInteractionNodeId)) {
      // First Input on a different element than the last click/input target.
      // Detects typing in auto-focused or tab-focused fields.
      triggers.push({ index: i, kind: "type" });
      lastInteractionNodeId = event.data.id;
    } else if (isMetaFollowedByFullSnapshot(events, i)) {
      if (!seenInitialNavigation) {
        seenInitialNavigation = true;
      } else {
        triggers.push({ index: i, kind: "navigation" });
      }
    }
  }

  return triggers;
}

function isInputOnNewElement(event, lastInteractionNodeId) {
  if (event.type !== EventType.IncrementalSnapshot) return false;
  if (event.data.source !== IncrementalSource.Input) return false;
  const nodeId = event.data.id;
  if (!nodeId || nodeId <= 0) return false; // skip React init noise (node=-1)
  return nodeId !== lastInteractionNodeId;
}

/**
 * Derive snapshot boundaries from a list of triggers and the event stream.
 *
 * @param {object[]} events - Array of rrweb events
 * @param {{ index: number, kind: string }[]} triggers
 * @returns {{ snapshotId: string, eventIndex: number, trigger: { kind: string } | null }[]}
 */
function deriveSnapshots(events, triggers) {
  if (events.length === 0) return [];

  // Build boundary event indexes: each snapshot sits at the event right
  // before the next trigger. The last snapshot sits at the end of stream.
  const boundaryIndexes = triggers.map((t) => Math.max(0, t.index - 1));
  boundaryIndexes.push(events.length - 1);

  return boundaryIndexes.map((eventIndex, i) => ({
    snapshotId: `snap_${i}`,
    eventIndex,
    trigger: i === 0 ? null : { kind: triggers[i - 1].kind },
  }));
}

/**
 * Walk an rrweb event stream and identify user action triggers, then derive
 * snapshot boundaries.
 *
 * @param {object[]} events - Array of rrweb events with at minimum { type, timestamp, data }
 * @returns {{ triggers: { index: number, kind: string }[], snapshots: { snapshotId: string, eventIndex: number, trigger: { kind: string } | null }[] }}
 */
export function segmentEvents(events) {
  if (events.length === 0) {
    return { triggers: [], snapshots: [] };
  }

  const triggers = detectTriggers(events);

  if (triggers.length === 0) {
    return {
      triggers: [],
      snapshots: [
        {
          snapshotId: "snap_0",
          eventIndex: events.length - 1,
          trigger: null,
        },
      ],
    };
  }

  const snapshots = deriveSnapshots(events, triggers);
  const transitions = buildTransitions(events, snapshots);
  return { triggers, snapshots, transitions };
}

// ---------------------------------------------------------------------------
// Transition extraction
// ---------------------------------------------------------------------------

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
 * Build transitions between consecutive snapshots.
 * Each transition has the event range and extracted interaction events
 * (MouseInteraction + Input only, with raw rrweb node IDs).
 *
 * This is the single source of truth — persisted to segmentation.json
 * and reused by transition agents and the UI.
 *
 * @param {object[]} events - Full rrweb event stream
 * @param {object[]} snapshots - Snapshot boundaries from deriveSnapshots
 * @returns {object[]} transitions
 */
export function buildTransitions(events, snapshots) {
  const transitions = [];
  for (let i = 0; i < snapshots.length - 1; i++) {
    const startIdx = snapshots[i].eventIndex + 1;
    const endIdx = snapshots[i + 1].eventIndex;
    const interactionEvents = extractInteractions(events, startIdx, endIdx);

    transitions.push({
      from: snapshots[i].snapshotId,
      to: snapshots[i + 1].snapshotId,
      snapshotIndex: i,
      eventRange: { start: startIdx, end: endIdx },
      triggerKind: snapshots[i + 1].trigger?.kind || null,
      interactionEvents,
    });
  }
  return transitions;
}

function extractInteractions(events, startIdx, endIdx) {
  const interactions = [];
  for (let j = startIdx; j < endIdx; j++) {
    const event = events[j];
    if (event.type !== EventType.IncrementalSnapshot) continue;
    const source = event.data?.source;

    if (source === IncrementalSource.MouseInteraction) {
      interactions.push({
        eventIndex: j,
        type: "mouse_interaction",
        interaction: MOUSE_INTERACTION_NAMES[event.data.type] || `unknown(${event.data.type})`,
        rrwebNodeId: event.data.id,
        timestamp: event.timestamp,
      });
    } else if (source === IncrementalSource.Input) {
      interactions.push({
        eventIndex: j,
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
