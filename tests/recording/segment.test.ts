import { describe, it, expect, beforeEach } from "vitest";
import { segmentEvents } from "../../core/recording/segment.js";

// ---------------------------------------------------------------------------
// Helpers to build synthetic rrweb events
// ---------------------------------------------------------------------------

const EventType = { DomContentLoaded: 0, Load: 1, FullSnapshot: 2, IncrementalSnapshot: 3, Meta: 4 };
const IncrementalSource = { Mutation: 0, MouseInteraction: 2, Scroll: 3, Input: 5, Drag: 12 };
const MouseInteractions = { Click: 2, DblClick: 4, ContextMenu: 3, Focus: 5, Blur: 6, TouchStart: 7, TouchEnd: 9 };

let _ts = 1000;
function ts(offset = 100) {
  _ts += offset;
  return _ts;
}
function resetTs() {
  _ts = 1000;
}

function meta() {
  return { type: EventType.Meta, data: { href: "http://test.com", width: 1024, height: 768 }, timestamp: ts() };
}

function fullSnapshot() {
  return { type: EventType.FullSnapshot, data: { node: { id: 1, type: 0 }, initialOffset: { top: 0, left: 0 } }, timestamp: ts() };
}

function click() {
  return { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.Click, id: 10, x: 100, y: 200 }, timestamp: ts() };
}

function dblClick() {
  return { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.DblClick, id: 10, x: 100, y: 200 }, timestamp: ts() };
}

function focus() {
  return { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.Focus, id: 10 }, timestamp: ts() };
}

function blur() {
  return { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.Blur, id: 10 }, timestamp: ts() };
}

function mutation() {
  return { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.Mutation, texts: [], attributes: [], removes: [], adds: [] }, timestamp: ts() };
}

function userInput(text = "a") {
  return { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.Input, id: 20, text, isChecked: false, userTriggered: true }, timestamp: ts(50) };
}

function programmaticInput(text = "auto") {
  return { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.Input, id: 20, text, isChecked: false, userTriggered: false }, timestamp: ts() };
}

function scroll(offset = 50) {
  return { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.Scroll, id: 1, x: 0, y: 100 }, timestamp: ts(offset) };
}

function drag(offset = 50) {
  return { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.Drag, positions: [] }, timestamp: ts(offset) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("segmentEvents", () => {
  beforeEach(() => resetTs());

  it("single click → 1 trigger, 2 snapshots", () => {
    const events = [meta(), fullSnapshot(), click(), mutation(), mutation()];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("click");
    expect(triggers[0].index).toBe(2);

    expect(snapshots).toHaveLength(2);
    // First snapshot: initial state (event before first trigger)
    expect(snapshots[0].eventIndex).toBe(1);
    expect(snapshots[0].trigger).toBeNull();
    // Second snapshot: end of stream (after click)
    expect(snapshots[1].eventIndex).toBe(4);
    expect(snapshots[1].trigger).toEqual({ kind: "click" });
  });

  it("click then type → 2 triggers, 3 snapshots", () => {
    const events = [meta(), fullSnapshot(), click(), mutation(), userInput("h"), mutation()];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(2);
    expect(triggers[0].kind).toBe("click");
    expect(triggers[1].kind).toBe("type");

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].trigger).toBeNull(); // initial
    expect(snapshots[1].trigger).toEqual({ kind: "click" }); // after click
    expect(snapshots[2].trigger).toEqual({ kind: "type" }); // after type
  });

  it("no-op click (no mutations after) → 1 trigger, 2 snapshots", () => {
    const events = [meta(), fullSnapshot(), click()];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(1);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].eventIndex).toBe(1); // before click
    expect(snapshots[1].eventIndex).toBe(2); // click itself (end of stream)
  });

  it("back-to-back clicks → 2 triggers, 3 snapshots", () => {
    const events = [meta(), fullSnapshot(), click(), click(), mutation()];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(2);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].eventIndex).toBe(1); // before first click
    expect(snapshots[1].eventIndex).toBe(2); // before second click (= first click itself)
    expect(snapshots[2].eventIndex).toBe(4); // end of stream
  });

  it("programmatic input is NOT a trigger", () => {
    const events = [meta(), fullSnapshot(), programmaticInput("auto")];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(0);
    // No triggers → single snapshot at end
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].trigger).toBeNull();
  });

  it("Focus and Blur are suppressed (not triggers)", () => {
    const events = [meta(), fullSnapshot(), click(), focus(), mutation()];
    const { triggers, snapshots } = segmentEvents(events);

    // Only click should be a trigger, not focus
    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("click");
    expect(snapshots).toHaveLength(2);
  });

  it("consecutive scroll events within 500ms → 1 trigger (debounced)", () => {
    const events = [
      meta(),
      fullSnapshot(),
      scroll(50),  // +50ms
      scroll(50),  // +50ms (within 500ms of first)
      scroll(50),  // +50ms (within 500ms of first)
      mutation(),
    ];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("scroll");
    expect(snapshots).toHaveLength(2);
  });

  it("navigation (Meta+FullSnapshot pair after initial) → 1 trigger", () => {
    const events = [
      meta(), fullSnapshot(), // initial — not a trigger
      mutation(),
      meta(), fullSnapshot(), // navigation — IS a trigger
      mutation(),
    ];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("navigation");
    expect(snapshots).toHaveLength(2);
  });

  it("empty event stream → empty result", () => {
    const { triggers, snapshots } = segmentEvents([]);
    expect(triggers).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });

  it("scroll events beyond 500ms gap → 2 separate triggers", () => {
    const events = [
      meta(),
      fullSnapshot(),
      scroll(50),
      scroll(600),  // >500ms gap from first scroll
      mutation(),
    ];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(2);
    expect(triggers[0].kind).toBe("scroll");
    expect(triggers[1].kind).toBe("scroll");
    expect(snapshots).toHaveLength(3);
  });

  it("consecutive userInput within 500ms → 1 type trigger", () => {
    const events = [
      meta(),
      fullSnapshot(),
      userInput("h"),  // +50ms
      userInput("e"),  // +50ms
      userInput("l"),  // +50ms
      mutation(),
    ];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("type");
    expect(snapshots).toHaveLength(2);
  });

  it("dblclick is its own trigger kind", () => {
    const events = [meta(), fullSnapshot(), dblClick(), mutation()];
    const { triggers } = segmentEvents(events);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("dblclick");
  });

  it("drag events within 500ms → 1 drag trigger", () => {
    const events = [
      meta(),
      fullSnapshot(),
      drag(50),
      drag(50),
      drag(50),
      mutation(),
    ];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("drag");
    expect(snapshots).toHaveLength(2);
  });

  it("snapshot has no eventTimestamp (removed — use eventIndex)", () => {
    const events = [meta(), fullSnapshot(), click(), mutation()];
    const { snapshots } = segmentEvents(events);

    for (const snap of snapshots) {
      expect(snap).not.toHaveProperty("eventTimestamp");
    }
  });

  it("first snapshot eventIndex is clamped to 0 when T1=0", () => {
    // Edge case: if the first trigger IS event 0 (unlikely but possible),
    // the initial snapshot should be at index 0 (clamped, not -1)
    const events = [click(), mutation()];
    const { snapshots } = segmentEvents(events);

    expect(snapshots[0].eventIndex).toBe(0);
    expect(snapshots[0].eventIndex).toBeGreaterThanOrEqual(0);
  });
});
