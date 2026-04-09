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

function touch() {
  return { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.TouchStart, id: 10 }, timestamp: ts() };
}

function focus() {
  return { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.Focus, id: 10 }, timestamp: ts() };
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
    expect(snapshots[0].eventIndex).toBe(1);
    expect(snapshots[0].trigger).toBeNull();
    expect(snapshots[1].eventIndex).toBe(4);
    expect(snapshots[1].trigger).toEqual({ kind: "click" });
  });

  it("click then more clicks → multiple triggers", () => {
    const events = [meta(), fullSnapshot(), click(), mutation(), click(), mutation()];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(2);
    expect(triggers[0].kind).toBe("click");
    expect(triggers[1].kind).toBe("click");
    expect(snapshots).toHaveLength(3);
  });

  it("no-op click (no mutations after) → 1 trigger, 2 snapshots", () => {
    const events = [meta(), fullSnapshot(), click()];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(1);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].eventIndex).toBe(1);
    expect(snapshots[1].eventIndex).toBe(2);
  });

  it("back-to-back clicks → 2 triggers, 3 snapshots", () => {
    const events = [meta(), fullSnapshot(), click(), click(), mutation()];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(2);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].eventIndex).toBe(1);
    expect(snapshots[1].eventIndex).toBe(2);
    expect(snapshots[2].eventIndex).toBe(4);
  });

  it("input on new element (no preceding click) IS a trigger", () => {
    const events = [meta(), fullSnapshot(), userInput("h"), userInput("e"), mutation()];
    const { triggers } = segmentEvents(events);

    // First input on id=20 (no preceding click) → trigger
    // Second input on same id=20 → NOT a trigger
    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("type");
  });

  it("subsequent inputs on same element are NOT triggers", () => {
    const events = [meta(), fullSnapshot(), userInput("h"), userInput("he"), userInput("hel")];
    const { triggers } = segmentEvents(events);

    expect(triggers).toHaveLength(1); // only the first
  });

  it("programmatic input on new element IS a trigger (same as user input)", () => {
    const events = [meta(), fullSnapshot(), programmaticInput("auto")];
    const { triggers } = segmentEvents(events);

    // id=20 differs from any preceding interaction → trigger
    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("type");
  });

  it("scroll events are NOT triggers", () => {
    const events = [meta(), fullSnapshot(), scroll(), scroll(), mutation()];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(0);
    expect(snapshots).toHaveLength(1);
  });

  it("drag events are NOT triggers", () => {
    const events = [meta(), fullSnapshot(), drag(), drag(), mutation()];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(0);
    expect(snapshots).toHaveLength(1);
  });

  it("Focus alone is NOT a trigger", () => {
    const events = [meta(), fullSnapshot(), click(), focus(), mutation()];
    const { triggers, snapshots } = segmentEvents(events);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("click");
  });

  it("Input on a new element (auto-focused field) IS a trigger", () => {
    // Click on button (id=10), then input on a different element (id=20)
    const events = [meta(), fullSnapshot(), click(), userInput("h"), mutation()];
    const { triggers } = segmentEvents(events);

    // click (id=10) + input on new element (id=20) = 2 triggers
    expect(triggers).toHaveLength(2);
    expect(triggers[0].kind).toBe("click");
    expect(triggers[1].kind).toBe("type");
  });

  it("Input on same element as click is NOT a trigger", () => {
    // Click and input both on id=10 (click helper uses id=10, need custom input)
    const clickEvt = { type: 3, data: { source: 2, type: 2, id: 10, x: 100, y: 200 }, timestamp: 1200 };
    const inputEvt = { type: 3, data: { source: 5, id: 10, text: "h", isChecked: false }, timestamp: 1300 };
    const events = [meta(), fullSnapshot(), clickEvt, inputEvt];
    const { triggers } = segmentEvents(events);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("click");
  });

  it("click then input on different element then click → 3 triggers", () => {
    const events = [meta(), fullSnapshot(), click(), userInput("h"), userInput("e"), click(), mutation()];
    const { triggers } = segmentEvents(events);

    // click (id=10) + input on new element (id=20) + click (id=10) = 3 triggers
    expect(triggers).toHaveLength(3);
    expect(triggers[0].kind).toBe("click");
    expect(triggers[1].kind).toBe("type");
    expect(triggers[2].kind).toBe("click");
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

  it("dblclick is its own trigger kind", () => {
    const events = [meta(), fullSnapshot(), dblClick(), mutation()];
    const { triggers } = segmentEvents(events);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("dblclick");
  });

  it("touch is a trigger", () => {
    const events = [meta(), fullSnapshot(), touch(), mutation()];
    const { triggers } = segmentEvents(events);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("touch");
  });

  it("snapshot has no eventTimestamp (use eventIndex)", () => {
    const events = [meta(), fullSnapshot(), click(), mutation()];
    const { snapshots } = segmentEvents(events);

    for (const snap of snapshots) {
      expect(snap).not.toHaveProperty("eventTimestamp");
    }
  });

  it("first snapshot eventIndex is clamped to 0 when T1=0", () => {
    const events = [click(), mutation()];
    const { snapshots } = segmentEvents(events);

    expect(snapshots[0].eventIndex).toBe(0);
    expect(snapshots[0].eventIndex).toBeGreaterThanOrEqual(0);
  });
});
