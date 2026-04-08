/**
 * segment.js — Heuristic trigger boundary parser for rrweb event streams.
 *
 * Walks an rrweb event stream, identifies user trigger indexes, and derives
 * snapshot boundaries. N triggers produce N+1 snapshots.
 */

import {
  EventType,
  IncrementalSource,
  MouseInteraction,
} from "./rrweb-constants.js";

const DEBOUNCE_MS = 500;

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

function isUserInput(event) {
  return (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.Input &&
    event.data.userTriggered === true
  );
}

function isScroll(event) {
  return (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.Scroll
  );
}

function isDrag(event) {
  return (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.Drag
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
 * Walk the event stream and return all user trigger indexes with their kind.
 * Debounced kinds (type, scroll, drag) collapse consecutive events within
 * 500ms into a single trigger at the first event's index.
 *
 * @param {object[]} events - Array of rrweb events
 * @returns {{ index: number, kind: string }[]}
 */
function detectTriggers(events) {
  const triggers = [];

  // Track whether we have seen the initial Meta+FullSnapshot pair so we can
  // skip it (navigation triggers only fire for subsequent navigations).
  let seenInitialNavigation = false;

  // Debounce state for grouped trigger kinds.
  let debounceKind = null;
  let debounceStart = null; // timestamp of first event in current group

  function flushDebounce() {
    // Nothing to flush — groups are recorded at detection time.
    debounceKind = null;
    debounceStart = null;
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // --- Debounced kinds: type, scroll, drag ---
    // Check if this event continues an open debounce group.
    if (debounceKind !== null) {
      const withinWindow = event.timestamp - debounceStart <= DEBOUNCE_MS;
      const sameKind =
        (debounceKind === "type" && isUserInput(event)) ||
        (debounceKind === "scroll" && isScroll(event)) ||
        (debounceKind === "drag" && isDrag(event));

      if (withinWindow && sameKind) {
        // This event is absorbed into the current debounce group — skip.
        continue;
      } else {
        // Group ended; close it before processing the current event.
        flushDebounce();
      }
    }

    // --- Classify the current event ---

    if (isClick(event)) {
      triggers.push({ index: i, kind: "click" });
    } else if (isDblClick(event)) {
      triggers.push({ index: i, kind: "dblclick" });
    } else if (isContextMenu(event)) {
      triggers.push({ index: i, kind: "context-menu" });
    } else if (isTouch(event)) {
      triggers.push({ index: i, kind: "touch" });
    } else if (isUserInput(event)) {
      triggers.push({ index: i, kind: "type" });
      debounceKind = "type";
      debounceStart = event.timestamp;
    } else if (isScroll(event)) {
      triggers.push({ index: i, kind: "scroll" });
      debounceKind = "scroll";
      debounceStart = event.timestamp;
    } else if (isDrag(event)) {
      triggers.push({ index: i, kind: "drag" });
      debounceKind = "drag";
      debounceStart = event.timestamp;
    } else if (isMetaFollowedByFullSnapshot(events, i)) {
      if (!seenInitialNavigation) {
        // Skip the very first Meta+FullSnapshot pair.
        seenInitialNavigation = true;
      } else {
        triggers.push({ index: i, kind: "navigation" });
      }
    }
  }

  return triggers;
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
 * Walk an rrweb event stream and identify user trigger indexes, then derive
 * snapshot boundaries.
 *
 * @param {object[]} events - Array of rrweb events with at minimum { type, timestamp, data }
 * @returns {{ triggers: { index: number, kind: string }[], snapshots: { snapshotId: string, eventIndex: number, eventTimestamp: number, trigger: { kind: string } | null }[] }}
 */
export function segmentEvents(events) {
  if (events.length === 0) {
    return { triggers: [], snapshots: [] };
  }

  const triggers = detectTriggers(events);

  if (triggers.length === 0) {
    // No triggers: single snapshot at the last event representing initial state.
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
  return { triggers, snapshots };
}
